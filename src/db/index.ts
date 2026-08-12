import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

/**
 * Pool/Drizzle client được tạo LAZY (chỉ khi thật sự dùng ở runtime), không phải lúc module
 * được import. Next.js "Collecting page data" khi build sẽ import mọi route.ts để đọc config
 * tĩnh (`runtime`/`dynamic`/...) — nếu tạo Pool/kiểm tra DATABASE_URL ngay ở module scope thì
 * bất kỳ route nào import "@/db" cũng làm BUILD thất bại nếu biến môi trường chưa có sẵn ở
 * bước build, kể cả khi route đó chỉ thật sự chạy (và chỉ thật sự cần DB) lúc có request.
 * Việc kiểm tra DATABASE_URL vẫn xảy ra — chỉ dời sang lần đầu có request gọi tới DB.
 *
 * `poolInstance`/`dbInstance` (biến module-scope) là nguồn sự thật DUY NHẤT cho việc cache —
 * đây mới là thứ đảm bảo "1 pool cho cả vòng đời instance serverless đang warm" (module chỉ bị
 * evaluate lại khi có cold start mới). `globalForDb` (globalThis) chỉ là lớp CHỐNG HMR của
 * `next dev` (dev server reload module nhưng globalThis thì không đổi) — không dùng làm nơi
 * cache chính, để `pool` và `db` (2 export riêng) luôn quy về đúng 1 Pool duy nhất thay vì mỗi
 * export tự tạo Pool riêng nếu NODE_ENV=production (production trước đây không ghi vào
 * globalForDb nên gọi getPool() hai lần độc lập sẽ tạo hai Pool khác nhau — connection leak).
 */
let poolInstance: Pool | undefined;

function getPool(): Pool {
  if (poolInstance) return poolInstance;

  if (process.env.NODE_ENV !== "production" && globalForDb.__arenaNextJsPostgresqlPool) {
    poolInstance = globalForDb.__arenaNextJsPostgresqlPool;
    return poolInstance;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  poolInstance = new Pool({ connectionString: databaseUrl });
  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaNextJsPostgresqlPool = poolInstance;
  }
  return poolInstance;
}

let dbInstance: ReturnType<typeof drizzle> | undefined;

function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getPool());
  }
  return dbInstance;
}

function lazy<T extends object>(factory: () => T): T {
  let instance: T | undefined;
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      if (!instance) instance = factory();
      const value = Reflect.get(instance as object, prop, instance);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

export const pool = lazy(getPool);
export const db = lazy(getDb);
