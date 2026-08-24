/**
 * INCIDENT REGRESSION — merge-workspace Preview containment & isolation.
 *
 * Sự cố production: crash render Preview đã unmount toàn bộ route
 * /admin/document-merge. Repo không có jsdom test runner cho component, nên
 * theo khuôn mẫu sẵn có (route.test.ts soi routeSource), các test này khóa
 * cứng những bất biến ở MỨC MÃ NGUỒN của component:
 *
 *   1. Payload Preview PHẢI đi qua normalizePreviewResponse trước khi vào
 *      state (không bao giờ setPreview(data) thô).
 *   2. Panel Preview PHẢI được bọc PreviewErrorBoundary — lỗi render bị giam
 *      trong panel, trang cha vẫn sống.
 *   3. iframe canonical PHẢI sandbox + srcDoc — HTML tài liệu không thể
 *      điều hướng/escape trang cha.
 *   4. Chống race: response cũ không được chạm state (sequence guard).
 *   5. Preview không bao giờ điều hướng trang (không router.push/location=).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./merge-workspace.tsx", import.meta.url), "utf8");

test("A/F. mọi payload Preview đi qua normalizePreviewResponse — không setPreview(data) thô", () => {
  assert.match(source, /setPreview\(normalizePreviewResponse\(data\)\)/);
  assert.doesNotMatch(source, /setPreview\(data\)/, "cấm đưa payload API thô vào state Preview");
});

test("C/D. Preview API !ok → diagnostic box, setPreview(null) — không ném trong render", () => {
  assert.match(source, /if \(!res\.ok\) \{[\s\S]*?setDiagnostic\(\{[\s\S]*?\}\);[\s\S]*?setPreview\(null\);[\s\S]*?return;/);
});

test("E. network failure → NETWORK_ERROR diagnostic, không throw ra ngoài", () => {
  assert.match(source, /code: "NETWORK_ERROR"/);
});

test("F. body không phải JSON → parse an toàn trong try/catch riêng, không rơi vào network path", () => {
  assert.match(source, /let data: Record<string, unknown> = \{\};[\s\S]*?try \{[\s\S]*?await res\.json\(\)/);
});

test("G. race guard: chỉ response mới nhất được chạm state", () => {
  assert.match(source, /previewRequestSeq/);
  assert.match(source, /const seq = \+\+previewRequestSeq\.current/);
  assert.match(source, /if \(seq !== previewRequestSeq\.current\) return/);
});

test("B/H. iframe canonical: sandbox + srcDoc — nội dung không thể điều hướng trang cha", () => {
  const iframe = source.match(/<iframe[\s\S]*?\/>/);
  assert.ok(iframe, "phải có iframe preview");
  assert.match(iframe![0], /sandbox=""/, "iframe phải sandbox (chặn script/top-navigation/form)");
  assert.match(iframe![0], /srcDoc=\{preview\.renderedHtml\}/, "iframe phải dùng srcDoc, không src URL");
  // Không được nới sandbox cho phép điều hướng trang cha.
  assert.doesNotMatch(iframe![0], /allow-top-navigation/);
  assert.doesNotMatch(iframe![0], /allow-same-origin/);
});

test("crash containment: panel Preview được bọc PreviewErrorBoundary với thông báo tiếng Việt + retry", () => {
  assert.match(source, /class PreviewErrorBoundary extends Component/);
  assert.match(source, /static getDerivedStateFromError/);
  assert.match(source, /<PreviewErrorBoundary[\s\S]*?>[\s\S]*?\{preview && \(/, "khối render preview phải nằm TRONG boundary");
  assert.match(source, /Không hiển thị được bản xem trước\./);
  assert.match(source, /Thử lại Preview/);
});

test("I. Preview không gọi endpoint tạo job — chỉ /api/document-merge/preview", () => {
  const loadPreviewBody = source.slice(source.indexOf("const loadPreview"), source.indexOf("// --- Phase 14"));
  assert.match(loadPreviewBody, /fetch\("\/api\/document-merge\/preview"/);
  assert.doesNotMatch(loadPreviewBody, /\/api\/document-merge\/jobs/);
  assert.doesNotMatch(loadPreviewBody, /\/api\/document-merge\/merge\/execute/);
});

test("Preview flow không điều hướng trang (không window.location / router.push trong loadPreview)", () => {
  const loadPreviewBody = source.slice(source.indexOf("const loadPreview"), source.indexOf("// --- Phase 14"));
  assert.doesNotMatch(loadPreviewBody, /window\.location/);
  assert.doesNotMatch(loadPreviewBody, /router\.push/);
});
