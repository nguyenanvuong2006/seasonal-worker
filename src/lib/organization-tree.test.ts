import test from "node:test";
import assert from "node:assert/strict";
import {
  slugifyPathLabel,
  slugifyCode,
  pathDepth,
  pathSegments,
  buildChildPath,
  isDescendantPath,
  isAncestorPath,
  rebasePath,
  wouldCreateCycle,
  formatBreadcrumb,
  isValidOrgUnitCode,
  CODE_MAX_LENGTH,
} from "./organization-tree.ts";

/* ============================================================
   ORGANIZATION TREE — PATH MATH (mục 24 đề bài: Organization Tree
   test case #1-8, thuần logic — không cần DB).
   ============================================================ */

test("slugifyPathLabel: bỏ dấu, khoảng trắng, gạch ngang -> chỉ [a-z0-9_]", () => {
  assert.equal(slugifyPathLabel("Chrysanthemums"), "chrysanthemums");
  assert.equal(slugifyPathLabel("Cắt hoa - Cúc"), "cat_hoa_cuc");
  assert.equal(slugifyPathLabel("Đà Lạt"), "da_lat");
  assert.equal(slugifyPathLabel(""), "unit");
  assert.match(slugifyPathLabel("123abc"), /^[a-z0-9_]/);
});

test("slugifyCode: cho phép gạch ngang, khác slugifyPathLabel", () => {
  assert.equal(slugifyCode("Cut Flowers"), "cut-flowers");
  assert.equal(slugifyCode("Đà Lạt"), "da-lat");
});

/* ============================================================
   PR1 — CODE GOVERNANCE: isValidOrgUnitCode() phải khớp CHÍNH XÁC
   3 nguồn sinh code thật đang có trong DB (mục XIV đề bài: audit
   dữ liệu hiện có, không tạo format mới rồi fail hàng loạt dữ liệu
   hợp lệ đang có).
   ============================================================ */

test("isValidOrgUnitCode: chấp nhận output thật của slugifyCode()", () => {
  assert.equal(isValidOrgUnitCode(slugifyCode("Cut Flowers")), true);
  assert.equal(isValidOrgUnitCode(slugifyCode("Đà Lạt")), true);
  assert.equal(isValidOrgUnitCode(slugifyCode("Cắt hoa - Cúc")), true);
});

test("isValidOrgUnitCode: chấp nhận cầu nối cơ học 'legacy-<uuid>' từ migration 2026-08-17", () => {
  assert.equal(isValidOrgUnitCode("legacy-3b241101-e2bb-4255-8caf-4136c566a962"), true);
});

test("isValidOrgUnitCode: chấp nhận root code 'root'", () => {
  assert.equal(isValidOrgUnitCode("root"), true);
});

test("isValidOrgUnitCode: chấp nhận suffix va chạm '-2', '-3' do createOrganizationUnit sinh khi trùng", () => {
  assert.equal(isValidOrgUnitCode("cut-flowers-2"), true);
});

test("isValidOrgUnitCode: từ chối rỗng, khoảng trắng, hoa, dấu, gạch ngang liên tiếp/đầu/cuối", () => {
  assert.equal(isValidOrgUnitCode(""), false);
  assert.equal(isValidOrgUnitCode("Cut Flowers"), false); // hoa + khoảng trắng — chưa qua slugifyCode
  assert.equal(isValidOrgUnitCode("cut_flowers"), false); // gạch dưới là path label, không phải code
  assert.equal(isValidOrgUnitCode("-cut-flowers"), false);
  assert.equal(isValidOrgUnitCode("cut-flowers-"), false);
  assert.equal(isValidOrgUnitCode("cut--flowers"), false);
  assert.equal(isValidOrgUnitCode("đà-lạt"), false); // còn dấu tiếng Việt (chưa qua stripDiacritics)
});

test("isValidOrgUnitCode: từ chối vượt CODE_MAX_LENGTH (khớp varchar(64) của cột)", () => {
  const tooLong = "a".repeat(CODE_MAX_LENGTH + 1);
  assert.equal(isValidOrgUnitCode(tooLong), false);
  assert.equal(isValidOrgUnitCode("a".repeat(CODE_MAX_LENGTH)), true);
});

test("CASE 1 — Section KHÔNG có Group vẫn là node hợp lệ (leaf ở tầng bất kỳ)", () => {
  const path = "root.daton.prodpack.production.cutflowers"; // dừng ở Section-level, không Group
  assert.equal(pathDepth(path), 5);
  assert.deepEqual(pathSegments(path), ["root", "daton", "prodpack", "production", "cutflowers"]);
});

test("CASE 2 — Group tiếp tục có child (Team/Line/Cell...) vẫn hợp lệ", () => {
  const groupPath = "root.daton.prodpack.production.cutflowers.chry";
  const childPath = buildChildPath(groupPath, "spray");
  assert.equal(childPath, "root.daton.prodpack.production.cutflowers.chry.spray");
  assert.ok(isDescendantPath(childPath, groupPath));
});

test("CASE 3 — Hierarchy sâu 9 tầng (đúng ví dụ Daton...Harvesting trong đề bài) hợp lệ", () => {
  const path = "root.daton.prodpack.production.cutflowers.chry.spray.fast.harvesting";
  assert.equal(pathDepth(path), 9);
  const root = "root";
  assert.ok(isDescendantPath(path, root));
  assert.ok(isAncestorPath(root, path));
});

test("CASE 4 — Move: preserve descendants, các node KHÔNG thuộc subtree không bị đụng tới", () => {
  const oldNodePath = "root.daton.prodpack.production"; // moving "production"
  const newParentPath = "root.locb"; // sang Location B

  const nodeRows = [
    { path: "root", isMoved: false },
    { path: "root.daton", isMoved: false },
    { path: "root.daton.prodpack", isMoved: false },
    { path: "root.locb", isMoved: false },
    { path: "root.daton.prodpack.production", isMoved: true }, // chính node được move
    { path: "root.daton.prodpack.production.cutflowers", isMoved: true },
    { path: "root.daton.prodpack.production.cutflowers.chry", isMoved: true },
  ];

  const moved = nodeRows.filter((r) => isDescendantPath(r.path, oldNodePath));
  const untouched = nodeRows.filter((r) => !isDescendantPath(r.path, oldNodePath));

  assert.equal(moved.length, 3);
  assert.equal(untouched.length, 4);
  assert.ok(untouched.every((r) => !r.isMoved), "chỉ những dòng thực sự trong subtree mới được đánh dấu moved");

  const newPaths = moved.map((r) => rebasePath(r.path, oldNodePath, newParentPath));
  assert.deepEqual(newPaths, [
    "root.locb.production",
    "root.locb.production.cutflowers",
    "root.locb.production.cutflowers.chry",
  ]);
});

test("CASE 5 — Circular parent: di chuyển node vào làm con của chính descendant của nó bị chặn", () => {
  const nodePath = "root.daton.prodpack.production";
  const descendantOfNode = "root.daton.prodpack.production.cutflowers.chry";
  assert.ok(wouldCreateCycle(nodePath, descendantOfNode), "phải phát hiện circular — descendant không thể làm parent mới");
});

test("CASE 6 — Không được parent chính nó", () => {
  const nodePath = "root.daton.prodpack.production";
  assert.ok(wouldCreateCycle(nodePath, nodePath), "node không thể tự làm parent của chính nó");
});

test("Không bị false-positive: move sang 1 nhánh hoàn toàn khác (không phải tổ tiên/con cháu) không bị chặn", () => {
  const nodePath = "root.daton.prodpack.production";
  const unrelatedPath = "root.locb.packing";
  assert.equal(wouldCreateCycle(nodePath, unrelatedPath), false);
});

test("CASE 7 — Inactive node vẫn giữ path/ancestor hợp lệ để historical join tiếp tục resolve", () => {
  // isActive là 1 cột riêng ở DB (schema.ts) — path/ancestor math ở module này hoàn toàn không phụ
  // thuộc is_active, nên 1 node bị deactivate vẫn breadcrumb/ancestor-check đúng như trước.
  const inactiveLeafPath = "root.daton.prodpack.production.cutflowers.chry.spray.fast.harvesting";
  assert.ok(isDescendantPath(inactiveLeafPath, "root.daton"));
  assert.equal(pathDepth(inactiveLeafPath), 9);
});

test("CASE 8 — Breadcrumb trả đúng arbitrary-depth path (ví dụ 9 tầng của đề bài)", () => {
  const ancestors = [
    { id: "1", name: "Dalat Hasfarm" },
    { id: "2", name: "Daton" },
    { id: "3", name: "Production and Packing" },
    { id: "4", name: "Production" },
    { id: "5", name: "Cut Flowers" },
    { id: "6", name: "Chrysanthemums" },
    { id: "7", name: "Spray" },
    { id: "8", name: "Fast" },
    { id: "9", name: "Harvesting" },
  ];
  assert.equal(
    formatBreadcrumb(ancestors),
    "Dalat Hasfarm > Daton > Production and Packing > Production > Cut Flowers > Chrysanthemums > Spray > Fast > Harvesting",
  );
});

test("Breadcrumb ngắn (2 tầng) cũng đúng — không giả định luôn có 5 tầng", () => {
  const ancestors = [
    { id: "1", name: "Daton" },
    { id: "2", name: "Packing A" },
  ];
  assert.equal(formatBreadcrumb(ancestors), "Daton > Packing A");
});

test("rebasePath: ném lỗi nếu path không thực sự thuộc subtree (lỗi lập trình, không phải nghiệp vụ)", () => {
  assert.throws(() => rebasePath("root.locb.other", "root.daton.prodpack", "root.locb"));
});
