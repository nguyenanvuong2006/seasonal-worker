import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

/**
 * Pool + Drizzle client được tạo LAZY (chỉ khi thật sự dùng ở runtime), không phải lúc
 * module được import. Next.js "Collecting page data" khi build sẽ import mọi route.ts để
 * đọc config tĩnh (`runtime`/`dynamic`/...) — nếu tạo Pool/kiểm tra DATABASE_URL ngay ở module
 * scope thì bất kỳ route nào import "@/db" cũng làm BUILD thất bại nếu biến môi trường chưa
 * có sẵn ở bước build, kể cả khi route đó chỉ thật sự chạy (và chỉ thật sự cần DB) lúc có
 * request. Việc kiểm tra DATABASE_URL vẫn xảy ra — chỉ dời sang lần đầu có request gọi tới DB.
 */
function getPool(): Pool {
  if (globalForDb.__arenaNextJsPostgresqlPool) {
    return globalForDb.__arenaNextJsPostgresqlPool;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaNextJsPostgresqlPool = pool;
  }
  return pool;
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
export const db = lazy(() => drizzle(getPool()));
