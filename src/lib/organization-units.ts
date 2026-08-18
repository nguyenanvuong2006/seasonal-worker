import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, employmentSessions, organizationUnits, recruitmentRequests } from "@/db/schema";
import { buildChildPath, pathDepth, slugifyCode, slugifyPathLabel, wouldCreateCycle } from "@/lib/organization-tree";

/**
 * ORGANIZATION UNITS — DỊCH VỤ GHI/ĐỌC (Org Tree, Phase Org-Tree Step 1).
 *
 * Cột `path` là kiểu Postgres `ltree` thật (xem migrations/2026-08-17-organization-units.sql)
 * nhưng Drizzle khai báo là `text` (không có kiểu ltree sẵn) — MỌI câu lệnh đụng tới `path`
 * ở đây đi qua `db.execute(sql...)` với cast tường minh `${value}::ltree` cho rõ ràng/an toàn
 * (đã verify trực tiếp bằng package `pg` — driver Drizzle dùng ở đây — trên Postgres 16.13
 * thật: tham số qua `$1` không mang kiểu cố định nên Postgres tự suy kiểu ltree/uuid từ ngữ
 * cảnh, insert/so sánh không cast cũng chạy đúng; cast chỉ để code khỏi mập mờ, không phải
 * yêu cầu bắt buộc của driver).
 *
 * Giống hệt cách employment.ts làm cho employment_sessions: mọi thao tác nhiều bước chạy
 * trong `db.transaction()` với khoá dòng trước khi kiểm tra invariant.
 */

export class OrgTreeError extends Error {
  constructor(
    message: string,
    readonly code: string = "ORG_TREE_RULE",
  ) {
    super(message);
  }
}

export type OrganizationUnitRow = {
  id: string;
  code: string;
  name: string;
  unitType: string;
  parentId: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  isActive: boolean;
  legacyDepartmentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapRow(r: typeof organizationUnits.$inferSelect): OrganizationUnitRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    unitType: r.unitType,
    parentId: r.parentId,
    path: r.path,
    depth: r.depth,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    legacyDepartmentId: r.legacyDepartmentId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Toàn bộ cây (mọi node, active lẫn inactive) — đủ nhỏ để tải hết 1 lần cho UI dạng cây (mục 15: recursive CTE/N+1 chỉ dành cho admin UI, không phải hot-path). */
export async function listAllUnits(): Promise<OrganizationUnitRow[]> {
  const rows = await db.select().from(organizationUnits).orderBy(organizationUnits.path);
  return rows.map(mapRow);
}

export async function getUnit(id: string): Promise<OrganizationUnitRow | null> {
  const [row] = await db.select().from(organizationUnits).where(eq(organizationUnits.id, id)).limit(1);
  return row ? mapRow(row) : null;
}

// SELECT * trả về tên cột snake_case (unit_type, parent_id...) — KHÔNG khớp trực tiếp với
// OrganizationUnitRow (camelCase). Mọi raw query cần trả đủ hàng PHẢI alias tường minh sang
// camelCase như dưới đây (cùng quy ước với các raw query khác trong repo, vd
// employment.ts:auditEmploymentIntegrity) — tuyệt đối không dùng SELECT * trần rồi map thủ công.
const UNIT_COLUMNS_SQL = sql.raw(`
  id, code, name, unit_type AS "unitType", parent_id AS "parentId", path::text AS path, depth,
  sort_order AS "sortOrder", is_active AS "isActive", legacy_department_id AS "legacyDepartmentId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`);

/** Tổ tiên theo thứ tự root -> node (bao gồm chính node) — dùng cho breadcrumb (mục 5, 20). */
export async function getAncestors(id: string): Promise<OrganizationUnitRow[]> {
  const unit = await getUnit(id);
  if (!unit) return [];
  const result = await db.execute<OrganizationUnitRow>(sql`
    SELECT ${UNIT_COLUMNS_SQL} FROM organization_units
    WHERE path @> ${unit.path}::ltree
    ORDER BY nlevel(path) ASC
  `);
  return result.rows;
}

/** Toàn bộ descendants (bao gồm chính node) — dùng cho subtree count/aggregation. */
export async function getDescendants(id: string): Promise<OrganizationUnitRow[]> {
  const unit = await getUnit(id);
  if (!unit) return [];
  const result = await db.execute<OrganizationUnitRow>(sql`
    SELECT ${UNIT_COLUMNS_SQL} FROM organization_units
    WHERE path <@ ${unit.path}::ltree
    ORDER BY path ASC
  `);
  return result.rows;
}

export async function getBreadcrumb(id: string): Promise<{ id: string; name: string }[]> {
  const ancestors = await getAncestors(id);
  return ancestors.map((a) => ({ id: a.id, name: a.name }));
}

/**
 * Đếm lao động hiện đang ACTIVE tại 1 node — CHỈ áp dụng cho node đã có
 * legacy_department_id (cầu nối sang departments.deptId, nguồn dữ liệu worker
 * DUY NHẤT tồn tại ở PR1). Node mới tạo thuần trên cây (chưa gắn dept nào)
 * trả về 0 — đúng, vì chưa có luồng nào ghi worker vào node thuần cây (đó là
 * việc của PR2 — worker_assignments).
 */
export async function countActiveWorkers(unit: Pick<OrganizationUnitRow, "legacyDepartmentId">): Promise<number> {
  if (!unit.legacyDepartmentId) return 0;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(employmentSessions)
    .where(and(eq(employmentSessions.deptId, unit.legacyDepartmentId), eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate)));
  return row?.c ?? 0;
}

/** Yêu cầu tuyển dụng đang mở (PENDING/PROCESSING) tại node — cùng cầu nối legacy_department_id. */
export async function countActiveRecruitmentRequests(unit: Pick<OrganizationUnitRow, "legacyDepartmentId">): Promise<number> {
  if (!unit.legacyDepartmentId) return 0;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(recruitmentRequests)
    .where(
      and(
        eq(recruitmentRequests.departmentId, unit.legacyDepartmentId),
        isNull(recruitmentRequests.deletedAt),
        sql`${recruitmentRequests.status} IN ('PENDING', 'PROCESSING')`,
      ),
    );
  return row?.c ?? 0;
}

/** Đăng ký (Daily Application) trong ngày đang chờ xử lý tại node — chỉ để hiển thị bối cảnh trên panel chi tiết. */
export async function countTodayApplications(unit: Pick<OrganizationUnitRow, "legacyDepartmentId">, date: string): Promise<number> {
  if (!unit.legacyDepartmentId) return 0;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(dailyApplications)
    .where(and(eq(dailyApplications.deptId, unit.legacyDepartmentId), eq(dailyApplications.regDate, date), isNull(dailyApplications.deletedAt)));
  return row?.c ?? 0;
}

type Actor = { username: string };

/**
 * Tạo 1 node con của `parentId` (bắt buộc — chỉ có đúng 1 root COMPANY, được
 * seed sẵn bởi migration, không tạo root thứ 2 qua hàm này). Không giới hạn
 * độ sâu — parent có thể là Section/Group/bất kỳ tầng nào (mục 3 đề bài).
 */
export async function createOrganizationUnit(input: {
  name: string;
  code?: string | null;
  unitType: string;
  parentId: string;
  sortOrder?: number;
  actor: Actor;
}): Promise<OrganizationUnitRow> {
  const name = input.name.trim();
  if (!name) throw new OrgTreeError("Tên đơn vị không được để trống.", "NAME_REQUIRED");

  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(organizationUnits).where(eq(organizationUnits.id, input.parentId)).for("update");
    if (!parent) throw new OrgTreeError("Không tìm thấy đơn vị cha.", "PARENT_NOT_FOUND");
    if (!parent.isActive) throw new OrgTreeError("Đơn vị cha đã bị vô hiệu hoá — không thể thêm con mới.", "PARENT_INACTIVE");

    const baseCode = slugifyCode(input.code?.trim() || name);
    const baseLabel = slugifyPathLabel(input.code?.trim() || name);

    // Đảm bảo code + path label duy nhất — thử baseLabel, rồi baseLabel_2, _3... (va chạm hiếm
    // vì code đã bao gồm tên, nhưng vẫn phải xử lý an toàn thay vì để lỗi unique index rơi ra ngoài).
    //
    // GOVERNANCE (PR1 mục XI/XIII): kiểm tra trùng code trên TOÀN BỘ dòng (active lẫn
    // inactive) — KHÔNG chỉ dòng active. `code` sẽ trở thành cross-system business key
    // (mục XI đề bài); nếu chỉ chặn trùng với dòng active thì 1 unit mới có thể vô tình
    // "thừa kế" đúng code của 1 unit đã deactivate trước đó (retired-code reuse), làm
    // external system resolve nhầm sang unit khác theo thời gian dù cùng 1 mã — vi phạm
    // thẳng yêu cầu "STABLE". Unique index `org_units_code_uq` ở DB (migration SQL) vẫn
    // cố ý chỉ áp cho active — đó là lưới chốt cho race giữa 2 unit ACTIVE cùng lúc, khác
    // mục đích với kiểm tra này (tránh cấp phát trùng NGAY TỪ ĐẦU, kể cả với dòng inactive).
    let code = baseCode;
    let label = baseLabel;
    let attempt = 1;
    for (;;) {
      const candidatePath = buildChildPath(parent.path, label);
      const [codeClash] = await tx
        .select({ id: organizationUnits.id })
        .from(organizationUnits)
        .where(eq(organizationUnits.code, code))
        .limit(1);
      const [pathClash] = await tx.execute<{ id: string }>(sql`SELECT id FROM organization_units WHERE path = ${candidatePath}::ltree LIMIT 1`).then((r) => r.rows);
      if (!codeClash && !pathClash) break;
      attempt += 1;
      code = `${baseCode}-${attempt}`;
      label = `${baseLabel}_${attempt}`;
      if (attempt > 50) throw new OrgTreeError("Không tạo được mã đơn vị duy nhất — thử đặt tên/mã khác.", "CODE_COLLISION");
    }

    const childPath = buildChildPath(parent.path, label);
    const depth = pathDepth(childPath) - 1;

    const [created] = await tx
      .execute<OrganizationUnitRow>(
        sql`
      INSERT INTO organization_units (code, name, unit_type, parent_id, path, depth, sort_order, created_by, updated_by)
      VALUES (${code}, ${name}, ${input.unitType}, ${parent.id}, ${childPath}::ltree, ${depth}, ${input.sortOrder ?? 0}, ${input.actor.username}, ${input.actor.username})
      RETURNING ${UNIT_COLUMNS_SQL}
    `,
      )
      .then((r) => r.rows);

    return created;
  }).catch((e) => {
    // Race hiếm giữa 2 request tạo cùng tên gần như đồng thời — vòng kiểm tra trùng bên trong
    // vẫn có thể bị vượt qua trước khi commit; unique index (org_units_code_uq) là lưới chốt cuối.
    const err = e as { code?: string };
    if (err.code === "23505") {
      throw new OrgTreeError("Mã đơn vị vừa bị trùng do 2 người tạo gần như đồng thời — thử lại.", "CODE_RACE");
    }
    throw e;
  });
}

/** Sửa tên/mã hiển thị/loại/thứ tự — KHÔNG đổi path (đổi cha dùng moveOrganizationUnit riêng). */
export async function updateOrganizationUnit(input: {
  id: string;
  name?: string;
  unitType?: string;
  sortOrder?: number;
  actor: Actor;
}): Promise<OrganizationUnitRow> {
  const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: input.actor.username };
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) throw new OrgTreeError("Tên đơn vị không được để trống.", "NAME_REQUIRED");
    patch.name = trimmed;
  }
  if (input.unitType !== undefined) patch.unitType = input.unitType;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

  const [updated] = await db.update(organizationUnits).set(patch).where(eq(organizationUnits.id, input.id)).returning();
  if (!updated) throw new OrgTreeError("Không tìm thấy đơn vị.", "NOT_FOUND");
  return mapRow(updated);
}

/**
 * Di chuyển 1 node (và toàn bộ subtree) sang làm con của `newParentId`.
 * KHÔNG BAO GIỜ xoá/insert lại — chỉ UPDATE path (đã verify công thức trên
 * Postgres 16 thật: chỉ đúng các dòng trong subtree bị đổi path, các dòng
 * khác — kể cả anh em của node — không bị đụng tới).
 */
export async function moveOrganizationUnit(input: { id: string; newParentId: string; actor: Actor }): Promise<OrganizationUnitRow> {
  if (input.id === input.newParentId) {
    throw new OrgTreeError("Một đơn vị không thể tự làm cha của chính nó.", "SELF_PARENT");
  }

  return db.transaction(runMove).catch((e) => {
    // Lưới cuối cấp DB (trigger organization_units_no_cycle, xem migration) — lớp CHÍNH là
    // wouldCreateCycle() bên dưới, trigger chỉ nên bắt được trường hợp app-layer có bug ở PR
    // sau. Dịch lỗi thô của Postgres thành thông báo nghiệp vụ rõ ràng thay vì rơi ra 500 lạ.
    const err = e as { code?: string };
    if (err.code === "23514") {
      throw new OrgTreeError(
        "Không thể di chuyển một đơn vị vào làm con của chính nó hoặc của một đơn vị con cháu của nó (sẽ tạo vòng lặp).",
        "CIRCULAR_PARENT",
      );
    }
    throw e;
  });

  async function runMove(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
    const [node] = await tx.select().from(organizationUnits).where(eq(organizationUnits.id, input.id)).for("update");
    if (!node) throw new OrgTreeError("Không tìm thấy đơn vị cần di chuyển.", "NOT_FOUND");

    const [newParent] = await tx.select().from(organizationUnits).where(eq(organizationUnits.id, input.newParentId)).for("update");
    if (!newParent) throw new OrgTreeError("Không tìm thấy đơn vị cha mới.", "PARENT_NOT_FOUND");
    if (!newParent.isActive) throw new OrgTreeError("Đơn vị cha mới đã bị vô hiệu hoá.", "PARENT_INACTIVE");

    if (wouldCreateCycle(node.path, newParent.path)) {
      throw new OrgTreeError(
        "Không thể di chuyển một đơn vị vào làm con của chính nó hoặc của một đơn vị con cháu của nó (sẽ tạo vòng lặp).",
        "CIRCULAR_PARENT",
      );
    }
    if (node.parentId === newParent.id) {
      return mapRow(node); // đã đúng vị trí — idempotent, không cần làm gì thêm
    }

    const dropCount = pathDepth(node.path) - 1;

    await tx.execute(sql`
      UPDATE organization_units
      SET
        path = ${newParent.path}::ltree || subpath(path, ${dropCount}),
        depth = nlevel(${newParent.path}::ltree || subpath(path, ${dropCount})) - 1,
        parent_id = CASE WHEN id = ${node.id} THEN ${newParent.id}::uuid ELSE parent_id END,
        updated_at = now(),
        updated_by = ${input.actor.username}
      WHERE path <@ ${node.path}::ltree
    `);

    const [moved] = await tx.select().from(organizationUnits).where(eq(organizationUnits.id, node.id)).limit(1);
    return mapRow(moved);
  }
}

/**
 * Vô hiệu hoá (KHÔNG xoá) — node và mọi tham chiếu lịch sử (legacy_department_id,
 * worker/request đã gắn) vẫn resolve được nguyên vẹn. KHÔNG cascade xuống con —
 * mỗi node tự quản lý trạng thái active của chính nó (giống departments.isActive
 * hiện tại, không có khái niệm cascade).
 */
export async function deactivateOrganizationUnit(input: { id: string; actor: Actor }): Promise<OrganizationUnitRow> {
  const [updated] = await db
    .update(organizationUnits)
    .set({ isActive: false, updatedAt: new Date(), updatedBy: input.actor.username })
    .where(eq(organizationUnits.id, input.id))
    .returning();
  if (!updated) throw new OrgTreeError("Không tìm thấy đơn vị.", "NOT_FOUND");
  return mapRow(updated);
}

export async function reactivateOrganizationUnit(input: { id: string; actor: Actor }): Promise<OrganizationUnitRow> {
  const [updated] = await db
    .update(organizationUnits)
    .set({ isActive: true, updatedAt: new Date(), updatedBy: input.actor.username })
    .where(eq(organizationUnits.id, input.id))
    .returning();
  if (!updated) throw new OrgTreeError("Không tìm thấy đơn vị.", "NOT_FOUND");
  return mapRow(updated);
}

/* ============================================================
   CODE GOVERNANCE (PR1 — Organization Canonicalization Foundation)
   ------------------------------------------------------------
   `organization_units.code` là ứng viên duy nhất cho future cross-system
   business key (approval-system sẽ tham chiếu ngược vào code này ở PR2+).
   Bất biến đang được ĐẢM BẢO Ở TẦNG ỨNG DỤNG (Option A — "application-enforced
   immutable", chọn theo đúng mục XIII đề bài vì repo CHƯA có nhu cầu nghiệp vụ
   nào cần đổi code sau khi tạo):

     1. IMMUTABLE SAU CREATE — updateOrganizationUnit() ở trên chỉ nhận
        name/unitType/sortOrder, KHÔNG có tham số `code`. Không route/hàm nào
        khác trong repo ghi vào organization_units (verify bằng grep toàn repo —
        xem docs/ORGANIZATION_MAPPING_AUDIT.md mục "Code governance"). Muốn đổi
        code phải sửa trực tiếp DB (Option B — "Controlled rename" với
        reason/changed_by/changed_at — CHƯA cần thiết, không implement ở PR1).
     2. UNIQUE TRÊN TOÀN BỘ DÒNG khi cấp phát mới (xem createOrganizationUnit())
        — không chỉ so với dòng active — để 1 code đã "nghỉ hưu" (unit bị
        deactivate) không bao giờ bị cấp lại cho 1 unit khác.
     3. STABLE — code KHÔNG tự sinh lại theo tên khi rename (updateOrganizationUnit
        đổi `name` không đụng `code`) — đã verify bằng test
        "rename KHÔNG mutate code" trong organization-units-lookup.test.ts.

   Các hàm dưới đây là ĐIỂM TRUY VẤN DUY NHẤT cho code/legacy bridge — PR sau
   (approval-system integration, PR2+) PHẢI dùng lại, KHÔNG tự viết query mapping
   riêng (mục XVI đề bài). Quy tắc chung cho cả 3 hàm: EXACT MATCH, KHÔNG fallback
   sang tên, KHÔNG fuzzy match, KHÔNG đoán khi dữ liệu mơ hồ (ném OrgTreeError thay
   vì âm thầm chọn 1 trong nhiều kết quả).
   ============================================================ */

/**
 * Resolve `code` -> đơn vị tổ chức, EXACT MATCH — dùng cho external system
 * integration ở PR sau (mục XV đề bài). Trả về unit kèm `isActive` rõ ràng
 * (caller tự quyết định coi unit inactive là hợp lệ hay không) — KHÔNG bao giờ
 * fallback sang tìm theo tên.
 *
 * Vì `org_units_code_uq` chỉ unique trên dòng active (mục XI: mỗi thời điểm chỉ
 * 1 unit active giữ 1 code, nhưng code có thể từng thuộc 1 unit khác đã bị
 * deactivate trước khi governance mục XI được siết ở PR1 — dữ liệu lịch sử có
 * thể vẫn còn), hàm này ưu tiên trả unit ACTIVE nếu có; nếu không có unit active
 * nào nhưng có ĐÚNG 1 unit inactive khớp code, trả về unit đó. Nếu mơ hồ (nhiều
 * unit active cùng code — vi phạm bất biến DB, hoặc nhiều unit inactive cùng code
 * — retired code từng bị dùng lại trước PR1) → ném OrgTreeError, KHÔNG đoán.
 */
export async function findOrganizationUnitByCode(code: string): Promise<OrganizationUnitRow | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;

  const rows = await db.select().from(organizationUnits).where(eq(organizationUnits.code, trimmed));
  if (rows.length === 0) return null;

  const active = rows.filter((r) => r.isActive);
  if (active.length > 1) {
    throw new OrgTreeError(
      `Dữ liệu vi phạm bất biến: có ${active.length} đơn vị đang ACTIVE cùng dùng mã "${trimmed}" (org_units_code_uq lẽ ra phải chặn) — cần đối soát thủ công, không tự chọn.`,
      "CODE_AMBIGUOUS_ACTIVE",
    );
  }
  if (active.length === 1) return mapRow(active[0]);

  if (rows.length === 1) return mapRow(rows[0]);

  throw new OrgTreeError(
    `Mã "${trimmed}" từng được dùng bởi ${rows.length} đơn vị đã inactive (retired code reuse trước khi governance mục XI được siết) — không thể resolve duy nhất, cần đối soát thủ công.`,
    "CODE_AMBIGUOUS_INACTIVE",
  );
}

/**
 * Resolve `departments.id` (legacy) -> đơn vị tổ chức tương ứng, EXACT MATCH.
 * Đây là ĐIỂM DUY NHẤT nên dùng cho bridge legacy_department_id -> organization
 * unit (mục XVI đề bài) — PR sau KHÔNG tự viết `eq(organizationUnits.legacyDepartmentId, ...)`
 * rải rác. `org_units_legacy_dept_uq` (unique index, WHERE legacy_department_id
 * IS NOT NULL — xem migrations/2026-08-17-organization-units.sql) đảm bảo tối đa
 * 1 kết quả trong điều kiện DB khoẻ mạnh; nếu vi phạm (constraint bị bypass hoặc
 * chưa áp dụng đúng ở DB đang chạy) hàm ném lỗi thay vì âm thầm trả 1 trong nhiều.
 */
export async function findOrganizationUnitByLegacyDepartmentId(legacyDepartmentId: string): Promise<OrganizationUnitRow | null> {
  const rows = await db.select().from(organizationUnits).where(eq(organizationUnits.legacyDepartmentId, legacyDepartmentId));
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new OrgTreeError(
      `Dữ liệu vi phạm bất biến: có ${rows.length} đơn vị cùng trỏ legacy_department_id="${legacyDepartmentId}" (org_units_legacy_dept_uq lẽ ra phải chặn) — cần đối soát thủ công.`,
      "LEGACY_MAPPING_DUPLICATE",
    );
  }
  return mapRow(rows[0]);
}

/**
 * Chiều ngược lại: `organization_unit.id` -> `departments.id` (legacy), nếu có.
 * Trả `null` khi unit không tồn tại HOẶC tồn tại nhưng chưa gắn legacy bridge
 * (node thuần trên cây, tạo mới qua createOrganizationUnit — KHÔNG BAO GIỜ có
 * legacyDepartmentId, xem createOrganizationUnit() ở trên) — mục XVII đề bài:
 * "không fail hoặc đoán", cả 2 trường hợp đều hợp lệ để trả null, không phải lỗi.
 */
export async function getLegacyDepartmentIdForUnit(organizationUnitId: string): Promise<string | null> {
  const unit = await getUnit(organizationUnitId);
  return unit?.legacyDepartmentId ?? null;
}
