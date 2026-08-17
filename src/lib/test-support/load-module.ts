/* ============================================================
   NẠP MODULE THẬT TRONG SANDBOX
   ------------------------------------------------------------
   Các service tầng DB import "@/db", "server-only", schema... nên
   `node --test` không nạp trực tiếp được (path alias + side effect
   kết nối Postgres). Theo đúng khuôn mẫu đã có trong repo
   (`src/lib/seed.test.ts`, `src/app/api/cron/run/route.test.ts`):

     đọc file .ts thật → ts.transpileModule → chạy trong vm với
     `require` giả trả về các stub do test cung cấp.

   Nhờ vậy test chạy trên ĐÚNG mã nguồn production, không phải bản
   chép tay dễ lệch.
   ============================================================ */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

export type LoadOptions = {
  /** Map từ specifier ("@/db", "drizzle-orm"...) sang module giả. */
  stubs: Record<string, unknown>;
  /** Trả stub cho specifier chưa khai báo; ném lỗi nếu không có. */
  fallback?: (specifier: string) => unknown;
};

/**
 * Nạp một module TypeScript của repo và trả về `module.exports` của nó.
 *
 * @param url  URL tới file nguồn, thường là `new URL("../foo.ts", import.meta.url)`
 */
export function loadModule(url: URL, options: LoadOptions): Record<string, unknown> {
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in options.stubs) return options.stubs[specifier];
    if (options.fallback) return options.fallback(specifier);
    throw new Error(`Unexpected require("${specifier}") — hãy khai báo stub cho module này.`);
  };

  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    console,
    process,
    Date,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    TypeError,
    RangeError,
    Buffer,
    Uint8Array,
    ArrayBuffer,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(js, context);
  return moduleObj.exports;
}

/** Stub rỗng cho "server-only" — package này chỉ tồn tại để chặn import ở client. */
export const serverOnlyStub = {};
