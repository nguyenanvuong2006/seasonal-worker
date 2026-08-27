/* ============================================================
   RENDER MỘT COMPONENT .tsx THẬT TRONG JSDOM
   ------------------------------------------------------------
   `load-module.ts` chạy module trong `vm` với require giả — đủ cho
   service tầng DB, nhưng KHÔNG render được React component (cần
   JSX runtime + DOM + React cùng một instance).

   Module này bổ sung phần còn thiếu để test UI đúng như production:

     đọc .tsx thật → ts.transpileModule (jsx: react-jsx) → chạy trong
     vm với require thật (React, react-dom/client, lucide-react) và
     stub cho alias "@/..." → trả module.exports.

   Nhờ vậy Phase 2/6 test được HÀNH VI THẬT (click → state → modal
   mount), thay vì chỉ regex source code — regex không thể phát hiện
   lỗi runtime (component throw, effect reset state, modal không
   mount) vốn là đúng triệu chứng của bug production "bấm không có
   gì xảy ra".
   ============================================================ */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";

const nodeRequire = createRequire(import.meta.url);

export type RenderEnv = {
  dom: JSDOM;
  window: JSDOM["window"];
  document: Document;
  /** Mọi alert() component gọi (jsdom không có sẵn) — để assert phản hồi hiển thị. */
  alerts: string[];
  /** Mọi window.confirm() component gọi. */
  confirms: string[];
  /** Dọn dẹp globals sau mỗi test. */
  cleanup: () => void;
};

/**
 * Cài một DOM thật vào globalThis để React DOM hoạt động.
 * Trả về hàm cleanup để test không rò globals sang test khác.
 */
export function installDom(): RenderEnv {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://example.test/",
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Window & typeof globalThis;

  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "CustomEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "DOMParser",
    "SVGElement",
    "CSSStyleDeclaration",
    "MutationObserver",
  ] as const;

  // Một số global của Node (navigator) chỉ có getter → phải dùng
  // defineProperty thay vì gán thẳng.
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of keys) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = (w as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  // React 19 kiểm tra cờ này khi chạy act() ngoài môi trường test.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom KHÔNG implement alert/confirm (throw "not implemented"), nhưng
  // trình duyệt thật thì có — component gọi alert() trong nhánh lỗi. Nếu
  // không stub, test sẽ báo lỗi giả "alert is not defined" thay vì đo đúng
  // hành vi. Ghi lại lời gọi để test assert được thông báo cho operator.
  const alerts: string[] = [];
  const confirms: string[] = [];
  saved.set("alert", Object.getOwnPropertyDescriptor(globalThis, "alert"));
  saved.set("confirm", Object.getOwnPropertyDescriptor(globalThis, "confirm"));
  const alertFn = (msg?: unknown) => {
    alerts.push(String(msg));
  };
  const confirmFn = (msg?: unknown) => {
    confirms.push(String(msg));
    return true;
  };
  for (const [key, value] of [
    ["alert", alertFn],
    ["confirm", confirmFn],
  ] as const) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    Object.defineProperty(w, key, { value, writable: true, configurable: true });
  }

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    alerts,
    confirms,
    cleanup: () => {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
      dom.window.close();
    },
  };
}

export type LoadComponentOptions = {
  /** Stub cho các specifier alias ("@/lib/...", "./sibling"). */
  stubs?: Record<string, unknown>;
  /** Cho phép nạp thật các file .tsx/.ts anh em (theo đường dẫn tương đối). */
  loadRelative?: boolean;
};

const moduleCache = new Map<string, Record<string, unknown>>();

/**
 * Nạp một component .tsx thật (kèm các import tương đối của nó) và trả
 * về module.exports. React/react-dom/lucide-react dùng bản THẬT trong
 * node_modules để component render y hệt production.
 */
export function loadComponent(fileUrl: URL, options: LoadComponentOptions = {}): Record<string, unknown> {
  const filePath = fileUrl.pathname;
  const cacheKey = `${filePath}::${JSON.stringify(Object.keys(options.stubs ?? {}))}`;
  const cached = moduleCache.get(cacheKey);
  if (cached) return cached;

  const source = readFileSync(fileUrl, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;

  const moduleObj = { exports: {} as Record<string, unknown> };
  moduleCache.set(cacheKey, moduleObj.exports);

  const requireShim = (specifier: string): unknown => {
    const stubs = options.stubs ?? {};
    if (specifier in stubs) return stubs[specifier];

    // Import tương đối → nạp thật file anh em (.tsx rồi .ts).
    if (specifier.startsWith(".") && options.loadRelative !== false) {
      const base = path.resolve(path.dirname(filePath), specifier);
      for (const candidate of [`${base}.tsx`, `${base}.ts`, base]) {
        try {
          readFileSync(candidate);
          return loadComponent(new URL(`file://${candidate}`), options);
        } catch {
          /* thử phần mở rộng kế tiếp */
        }
      }
    }
    // Còn lại: package thật (react, react-dom/client, lucide-react...).
    return nodeRequire(specifier);
  };

  // QUAN TRỌNG: chạy trong CONTEXT HIỆN TẠI (không tạo context riêng và
  // KHÔNG snapshot global vào context). Nếu snapshot, module đã cache sẽ
  // giữ mãi `document`/`fetch` của lần render ĐẦU TIÊN — test sau stub fetch
  // khác sẽ bị bỏ qua và cho kết quả sai (đã dính đúng bẫy này một lần).
  // Dùng compileFunction để module đọc globalThis động tại thời điểm chạy.
  const fn = vm.compileFunction(js, ["module", "exports", "require", "__filename", "__dirname"], {
    filename: filePath,
  });
  fn(moduleObj, moduleObj.exports, requireShim, filePath, path.dirname(filePath));

  moduleCache.set(cacheKey, moduleObj.exports);
  return moduleObj.exports;
}


/** Xoá cache module giữa các test file (tránh giữ React tree cũ). */
export function resetComponentCache(): void {
  moduleCache.clear();
}
