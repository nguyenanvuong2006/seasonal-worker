/* ============================================================
   FAKE DRIZZLE — hạ tầng dùng chung cho unit test tầng DB
   ------------------------------------------------------------
   Các service Planning (`planning-reallocation.ts`,
   `recruitment-request.ts`) chạy thẳng trên Drizzle + Postgres.
   Để kiểm thử ĐÚNG SOURCE THẬT mà không cần database, file này
   dựng một "db" giả:

     • bảng  = Proxy, mọi truy cập cột trả về marker { __col }
     • eq/and/inArray/isNull/sql = ghi lại điều kiện dạng dữ liệu
     • db.select()/insert()/update() = chuỗi thenable ghi lại lời gọi

   Test tự quyết định mỗi truy vấn trả về gì, đồng thời soi được
   TOÀN BỘ lệnh ghi đã phát ra — đủ để khẳng định những điều như
   "không có INSERT nào vào workforce_movements".

   Đây KHÔNG phải file test (không khớp *.test.ts) nên không bị
   `npm test` chạy trực tiếp.
   ============================================================ */

export type ColMarker = { __col: string; __table: string; __prop: string };
export type TableMarker = { __table: string };

export type Cond =
  | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; col: string; prop: string; table: string; val: unknown }
  | { op: "and" | "or"; parts: unknown[] }
  | { op: "inArray" | "notInArray"; col: string; prop: string; table: string; vals: unknown[] }
  | { op: "isNull" | "isNotNull"; col: string; prop: string; table: string }
  | { op: "desc" | "asc"; inner: unknown }
  | { op: "sql"; text: string; values: unknown[] };

export type Op = { fn: string; args: unknown[] };

export type QueryCall = {
  /** select | insert | update | delete */
  root: string;
  /** tên bảng chính của truy vấn */
  table: string;
  ops: Op[];
};

export function isColMarker(v: unknown): v is ColMarker {
  return typeof v === "object" && v !== null && "__col" in (v as Record<string, unknown>);
}

/** Bảng giả: mọi truy cập cột trả về marker mang tên bảng + tên thuộc tính. */
export function makeTable(name: string): TableMarker & Record<string, ColMarker> {
  return new Proxy({} as TableMarker & Record<string, ColMarker>, {
    get(_t, prop) {
      if (prop === "__table") return name;
      if (typeof prop === "symbol") return undefined;
      return { __col: `${name}.${prop}`, __table: name, __prop: prop };
    },
    // Bảng Drizzle thật phơi cột ra thành thuộc tính riêng, nên `"col" in table`
    // là true. Proxy giả phải mô phỏng đúng điều đó, nếu không những đoạn mã
    // tra cột động (ví dụ whitelist ORDER BY) sẽ im lặng thấy bảng rỗng.
    has(_t, prop) {
      return typeof prop === "string";
    },
  });
}

function colOf(v: unknown): ColMarker {
  if (isColMarker(v)) return v;
  return { __col: "?", __table: "?", __prop: "?" };
}

/** Bộ toán tử giả thay cho "drizzle-orm". */
export const drizzleStub = {
  eq: (c: unknown, v: unknown): Cond => ({ op: "eq", ...pick(c), val: v }),
  ne: (c: unknown, v: unknown): Cond => ({ op: "ne", ...pick(c), val: v }),
  gt: (c: unknown, v: unknown): Cond => ({ op: "gt", ...pick(c), val: v }),
  gte: (c: unknown, v: unknown): Cond => ({ op: "gte", ...pick(c), val: v }),
  lt: (c: unknown, v: unknown): Cond => ({ op: "lt", ...pick(c), val: v }),
  lte: (c: unknown, v: unknown): Cond => ({ op: "lte", ...pick(c), val: v }),
  inArray: (c: unknown, vals: unknown[]): Cond => ({ op: "inArray", ...pick(c), vals }),
  notInArray: (c: unknown, vals: unknown[]): Cond => ({ op: "notInArray", ...pick(c), vals }),
  isNull: (c: unknown): Cond => ({ op: "isNull", ...pick(c) }),
  isNotNull: (c: unknown): Cond => ({ op: "isNotNull", ...pick(c) }),
  and: (...parts: unknown[]): Cond => ({ op: "and", parts: parts.filter(Boolean) }),
  or: (...parts: unknown[]): Cond => ({ op: "or", parts: parts.filter(Boolean) }),
  desc: (inner: unknown): Cond => ({ op: "desc", inner }),
  asc: (inner: unknown): Cond => ({ op: "asc", inner }),
  like: (c: unknown, v: unknown): Cond => ({ op: "eq", ...pick(c), val: v }),
  ilike: (c: unknown, v: unknown): Cond => ({ op: "eq", ...pick(c), val: v }),
  count: () => ({ op: "sql", text: "count(*)", values: [] }),
  sql: makeSqlTag(),
};

function pick(c: unknown) {
  const m = colOf(c);
  return { col: m.__col, prop: m.__prop, table: m.__table };
}

function makeSqlTag() {
  const tag = (strings: TemplateStringsArray | string[], ...values: unknown[]): Cond => ({
    op: "sql",
    text: Array.from(strings).join("?"),
    values,
  });
  // sql.raw / sql.join đôi khi được dùng — giữ chỗ để không nổ.
  (tag as unknown as { raw: (s: string) => Cond }).raw = (s: string) => ({ op: "sql", text: s, values: [] });
  (tag as unknown as { join: (a: unknown[]) => Cond }).join = (a: unknown[]) => ({
    op: "sql",
    text: "join",
    values: a,
  });
  return tag;
}

/**
 * Duyệt đệ quy mọi điều kiện đã ghi trong một truy vấn.
 *
 * Phải đi cả vào object thường, vì marker `sql` hay nằm lồng trong đối số
 * của `.select({ remaining: sql`count(*)::int` })` chứ không chỉ trong `.where()`.
 */
export function flattenConds(value: unknown, out: Cond[] = [], seen = new Set<unknown>()): Cond[] {
  if (value === null || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const v of value) flattenConds(v, out, seen);
    return out;
  }
  if (value instanceof Date) return out;

  const c = value as Cond;
  if ("op" in c) {
    out.push(c);
    if (c.op === "and" || c.op === "or") flattenConds(c.parts, out, seen);
    if (c.op === "sql") flattenConds(c.values, out, seen);
    return out;
  }

  // Object thường (payload của select/values/set) — soi tiếp các giá trị bên trong.
  for (const v of Object.values(value as Record<string, unknown>)) flattenConds(v, out, seen);
  return out;
}

/** Lấy toàn bộ điều kiện của một truy vấn (mọi đối số của mọi mắt xích). */
export function condsOf(call: QueryCall): Cond[] {
  const out: Cond[] = [];
  for (const op of call.ops) flattenConds(op.args, out);
  return out;
}

/** Tìm giá trị của điều kiện eq trên một cột cụ thể, ví dụ "planning_allocations.id". */
export function eqValue(call: QueryCall, col: string): unknown {
  for (const c of condsOf(call)) {
    if (c.op === "eq" && c.col === col) return c.val;
  }
  return undefined;
}

/** Tìm danh sách của điều kiện inArray trên một cột cụ thể. */
export function inArrayValues(call: QueryCall, col: string): unknown[] | undefined {
  for (const c of condsOf(call)) {
    if (c.op === "inArray" && c.col === col) return c.vals;
  }
  return undefined;
}

/** Toàn bộ mảnh SQL thô đã dùng trong truy vấn — để khẳng định ở mức câu lệnh. */
export function sqlTexts(call: QueryCall): string[] {
  return condsOf(call)
    .filter((c): c is Extract<Cond, { op: "sql" }> => c.op === "sql")
    .map((c) => c.text);
}

/** Đối số của một mắt xích, ví dụ argOf(call, "values") hoặc argOf(call, "set"). */
export function argOf(call: QueryCall, fn: string): unknown {
  return call.ops.find((o) => o.fn === fn)?.args[0];
}

export function hasOp(call: QueryCall, fn: string): boolean {
  return call.ops.some((o) => o.fn === fn);
}

export type FakeDbOptions = {
  /**
   * Trả về kết quả cho một truy vấn. Trả `undefined` nghĩa là "mặc định":
   * select → [], insert → [], update/delete → { rowCount: 0 }.
   */
  respond?: (call: QueryCall) => unknown;
};

export type FakeDb = {
  /** Toàn bộ truy vấn đã phát ra, theo thứ tự. */
  calls: QueryCall[];
  /** Chỉ các lệnh ghi (insert/update/delete). */
  writes: QueryCall[];
  /** Số lần transaction được mở. */
  transactions: number;
  /** Truy vấn ghi vào một bảng cụ thể. */
  writesTo(table: string): QueryCall[];
  select: (...a: unknown[]) => unknown;
  insert: (...a: unknown[]) => unknown;
  update: (...a: unknown[]) => unknown;
  delete: (...a: unknown[]) => unknown;
  execute: (...a: unknown[]) => Promise<unknown>;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

/**
 * Dựng db giả. Mỗi chuỗi truy vấn là một Proxy thenable: gọi bao nhiêu
 * mắt xích cũng được, khi `await` mới hỏi `respond()` xem trả về gì.
 */
export function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const calls: QueryCall[] = [];

  const finish = (call: QueryCall): unknown => {
    const custom = options.respond?.(call);
    if (custom !== undefined) return custom;
    if (call.root === "select" || call.root === "insert") return [];
    return { rowCount: 0 };
  };

  const makeChain = (call: QueryCall): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = finish(call);
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(value).then(res, rej);
          }
          if (typeof prop === "symbol") return undefined;
          return (...args: unknown[]) => {
            call.ops.push({ fn: prop, args });
            return makeChain(call);
          };
        },
      },
    );

  const start = (root: string) => (...args: unknown[]) => {
    // Bảng chính: đối số của insert/update/delete, hoặc của .from() với select.
    const direct = args[0] as TableMarker | undefined;
    const call: QueryCall = {
      root,
      table: root === "select" ? "" : (direct?.__table ?? ""),
      ops: [{ fn: root, args }],
    };
    calls.push(call);
    if (root === "select") {
      // Với select, tên bảng chỉ biết được khi .from() được gọi.
      const chain = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const value = finish(call);
              return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
                Promise.resolve(value).then(res, rej);
            }
            if (typeof prop === "symbol") return undefined;
            return (...a: unknown[]) => {
              call.ops.push({ fn: prop, args: a });
              if (prop === "from") call.table = (a[0] as TableMarker | undefined)?.__table ?? "";
              return makeChain(call);
            };
          },
        },
      );
      return chain;
    }
    return makeChain(call);
  };

  const db: FakeDb = {
    calls,
    get writes() {
      return calls.filter((c) => c.root !== "select");
    },
    transactions: 0,
    writesTo(table: string) {
      return calls.filter((c) => c.root !== "select" && c.table === table);
    },
    select: start("select"),
    insert: start("insert"),
    update: start("update"),
    delete: start("delete"),
    execute: async (...args: unknown[]) => {
      calls.push({ root: "execute", table: "", ops: [{ fn: "execute", args }] });
      return { rows: [] };
    },
    transaction: async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => {
      db.transactions += 1;
      return fn(db);
    },
  };

  return db;
}
