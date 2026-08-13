/**
 * Renders the 4 flowcharts used in the user guide (docs/user-guide/images/diagrams/*.png)
 * from mermaid source, using a locally-installed mermaid.js + Playwright — no network access
 * needed at render time, so it works even when outbound CDN requests are blocked.
 *
 * One-time setup (not part of the app's own dependencies):
 *   npm install --no-save mermaid playwright-core
 *
 * Run after changing a diagram's mermaid code below (keep it in sync with the equivalent
 * ```mermaid fence in the corresponding docs/user-guide/*.md file, which GitHub renders
 * natively — this script only regenerates the static image used by handbook.html):
 *   node scripts/render-user-guide-diagrams.mjs
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const diagrams = [
  {
    name: "flow-overview",
    code: `flowchart LR
    A["Đăng ký công khai<br/>(trang chủ, không cần tài khoản)"] --> B["HR tiếp nhận<br/>(Daily Application)"]
    B --> C{"HR duyệt?"}
    C -- "Đã nhận việc" --> D["Xếp Bộ phận + Nhóm"]
    C -- "Không nhận" --> Z["Kết thúc hồ sơ"]
    D --> E["Làm việc<br/>(Employment Session)"]
    E --> F["Planning<br/>(kế hoạch nhân lực theo giai đoạn)"]
    F --> G{"Có thay đổi?"}
    G -- "Thuyên chuyển bộ phận" --> H["Workforce Movement:<br/>Thuyên chuyển"]
    G -- "Nghỉ việc" --> I["Workforce Movement:<br/>Nghỉ việc"]
    G -- "Không đổi" --> E
    H --> E
    I --> J["Lưu lịch sử<br/>(Worker Profile giữ nguyên)"]`,
  },
  {
    name: "flow-permissions",
    code: `flowchart TB
    subgraph L1["Lớp 1 — ROLE (Bạn LÀ AI)"]
        R["ADMIN · HR_RECRUITER · DEPT_MANAGER"]
    end
    subgraph L2["Lớp 2 — PERMISSION (Bạn ĐƯỢC LÀM GÌ)"]
        P["29 chức năng bật/tắt riêng theo từng Role<br/>vd: registrations.approve, workers.edit, backup.manage..."]
    end
    subgraph L3["Lớp 3 — DATA SCOPE (Bạn ĐƯỢC XEM DỮ LIỆU NÀO)"]
        D["Chỉ áp dụng cho DEPT_MANAGER —<br/>giới hạn theo (các) bộ phận được gán"]
    end
    R --> P --> D`,
  },
  {
    name: "flow-resignation",
    code: `flowchart LR
    A["Tạo yêu cầu nghỉ việc<br/>(chọn lao động + ngày hiệu lực + lý do)"] --> B["Chờ HR duyệt"]
    B -- "HR: Duyệt nghỉ việc" --> C["Đã nghỉ việc"]
    B -- "HR: Từ chối" --> D["HR từ chối"]`,
  },
  {
    name: "flow-transfer",
    code: `flowchart LR
    A["Tạo yêu cầu thuyên chuyển<br/>(bộ phận hiện tại → bộ phận mới + ngày chuyển)"] --> B["Chờ HR xác nhận"]
    B -- "Đã nhận việc" --> C["Đã chuyển bộ phận"]
    B -- "Hoãn" --> E["Đã hoãn<br/>(chờ ngày mới)"]
    B -- "Không đến" --> F["Không đến —<br/>chờ HR quyết định"]
    B -- "Từ chối" --> G["HR từ chối"]
    E -- "Đã nhận việc" --> C
    E -- "Hoãn tiếp" --> E
    E -- "Không đến" --> F
    F -- "Huỷ thuyên chuyển" --> H["Đã huỷ thuyên chuyển"]
    F -- "Sinh yêu cầu nghỉ việc" --> I["→ Tạo yêu cầu Nghỉ việc mới<br/>(liên kết với thuyên chuyển này)"]`,
  },
];

const mermaidJs = fs.readFileSync(path.join(ROOT, "node_modules/mermaid/dist/mermaid.min.js"), "utf-8");
const OUT = path.join(ROOT, "docs/user-guide/images/diagrams");

// Sandbox environments used to build this guide pre-install Chromium outside the usual
// Playwright cache; fall back to Playwright's own managed browser (`npx playwright install
// chromium`) anywhere else.
const SANDBOX_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch(fs.existsSync(SANDBOX_CHROME) ? { executablePath: SANDBOX_CHROME } : {});
try {
  for (const d of diagrams) {
    const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>
      body { margin:0; padding: 24px; background: #ffffff; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
      .mermaid { display: inline-block; }
    </style>
    </head><body>
    <pre class="mermaid">${d.code}</pre>
    <script>${mermaidJs}</script>
    <script>
      mermaid.initialize({
        startOnLoad: true,
        theme: "base",
        themeVariables: {
          primaryColor: "#eaf3ec",
          primaryTextColor: "#16231a",
          primaryBorderColor: "#115830",
          lineColor: "#576358",
          secondaryColor: "#fbf3e1",
          tertiaryColor: "#fdf3e1",
          fontFamily: "-apple-system, Segoe UI, Roboto, sans-serif",
          fontSize: "16px"
        },
        flowchart: { curve: "basis" }
      });
    </script>
    </body></html>`;
    const page = await browser.newPage({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 2 });
    await page.setContent(html);
    await page.waitForSelector("svg", { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const svg = document.querySelector("svg");
      const box = svg.getBBox ? svg.getBBox() : null;
      const vb = svg.getAttribute("viewBox");
      if (vb) {
        const [, , w, h] = vb.split(/\s+/).map(Number);
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
        svg.style.maxWidth = "none";
      } else if (box) {
        svg.setAttribute("width", String(box.width));
        svg.setAttribute("height", String(box.height));
      }
    });
    await page.waitForTimeout(100);
    const svgEl = await page.$("svg");
    await svgEl.screenshot({ path: `${OUT}/${d.name}.png` });
    console.log("rendered", d.name);
    await page.close();
  }
} finally {
  await browser.close();
}
