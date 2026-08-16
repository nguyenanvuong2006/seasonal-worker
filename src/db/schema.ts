import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ============================================================
   SHEET "Department" — Dept. + Group + Tên Tiếng Việt
   Thêm bộ phận mới ở đây sẽ tự động vào dropdown Daily Application
   ============================================================ */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stt: integer("stt"),
    location: varchar("location", { length: 120 }).default(""),
    division: varchar("division", { length: 120 }).default(""),
    deptName: varchar("dept_name", { length: 120 }).notNull(),
    section: varchar("section", { length: 120 }).default(""),
    groupName: varchar("group_name", { length: 120 }).notNull().default(""),
    vnName: varchar("vn_name", { length: 200 }),
    supervisor: varchar("supervisor", { length: 160 }),
    supervisorPhone: varchar("supervisor_phone", { length: 20 }),
    sheetLink: text("sheet_link"),
    // @deprecated (Phase 2, Step 4) — thay bằng planning_periods/planning_targets (Planning theo
    // giai đoạn). KHÔNG xoá cột (giữ dữ liệu cũ) — chỉ không còn đọc/ghi ở code mới.
    dailyQuota: integer("daily_quota").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: varchar("deleted_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dept_group_uq").on(t.deptName, t.groupName).where(sql`deleted_at is null`)],
);

/* ============================================================
   SHEET "DW Data" — Kho hồ sơ lao động chính thức (~20.7k dòng)
   Dùng để ĐỐI CHIẾU người cũ / người mới.
   Không có trong bảng này = LAO ĐỘNG MỚI
   ============================================================ */
export const dwData = pgTable(
  "dw_data",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 40 }),
    itCode: varchar("it_code", { length: 40 }),
    oldDwCode: varchar("old_dw_code", { length: 60 }),
    idVlookup: varchar("id_vlookup", { length: 40 }),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    gender: varchar("gender", { length: 8 }),
    bod: varchar("bod", { length: 20 }),
    profile: varchar("profile", { length: 120 }),
    dktn: varchar("dktn", { length: 40 }),
    cccd: varchar("cccd", { length: 20 }).notNull(),
    dateOfIssue: varchar("date_of_issue", { length: 20 }),
    placeOfIssue: varchar("place_of_issue", { length: 160 }),
    permanentAddress: text("permanent_address"),
    residentialAddress: text("residential_address"),
    phone: varchar("phone", { length: 20 }),
    pitOfDw: varchar("pit_of_dw", { length: 40 }),
    note: text("note"),
    source: varchar("source", { length: 120 }),
    sortCode: integer("sort_code"),
    // @deprecated (Phase 2, Step 7) — hệ thống này KHÔNG phải chấm công, "Ngày công" đã bị loại
    // bỏ khỏi mọi UI/API theo yêu cầu nghiệp vụ. KHÔNG xoá cột (giữ dữ liệu lịch sử cũ) — chỉ
    // không còn đọc/ghi ở code mới (xem HUONG_DAN_HE_THONG.md, Refactor Plan Step 7).
    totalWorkDays: integer("total_work_days").notNull().default(0),
    lastWorkDate: date("last_work_date"),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: varchar("deleted_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dw_cccd_uq").on(t.cccd).where(sql`deleted_at is null`),
    check("dw_data_cccd_exact_12_chk", sql`${t.cccd} ~ '^[0-9]{12}$'`),
    index("dw_name_idx").on(t.fullName),
    index("dw_phone_idx").on(t.phone),
  ],
);

/* ============================================================
   SHEET "Daily Application" — kết quả xuất từ Response để xếp việc
   CCCD LÀ BẮT BUỘC (bỏ hoàn toàn nhánh "không mang CCCD")
   ============================================================ */
export const dailyApplications = pgTable(
  "daily_applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    regDate: date("reg_date").notNull(),

    // Thông tin cá nhân (CCCD bắt buộc)
    cccd: varchar("cccd", { length: 20 }).notNull(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    gender: varchar("gender", { length: 12 }),
    dob: varchar("dob", { length: 20 }),
    birthYear: integer("birth_year"),
    age: integer("age"),
    phone: varchar("phone", { length: 20 }).notNull(),
    ethnicity: varchar("ethnicity", { length: 60 }),

    // Địa chỉ
    permanentAddress: text("permanent_address"),
    residentialAddress: text("residential_address"),

    // Phân loại phía máy chủ từ kết quả đối chiếu CCCD với DW Data
    declaredType: varchar("declared_type", { length: 20 }).notNull().default("NEW"), // OLD | NEW
    dwMatch: varchar("dw_match", { length: 20 }).notNull().default("NEW"), // MATCHED | NEW | MISMATCH
    dwId: uuid("dw_id").references(() => dwData.id, { onDelete: "set null" }),
    dwCode: varchar("dw_code", { length: 40 }),
    // IT CODE / Mã vân tay (#18) — Recruiter nhập tại cột Daily Application; đồng bộ với
    // dw_data.it_code và worker_profiles.fingerprint_code (xem Requirement 2).
    itCode: varchar("it_code", { length: 40 }),

    // Nguyện vọng
    workDuration: varchar("work_duration", { length: 40 }),
    referralChannel: varchar("referral_channel", { length: 120 }),

    // EMPLOYMENT LIFECYCLE (#5-6) — SELF-DECLARATION khi người ĐANG có Employment Session ACTIVE
    // đăng ký lại: NLĐ tự khai "đã báo nghỉ bộ phận cũ". CHỈ là thông tin chờ Recruiter xác minh —
    // KHÔNG tự đóng session, KHÔNG tạo resignation, KHÔNG xoá allocation (xem lib/employment.ts).
    workerDeclaredPreviousResignation: boolean("worker_declared_previous_resignation").notNull().default(false),
    declaredPreviousDeptId: uuid("declared_previous_dept_id"),
    declaredPreviousSessionId: uuid("declared_previous_session_id"),
    declaredResignationDate: date("declared_resignation_date"),
    declaredResignationNote: text("declared_resignation_note"),
    declaredAt: timestamp("declared_at", { withTimezone: true }),

    // HR xếp việc
    deptId: uuid("dept_id").references(() => departments.id, { onDelete: "set null" }),
    // WORKFORCE REQUEST LINKAGE — pipeline Application/Screened/Interviewed/Recruited
    // của request này đọc từ daily_applications theo cột này (source of truth), không
    // dùng các cột số import tay (male_application...) trên recruitment_requests.
    requestId: uuid("request_id").references(() => recruitmentRequests.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"),
    startingDate: date("starting_date"),
    appointmentList: varchar("appointment_list", { length: 60 }),
    noteWorker: text("note_worker"),
    vaccine: varchar("vaccine", { length: 60 }),
    codeCheck: varchar("code_check", { length: 200 }),
    duplicateNameFlag: boolean("duplicate_name_flag").notNull().default(false),

    customAnswers: jsonb("custom_answers").$type<Record<string, string>>().default({}),

    // Document Merge & Ký nhận hồ sơ Tập nghề
    // Recruiter merge Tài liệu A (DW Cũ / Cam kết) hoặc Tài liệu B (DW Mới / HĐ đào tạo)
    // rồi đẩy link vào hồ sơ tra cứu; người xin việc xem + ký điện tử tại /lookup.
    mergedDocUrl: text("merged_doc_url"),
    mergedDocPdfUrl: text("merged_doc_pdf_url"),
    mergedTemplateId: uuid("merged_template_id"),
    documentSentAt: timestamp("document_sent_at", { withTimezone: true }),
    signatureDataUrl: text("signature_data_url"),
    signatureConfirmedAt: timestamp("signature_confirmed_at", { withTimezone: true }),
    confirmedAnswers: jsonb("confirmed_answers").$type<Record<string, string>>().default({}),

    isImported: boolean("is_imported").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: varchar("deleted_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("daily_app_cccd_date_uq").on(t.cccd, t.regDate).where(sql`deleted_at is null`),
    check("daily_applications_cccd_exact_12_chk", sql`${t.cccd} ~ '^[0-9]{12}$'`),
    index("daily_app_date_status_idx").on(t.regDate, t.status),
    index("daily_app_name_idx").on(t.fullName),
  ],
);

/* ============================================================
   Câu hỏi động do Admin thêm (áp dụng từ ngày chỉ định)
   ============================================================ */
export const formQuestions = pgTable(
  "form_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fieldKey: varchar("field_key", { length: 64 }).notNull().unique(),
    questionText: text("question_text").notNull(),
    fieldType: varchar("field_type", { length: 24 }).notNull().default("TEXT"),
    options: jsonb("options").$type<string[]>().default([]),
    isRequired: boolean("is_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    visibleToApplicants: boolean("visible_to_applicants").notNull().default(true),
    targetAudience: varchar("target_audience", { length: 20 }).notNull().default("ALL"),
    skipForReturning: boolean("skip_for_returning").notNull().default(false),
    applyFrom: date("apply_from"),
    // --- Metadata Engine: cho phép import/export nhận diện câu hỏi động theo nhiều tên cột ---
    aliases: jsonb("aliases").$type<string[]>().default([]),
    exportColumnName: varchar("export_column_name", { length: 160 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "form_questions_target_audience_chk",
      sql`${t.targetAudience} IN ('ALL', 'NEW_ONLY', 'RETURNING_ONLY')`,
    ),
  ],
);

/* ============================================================
   METADATA ENGINE — cấu hình tập trung cho các trường "lõi"
   (Department / DW Data / Daily Application). Đổi tên hiển thị,
   thêm alias cột import, bật/tắt export/search/filter... đều
   thực hiện tại /admin/field-definitions, KHÔNG cần sửa code.
   Câu hỏi động (Dynamic Form) tiếp tục quản lý ở form_questions
   phía trên (đã có sẵn field applyFrom/aliases/exportColumnName).
   ============================================================ */
export const fieldDefinitions = pgTable("field_definitions", {
  id: uuid("id").defaultRandom().primaryKey(),
  fieldKey: varchar("field_key", { length: 80 }).notNull().unique(),
  groupName: varchar("group_name", { length: 40 }).notNull().default("daily_application"), // department | dw_data | daily_application
  displayName: varchar("display_name", { length: 160 }).notNull(),
  databaseField: varchar("database_field", { length: 80 }).notNull(),
  importColumnName: varchar("import_column_name", { length: 160 }),
  exportColumnName: varchar("export_column_name", { length: 160 }),
  aliases: jsonb("aliases").$type<string[]>().default([]),
  fieldType: varchar("field_type", { length: 24 }).notNull().default("TEXT"),
  required: boolean("required").notNull().default(false),
  defaultValue: text("default_value"),
  visible: boolean("visible").notNull().default(true),
  editable: boolean("editable").notNull().default(true),
  searchable: boolean("searchable").notNull().default(false),
  sortable: boolean("sortable").notNull().default(false),
  filterable: boolean("filterable").notNull().default(false),
  exportable: boolean("exportable").notNull().default(true),
  importable: boolean("importable").notNull().default(true),
  validationRule: text("validation_rule"),
  applyFrom: date("apply_from"),
  sortOrder: integer("sort_order").notNull().default(0),
  isSystem: boolean("is_system").notNull().default(true), // trường lõi có sẵn (không xoá được, chỉ sửa metadata)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============================================================
   RBAC + Audit
   ============================================================ */
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  fullName: varchar("full_name", { length: 160 }).notNull(),
  role: varchar("role", { length: 32 }).notNull().default("DEPT_MANAGER"),
  deptId: uuid("dept_id").references(() => departments.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  // P0-6 (Production Hardening Audit) — SESSION REVOCATION: JWT sống 12h, ký sẵn role/deptId,
  // trước đây không có cách vô hiệu hoá sớm khi user bị khoá/đổi role/đổi mật khẩu. Mỗi request
  // bảo vệ giờ đọc lại role/isActive TRỰC TIẾP từ DB (không tin theo JWT), và so khớp
  // `sessionVersion` — bất kỳ hành động cần "đăng xuất mọi phiên cũ" (đổi mật khẩu/đổi
  // role/khoá tài khoản) đều tăng số này lên, làm mọi JWT ký trước đó hết hiệu lực ngay lập tức.
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id"),
  username: varchar("username", { length: 64 }),
  action: varchar("action", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 48 }),
  // LOGGING (#12): thay vì tạo 6 bảng vật lý riêng (Audit/System/Import/Export/Auth/API — sẽ
  // trùng lặp cấu trúc và khó truy vấn chéo), dùng 1 bảng với cột phân loại `category`.
  // Đây là quyết định kiến trúc có chủ đích để tránh over-engineering trên 1 database nhỏ.
  category: varchar("category", { length: 24 }).notNull().default("AUDIT"), // AUDIT|SYSTEM|IMPORT|EXPORT|AUTH|API
  details: jsonb("details").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============================================================
   WORKFLOW ENGINE (nền tảng) — thay STATUS_META hard-code bằng
   bảng cấu hình. Hiện áp dụng cho daily_applications.status;
   entityType để mở rộng cho các luồng khác sau này.
   ============================================================ */
export const workflowStages = pgTable(
  "workflow_stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: varchar("entity_type", { length: 40 }).notNull().default("daily_application"),
    stageKey: varchar("stage_key", { length: 40 }).notNull(), // giá trị lưu vào cột status
    label: text("label").notNull(),
    color: varchar("color", { length: 16 }).notNull().default("gray"), // gray|green|amber|red|blue|gold
    sortOrder: integer("sort_order").notNull().default(0),
    isStart: boolean("is_start").notNull().default(false),
    isEnd: boolean("is_end").notNull().default(false),
    allowedRoles: jsonb("allowed_roles").$type<string[]>().default(["ADMIN", "HR_RECRUITER"]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_stage_uq").on(t.entityType, t.stageKey)],
);

/* ============================================================
   RULE ENGINE (nền tảng) — IF (điều kiện, kiểu AND) THEN (hành động).
   Bộ toán tử/hành động giới hạn có chủ đích (an toàn, không cho
   chạy code tuỳ ý trên server) — xem src/lib/rule-engine.ts.
   ============================================================ */
export const rules = pgTable("rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  entityType: varchar("entity_type", { length: 40 }).notNull().default("daily_application"),
  trigger: varchar("trigger", { length: 40 }).notNull().default("ON_REGISTER"), // ON_REGISTER | ON_APPROVE
  conditions: jsonb("conditions").$type<{ field: string; op: string; value: string }[]>().default([]),
  actions: jsonb("actions").$type<{ type: string; value: string }[]>().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============================================================
   DYNAMIC RBAC V2 — CATALOG ROLE / PERMISSION (nền tảng)
   ---------------------------------------------------------------
   Thay mô hình cũ "3 Role hardcode trong code + permission là lớp
   phủ (fail-open)" bằng catalog động:
     - roles:       danh mục vai trò (4 vai trò hệ thống + vai trò
                    tuỳ chỉnh do admin tạo). users.role (varchar)
                    VẪN GIỮ NGUYÊN là role key — không destructive.
     - permissions: danh mục quyền (~42 quyền / 15 nhóm) mà route
                    thật sự kiểm tra (ENFORCED, fail-closed).
     - role_permissions: bảng cũ GIỮ NGUYÊN cấu trúc (role +
                    permission_key + allowed) — là nguồn sự thật cho
                    hasPermission(); chỉ thêm 2 bảng catalog ở trên.
   ============================================================ */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false), // vai trò hệ thống không xoá được
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("roles_key_uq").on(t.key)],
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    groupName: varchar("group_name", { length: 40 }).notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("permissions_key_uq").on(t.key)],
);

/* ============================================================
   RBAC CHI TIẾT (nền tảng) — bổ sung song song với requireRole()
   theo Role hiện có (không thay thế, để không phá các route đang
   chạy thật). Mỗi (role, permissionKey) bật/tắt độc lập.
   ============================================================ */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    role: varchar("role", { length: 32 }).notNull(),
    permissionKey: varchar("permission_key", { length: 64 }).notNull(),
    allowed: boolean("allowed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_permission_uq").on(t.role, t.permissionKey)],
);

/* ============================================================
   NOTIFICATION FOUNDATION — Event → Recipient → Template → Channel
   → Queue (bảng này CHÍNH LÀ hàng đợi, lưu trong Postgres, không
   cần Redis/queue ngoài). CHƯA gửi thật (không tích hợp SMS/Zalo/
   Email) — status dừng ở QUEUED, xem mục "Chưa thể triển khai".
   ============================================================ */
export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  event: varchar("event", { length: 64 }).notNull(),
  recipientType: varchar("recipient_type", { length: 24 }).notNull().default("USER"), // USER | WORKER | ROLE
  recipientRef: varchar("recipient_ref", { length: 160 }).notNull(),
  channel: varchar("channel", { length: 24 }).notNull().default("IN_APP"), // IN_APP | ZALO | SMS | EMAIL (chỉ IN_APP hoạt động)
  templateKey: varchar("template_key", { length: 64 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  status: varchar("status", { length: 20 }).notNull().default("QUEUED"), // QUEUED | SENT | FAILED | SKIPPED
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============================================================
   BRANDING SETTINGS (UI Follow-up: Branding/Profile/Global Search)
   ---------------------------------------------------------------
   1 dòng duy nhất (id cố định 'default') lưu Year Theme + Year Slogan do
   Admin tự cấu hình tại /admin/system — không hard-code trong code. Ảnh
   Year Theme lưu dạng data URL (base64) ngay trong cột text: hệ thống
   chưa có blob storage nào (Vercel Blob/S3...) và ảnh chỉ 1 cái/lúc, quy
   mô nhỏ (nội bộ, không phải nơi lưu file người dùng hàng loạt) — dùng
   thẳng Postgres tránh phải thêm 1 dịch vụ ngoài trả phí chỉ để lưu 1 ảnh.
   ============================================================ */
export const brandingSettings = pgTable("branding_settings", {
  id: varchar("id", { length: 32 }).primaryKey().default("default"),
  yearThemeImage: text("year_theme_image"), // data URL (base64), null = chưa cấu hình
  yearSlogan: varchar("year_slogan", { length: 160 }),
  themeYear: varchar("theme_year", { length: 8 }),
  themeSubtitle: varchar("theme_subtitle", { length: 160 }),
  updatedBy: varchar("updated_by", { length: 64 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============================================================
   DASHBOARD FOUNDATION — widget đọc metadata (field_definitions),
   chưa có trình kéo-thả, chỉ có cấu hình dạng danh sách tại
   /admin/dashboard.
   ============================================================ */
export const dashboardWidgets = pgTable("dashboard_widgets", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: varchar("title", { length: 160 }).notNull(),
  widgetType: varchar("widget_type", { length: 24 }).notNull().default("KPI"), // KPI | TABLE
  dataSource: varchar("data_source", { length: 40 }).notNull().default("daily_applications"),
  config: jsonb("config").$type<Record<string, unknown>>().default({}),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============================================================
   SCHEDULER FOUNDATION — danh sách job + lịch chạy (dạng mô tả),
   thực thi qua 1 endpoint được gọi bởi Vercel Cron (vercel.json)
   hoặc dịch vụ cron ngoài miễn phí — xem src/lib/scheduler.ts.
   ============================================================ */
export const scheduledJobs = pgTable("scheduled_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobKey: varchar("job_key", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 160 }).notNull(),
  schedule: varchar("schedule", { length: 60 }).notNull().default("daily"), // mô tả (daily/weekly/manual)
  handlerKey: varchar("handler_key", { length: 64 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: varchar("last_status", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Department = typeof departments.$inferSelect;
export type DwWorker = typeof dwData.$inferSelect;
export type DailyApplication = typeof dailyApplications.$inferSelect;
export type FormQuestion = typeof formQuestions.$inferSelect;
export type WorkerProfile = typeof workerProfiles.$inferSelect;
export type EmploymentSession = typeof employmentSessions.$inferSelect;
/* ============================================================
   DIGITAL WORKER FILE (Electronic Worker File, #10)
   ---------------------------------------------------------------
   Trước đây mỗi lần đăng ký (daily_applications) được coi như 1 "người".
   Từ bản này, MỖI NGƯỜI chỉ có DUY NHẤT 1 worker_profiles (khoá theo CCCD),
   tồn tại suốt vòng đời quan hệ lao động với công ty. Mỗi lần đăng ký/quay
   lại làm KHÔNG tạo người mới — chỉ tạo 1 employment_sessions gắn vào
   worker_profiles đã có. daily_applications VẪN GIỮ NGUYÊN cấu trúc cũ
   (không đổi nghiệp vụ, không mất dữ liệu) — worker_profiles/employment_
   sessions là lớp tổng hợp/lịch sử NẰM TRÊN daily_applications, không thay
   thế. Vì vậy nâng cấp này an toàn, chạy song song, và có thể backfill dữ
   liệu cũ bất cứ lúc nào qua /admin/worker-profiles (nút "Đồng bộ dữ liệu cũ").
   ============================================================ */
export const workerProfiles = pgTable(
  "worker_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cccd: varchar("cccd", { length: 20 }).notNull(),
    fullName: text("full_name").notNull(),
    gender: varchar("gender", { length: 16 }),
    dob: varchar("dob", { length: 32 }),
    phone: varchar("phone", { length: 20 }),
    permanentAddress: text("permanent_address"),
    residentialAddress: text("residential_address"),
    dwId: uuid("dw_id"), // liên kết tới dw_data nếu đã đối chiếu được (tham khảo, không ràng buộc FK cứng)
    // BIOMETRIC (#16) — quản lý mã vân tay: người cũ không cấp lại, người mới chờ HR cấp.
    fingerprintCode: varchar("fingerprint_code", { length: 64 }),
    fingerprintDevice: varchar("fingerprint_device", { length: 64 }),
    fingerprintStatus: varchar("fingerprint_status", { length: 24 }).default("CHUA_CAP"), // CHUA_CAP | DA_CAP | LOI
    fingerprintCreatedAt: timestamp("fingerprint_created_at", { withTimezone: true }),
    fingerprintLastUsedAt: timestamp("fingerprint_last_used_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: varchar("deleted_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("worker_profile_cccd_uq").on(t.cccd).where(sql`deleted_at is null`),
    check("worker_profiles_cccd_exact_12_chk", sql`${t.cccd} ~ '^[0-9]{12}$'`),
  ],
);

/**
 * 1 lần đăng ký / 1 đợt làm việc = 1 employment session, gắn vào đúng 1 worker_profiles.
 *
 * EMPLOYMENT LIFECYCLE (2026-08-16) — SOURCE OF TRUTH:
 *   - daily_applications        = LỊCH SỬ ĐĂNG KÝ/XIN VIỆC (không bao giờ overwrite/xoá).
 *   - employment_sessions       = LỊCH SỬ LÀM VIỆC THẬT (mỗi đợt làm 1 dòng; ai/ở đâu/từ ngày/đến ngày/vì sao nghỉ).
 *   - workforce_movements       = SỰ KIỆN nghỉ việc/thuyên chuyển đã được xác nhận.
 * Trạng thái "ĐANG LÀM" (ACTIVE) := status = 'APPROVED' AND end_date IS NULL.
 * INVARIANT bắt buộc: 1 worker chỉ có TỐI ĐA 1 session ACTIVE tại một thời điểm —
 * enforce bằng partial unique index `employment_session_one_active_uq` (lưới cuối cấp DB)
 * + kiểm tra transaction-safe ở lib/employment.ts (lớp chính).
 */
export const employmentSessions = pgTable(
  "employment_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workerId: uuid("worker_id").notNull(),
    dailyApplicationId: uuid("daily_application_id"), // liên kết bản ghi Daily Application gốc (nếu có)
    deptId: uuid("dept_id"),
    regDate: date("reg_date").notNull(),
    status: varchar("status", { length: 40 }).notNull().default("PENDING"), // đồng bộ với workflow_stages.stageKey
    startingDate: date("starting_date"),
    endDate: date("end_date"), // rời việc/kết thúc đợt làm (nếu có)
    // EMPLOYMENT LIFECYCLE — vì sao/ai/lúc nào kết thúc đợt làm việc (audit-able, không suy đoán từ status).
    endReason: varchar("end_reason", { length: 40 }), // RESIGNATION | TRANSFER | RECONCILIATION | OTHER
    endedBy: varchar("ended_by", { length: 64 }), // username người xác nhận kết thúc
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endMovementId: uuid("end_movement_id"), // -> workforce_movements.id (movement đã kết thúc session này)
    // Nguồn gốc starting_date: ASSIGNMENT (mặc định = ngày Recruiter xếp việc) | CORRECTION (Admin duyệt điều chỉnh) | IMPORT | RECONCILIATION
    startDateSource: varchar("start_date_source", { length: 24 }).default("ASSIGNMENT"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("employment_session_daily_app_uq").on(t.dailyApplicationId).where(sql`daily_application_id is not null`),
    // Already present in schema.sql; declare here too so Drizzle metadata matches production.
    index("employment_session_worker_idx").on(t.workerId),
    // INVARIANT #1 (Employment Lifecycle): 1 worker = tối đa 1 session ACTIVE. Đây là lưới an
    // toàn cấp DB cho race thật (double-click/retry/2 request đồng thời) — lớp chính là
    // transaction check trong lib/employment.ts. Migration chỉ tạo được index này khi dữ liệu
    // sạch — xem migrations/2026-08-16-employment-lifecycle.sql (audit trước, không auto-fix).
    uniqueIndex("employment_session_one_active_uq").on(t.workerId).where(sql`status = 'APPROVED' and end_date is null`),
  ],
);

/**
 * START DATE CORRECTION (Employment Lifecycle #11-12) — Recruiter KHÔNG được tự backdate
 * starting_date. Nếu thực tế nhận việc sớm hơn ngày thao tác: tạo yêu cầu điều chỉnh,
 * Admin duyệt qua Task Center. Giá trị cũ/mới + người duyệt được giữ lại làm audit trail.
 */
export const startDateCorrections = pgTable(
  "start_date_corrections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employmentSessionId: uuid("employment_session_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    currentStartDate: date("current_start_date"), // starting_date tại thời điểm yêu cầu (audit)
    requestedStartDate: date("requested_start_date").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    status: varchar("status", { length: 32 }).notNull().default("PENDING_ADMIN_APPROVAL"), // PENDING_ADMIN_APPROVAL | APPROVED | REJECTED
    requestedBy: varchar("requested_by", { length: 64 }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: varchar("decided_by", { length: 64 }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    // Audit sau khi APPROVE — không mất giá trị cũ.
    oldStartDate: date("old_start_date"),
    newStartDate: date("new_start_date"),
  },
  (t) => [
    // Idempotent: 1 session chỉ có 1 yêu cầu điều chỉnh đang chờ — retry/double-click không tạo trùng.
    uniqueIndex("start_date_correction_pending_uq").on(t.employmentSessionId).where(sql`status = 'PENDING_ADMIN_APPROVAL'`),
    index("start_date_correction_status_idx").on(t.status),
    index("start_date_correction_worker_idx").on(t.workerId),
  ],
);

/* ============================================================
   RBAC — DATA SCOPE (Phase 2, Step 1)
   ---------------------------------------------------------------
   Role (role_permissions/hasPermission) trả lời "được làm GÌ" — không đổi.
   Bảng này trả lời "được thao tác Ở ĐÂU": 1 user có thể được gán NHIỀU
   department (vd 1 Manager quản lý Packing A + Packing B + Packing C).
   users.deptId (cột cũ) VẪN GIỮ NGUYÊN làm dữ liệu nguồn di trú 1 lần
   (xem lib/seed.ts) và làm phương án dự phòng nếu 1 user chưa có dòng
   nào trong bảng này (không tự khoá ai khi mới nâng cấp).
   ============================================================ */
export const userDepartmentScopes = pgTable(
  "user_department_scopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    departmentId: uuid("department_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_dept_scope_uq").on(t.userId, t.departmentId)],
);

/* ============================================================
   WORKFORCE MOVEMENT (Phase 2, Step 3)
   ---------------------------------------------------------------
   1 bảng dùng chung cho Nghỉ việc (RESIGNATION) và Thuyên chuyển (TRANSFER)
   — đã xác nhận với người dùng (không tách 2 bảng riêng) vì 2 luồng chia sẻ
   phần lớn cột và Task Center/Timeline query đơn giản hơn khi gộp 1 bảng.
   `status` là 1 stageKey tham chiếu workflow_stages(entityType='resignation'
   hoặc 'transfer') — dùng chung Workflow Engine, không viết state machine riêng.
   ============================================================ */
export const workforceMovements = pgTable(
  "workforce_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    movementType: varchar("movement_type", { length: 24 }).notNull(), // RESIGNATION | TRANSFER
    workerId: uuid("worker_id").notNull(), // -> worker_profiles.id
    fromDeptId: uuid("from_dept_id"),
    toDeptId: uuid("to_dept_id"), // null nếu RESIGNATION
    effectiveDate: date("effective_date").notNull(),
    reason: text("reason"),
    note: text("note"),
    status: varchar("status", { length: 40 }).notNull().default("PENDING_HR"),
    relatedMovementId: uuid("related_movement_id"), // liên kết Transfer "Không đến" -> Resignation được sinh ra
    // EMPLOYMENT LIFECYCLE (#4) — truy vết đầy đủ: movement kết thúc ĐÚNG session nào, ai xác
    // nhận, lúc nào, đến từ nguồn nào (DEPT_REPORT | RECRUITER_CONFIRM | SELF_DECLARATION | RECONCILIATION | LEGACY).
    employmentSessionId: uuid("employment_session_id"), // -> employment_sessions.id
    confirmedBy: varchar("confirmed_by", { length: 64 }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    source: varchar("source", { length: 32 }),
    requestedBy: varchar("requested_by", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Existing production indexes from schema.sql; keep Drizzle metadata aligned.
    index("workforce_movement_worker_idx").on(t.workerId),
    index("workforce_movement_status_idx").on(t.status),
    index("workforce_movement_type_status_idx").on(t.movementType, t.status),
    // P1-2 (Production Hardening Audit) — lưới an toàn cấp DB chống SPAWN_RESIGNATION sinh
    // trùng (double-click/retry/race) — 1 movement (`relatedMovementId`) chỉ được sinh ra ĐÚNG
    // 1 resignation liên kết. Kiểm tra idempotent ở tầng transaction (lib/workforce-movements.ts)
    // là lớp chính; index này là lớp chốt cuối cho race thật giữa 2 request đồng thời.
    uniqueIndex("workforce_movement_spawn_resignation_uq")
      .on(t.relatedMovementId)
      .where(sql`movement_type = 'resignation' and related_movement_id is not null`),
    // EMPLOYMENT LIFECYCLE (#4) — tra cứu nhanh movement theo session (Worker Profile timeline).
    index("workforce_movement_session_idx").on(t.employmentSessionId),
  ],
);

/* ============================================================
   PLANNING (Phase 2, Step 4) — thay cho departments.dailyQuota (deprecated,
   xem cột dailyQuota ở departments: KHÔNG xoá, chỉ ngừng dùng ở UI/API mới).
   Quản lý theo GIAI ĐOẠN (start_date–end_date), có version (sửa 1 kế hoạch
   ACTIVE tạo bản ghi mới + đánh dấu supersededBy ở bản cũ, không UPDATE đè —
   giữ nguyên lịch sử). `section` dùng lại departments.groupName (đã xác nhận
   không tạo bảng sections riêng).
   ============================================================ */
export const planningPeriods = pgTable(
  "planning_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    departmentId: uuid("department_id").notNull(),
    section: varchar("section", { length: 120 }), // Section / groupName
    groupName: varchar("group_name", { length: 120 }),
    location: varchar("location", { length: 120 }),
    division: varchar("division", { length: 120 }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("DRAFT"), // DRAFT | ACTIVE | EXPIRED
    version: integer("version").notNull().default(1),
    requestType: varchar("request_type", { length: 24 }).notNull().default("ORIGINAL"), // ORIGINAL | SUPPLEMENT
    supplementIndex: integer("supplement_index").notNull().default(0), // 0: Gốc, 1: Bổ sung 1, 2: Bổ sung 2...
    parentPeriodId: uuid("parent_period_id"), // trỏ tới kế hoạch gốc nếu là bổ sung
    supersededBy: uuid("superseded_by"), // trỏ tới bản ghi version mới hơn (tự tham chiếu khi revise)
    // WORKFORCE REQUEST LINKAGE (mục 8) — liên kết ID rõ ràng tới Workforce Request;
    // KHÔNG match bằng text Department/Date. Khi có liên kết, KPI của Planning được
    // tính TỪ Workforce Request (source of truth), không tự tính riêng.
    // Ghi chú kỹ thuật: khai báo soft reference ở Drizzle (FK thật nằm trong SQL
    // migration planning_periods.request_id REFERENCES recruitment_requests) để tránh
    // vòng tham chiếu kiểu giữa planningPeriods ↔ recruitmentRequests.
    requestId: uuid("request_id"),
    createdBy: varchar("created_by", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("planning_dept_status_idx").on(t.departmentId, t.status),
    index("planning_parent_idx").on(t.parentPeriodId),
  ],
);

export const planningTargets = pgTable(
  "planning_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planningPeriodId: uuid("planning_period_id").notNull(),
    demandMale: integer("demand_male").notNull().default(0),
    demandFemale: integer("demand_female").notNull().default(0),
    targetCount: integer("target_count").notNull().default(0), // Tổng nhu cầu (= demandMale + demandFemale hoặc legacy)
    note: text("note"),
  },
  (t) => [uniqueIndex("planning_target_period_uq").on(t.planningPeriodId)],
);

export const planningAllocations = pgTable(
  "planning_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employmentSessionId: uuid("employment_session_id").notNull(),
    planningPeriodId: uuid("planning_period_id").notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
    allocatedBy: varchar("allocated_by", { length: 64 }).notNull(),

    /* --- VÒNG ĐỜI PHÂN BỔ (migration 2026-08-17) ------------------------
       Cho phép CHUYỂN phân bổ sang yêu cầu mới mà KHÔNG mất lịch sử.
       LƯU Ý NGHIỆP VỤ: đóng phân bổ (allocation_end_date) KHÔNG đồng nghĩa
       DW nghỉ việc. Chỉ workforce_movements RESIGNATION mới là nghỉ việc. */
    allocationStartDate: date("allocation_start_date"),
    allocationEndDate: date("allocation_end_date"),
    previousAllocationId: uuid("previous_allocation_id"),
    reallocatedBy: varchar("reallocated_by", { length: 64 }),
    reallocatedAt: timestamp("reallocated_at", { withTimezone: true }),
    recruitmentRequestId: uuid("recruitment_request_id"),
  },
  (t) => [
    index("planning_alloc_session_idx").on(t.employmentSessionId),
    index("planning_alloc_period_idx").on(t.planningPeriodId),
    // Unique CHỈ áp dụng cho phân bổ đang mở — lịch sử phân bổ đã đóng
    // được giữ lại đầy đủ (append-only).
    uniqueIndex("planning_alloc_active_uq")
      .on(t.employmentSessionId, t.planningPeriodId)
      .where(sql`allocation_end_date is null`),
    index("planning_alloc_request_idx").on(t.recruitmentRequestId),
  ],
);

/* ============================================================
   PLANNING COLUMN CONFIG (Yêu cầu #2)
   ---------------------------------------------------------------
   Cấu hình cột bảng Planning theo VAI TRÒ + THIẾT BỊ, do Admin quản lý.
   Danh mục cột gốc nằm ở src/lib/recruitment-request-columns.ts (thuần),
   bảng này CHỈ lưu bật/tắt, thứ tự và ghim — không hardcode trong UI,
   không chỉ lưu localStorage.
   ============================================================ */
export const planningColumnConfigs = pgTable(
  "planning_column_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    role: varchar("role", { length: 32 }).notNull(),
    device: varchar("device", { length: 16 }).notNull().default("desktop"), // desktop | mobile
    columnKey: varchar("column_key", { length: 64 }).notNull(),
    visible: boolean("visible").notNull().default(true),
    sticky: boolean("sticky").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedBy: varchar("updated_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_column_configs_uq").on(t.role, t.device, t.columnKey),
    index("planning_column_configs_role_idx").on(t.role, t.device),
  ],
);

/* ============================================================
   PLANNING TASKS (Yêu cầu #7 & #14)
   ---------------------------------------------------------------
   Task Center BỀN VỮNG cho Planning. Task Center cũ chỉ truy vấn trực
   tiếp nên không thể auto-DONE hay chống trùng khi cron chạy lại.

   PLANNING_REALLOCATION_REQUIRED: yêu cầu tuyển dụng đã hết hạn nhưng
   vẫn còn DW đang được phân bổ → Recruiter phải chuyển phân bổ sang
   yêu cầu mới. TUYỆT ĐỐI KHÔNG tự tạo nghỉ việc / ngày nghỉ / inactive.
   ============================================================ */
export const planningTasks = pgTable(
  "planning_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskType: varchar("task_type", { length: 48 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("OPEN"), // OPEN | IN_PROGRESS | DONE | DISMISSED
    recruitmentRequestId: uuid("recruitment_request_id"),
    planningPeriodId: uuid("planning_period_id"),
    departmentId: uuid("department_id"),
    title: text("title").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    dueDate: date("due_date"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: varchar("resolved_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // CHỐNG TRÙNG: cron/retry chạy bao nhiêu lần cũng chỉ 1 task đang mở
    // cho mỗi (task_type, recruitment_request_id).
    uniqueIndex("planning_tasks_open_uq")
      .on(t.taskType, t.recruitmentRequestId)
      .where(sql`status in ('OPEN', 'IN_PROGRESS')`),
    index("planning_tasks_status_idx").on(t.status, t.taskType),
    index("planning_tasks_dept_idx").on(t.departmentId),
  ],
);

/* ============================================================
   IMPORT ENGINE v2 (Enterprise redesign)
   ---------------------------------------------------------------
   Thay quy trình cũ (parse toàn bộ CSV thành JSON ở trình duyệt rồi gửi
   nhiều lô nhỏ) bằng: (1) upload nguyên file lên server, server đọc +
   nạp NHANH vào import_staging_rows bằng 1 câu lệnh bulk insert dùng
   UNNEST (nhiều nghìn dòng/1 round-trip — hiệu năng tương đương COPY,
   an toàn tham số hoá, không cần thư viện streaming ngoài); (2) sau đó
   "merge" từng LÔ NHỎ từ staging sang bảng chính, có thể gọi lại nhiều
   lần (resumable) — mỗi lô nằm trong 1 transaction riêng (rollback độc
   lập nếu lỗi), nên không bao giờ timeout dù file có 30.000+ dòng.
   ============================================================ */
export const importBatches = pgTable("import_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  importType: varchar("import_type", { length: 40 }).notNull(), // department | dw_data | daily_application
  fileName: varchar("file_name", { length: 255 }).notNull(),
  totalRows: integer("total_rows").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("STAGED"), // STAGED | MERGING | DONE | FAILED
  columnMapping: jsonb("column_mapping").$type<Record<string, string>>().default({}),
  processedCount: integer("processed_count").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  warningCount: integer("warning_count").notNull().default(0),
  startedBy: varchar("started_by", { length: 64 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const importStagingRows = pgTable(
  "import_staging_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    batchId: uuid("batch_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    rawData: jsonb("raw_data").$type<Record<string, string>>().notNull(),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"), // PENDING | INSERTED | UPDATED | DUPLICATE | ERROR
    message: text("message"),
  },
  (t) => [index("import_staging_batch_status_idx").on(t.batchId, t.status)],
);

/** @deprecated (Import Engine v3) — thay bằng import_jobs + staging_* (bên dưới). Giữ bảng cũ
 *  không xoá (không có ý nghĩa nghiệp vụ dài hạn, an toàn bỏ không dùng) để không mất lịch sử
 *  các lần import đã chạy bằng kiến trúc trước đó. */
export type ImportBatch = typeof importBatches.$inferSelect;
export type ImportStagingRow = typeof importStagingRows.$inferSelect;

/* ============================================================
   IMPORT ENGINE v3 — Job-based, Enterprise Architecture
   ---------------------------------------------------------------
   Thay hoàn toàn kiến trúc "xử lý trong 1 request" bằng:
     Upload → tạo Job (QUEUED) → nạp bulk vào bảng staging RIÊNG CHO TỪNG LOẠI
     (không phải 1 bảng jsonb dùng chung — để merge bằng SQL SET-BASED, không
     phải vòng lặp SELECT/INSERT từng dòng) → Worker tự "chain" (mỗi lần gọi xử
     lý 1 giai đoạn/1 lô, rồi tự kích hoạt lượt kế tiếp bằng Next.js `after()` —
     không cần trình duyệt giữ kết nối) → Cron watchdog phục hồi Job bị treo.

   ⚠️ GIỚI HẠN NỀN TẢNG (cần hiểu rõ): Vercel KHÔNG có worker nền thật (không có
   tiến trình chạy liên tục ngoài request/response — kể cả Cron cũng chỉ là 1
   serverless function được gọi theo lịch, vẫn bị giới hạn maxDuration như mọi
   request khác). Kiến trúc "self-chaining" dưới đây là cách tốt nhất đạt được
   trên Vercel+Neon mà KHÔNG thêm dịch vụ ngoài (QStash/Inngest/Trigger.dev) —
   Job không phụ thuộc vào 1 request cụ thể nào sống bao lâu, nhưng vẫn được
   thực thi qua chuỗi nhiều request ngắn, không phải 1 tiến trình nền thật sự.
   ============================================================ */
export const importJobs = pgTable("import_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobType: varchar("job_type", { length: 40 }).notNull(), // department | dw_data | daily_application
  fileName: varchar("file_name", { length: 255 }).notNull(),
  checksum: varchar("checksum", { length: 64 }), // SHA-256 nội dung file — phát hiện import trùng file
  status: varchar("status", { length: 20 }).notNull().default("QUEUED"), // QUEUED|RUNNING|PAUSED|DONE|FAILED|CANCELLED
  progress: integer("progress").notNull().default(0), // 0-100
  currentStage: varchar("current_stage", { length: 30 }).notNull().default("STAGING"),
  // STAGING → VALIDATING → MATCHING (chỉ daily_application) → MERGING → BUILDING_STATS → DONE
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  insertedRows: integer("inserted_rows").notNull().default(0),
  updatedRows: integer("updated_rows").notNull().default(0),
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  warningRows: integer("warning_rows").notNull().default(0),
  errorRows: integer("error_rows").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdBy: varchar("created_by", { length: 64 }).notNull(),
  resumeToken: uuid("resume_token").defaultRandom().notNull(), // xác thực lượt gọi worker đúng của job này
  lastError: text("last_error"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}), // mapping cột, cursor batch hiện tại, tốc độ...
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), // "heartbeat" cho watchdog phát hiện Job treo
});

export const importJobErrors = pgTable(
  "import_job_errors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    reason: text("reason").notNull(),
    originalData: jsonb("original_data").$type<Record<string, string>>().notNull(),
    severity: varchar("severity", { length: 10 }).notNull().default("ERROR"), // ERROR | WARNING
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("import_job_errors_job_idx").on(t.jobId, t.severity)],
);

/** Staging RIÊNG cho Department — cột có kiểu rõ ràng (không phải jsonb chung) để MERGING
 *  dùng được SQL set-based (INSERT...SELECT/JOIN) thay vì đọc jsonb từng dòng. */
export const stagingDepartment = pgTable(
  "staging_department",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    deptStt: integer("dept_stt"),
    deptName: text("dept_name"),
    groupName: text("group_name"),
    vnName: text("vn_name"),
    supervisor: text("supervisor"),
    supervisorPhone: text("supervisor_phone"),
    note: text("note"),
    valid: boolean("valid").notNull().default(true),
    invalidReason: text("invalid_reason"),
  },
  (t) => [index("staging_department_job_idx").on(t.jobId, t.valid)],
);

export const stagingDwData = pgTable(
  "staging_dw_data",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    code: text("code"),
    itCode: text("it_code"),
    oldDwCode: text("old_dw_code"),
    idVlookup: text("id_vlookup"),
    fullName: text("full_name"),
    gender: text("gender"),
    bod: text("bod"),
    profile: text("profile"),
    dktn: text("dktn"),
    cccd: text("cccd"),
    dateOfIssue: text("date_of_issue"),
    placeOfIssue: text("place_of_issue"),
    permanentAddress: text("permanent_address"),
    residentialAddress: text("residential_address"),
    phone: text("phone"),
    valid: boolean("valid").notNull().default(true),
    invalidReason: text("invalid_reason"),
  },
  (t) => [index("staging_dw_data_job_idx").on(t.jobId, t.valid), index("staging_dw_data_cccd_idx").on(t.jobId, t.cccd)],
);

export const stagingDailyApplication = pgTable(
  "staging_daily_application",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    cccd: text("cccd"),
    fullName: text("full_name"),
    gender: text("gender"),
    dob: text("dob"),
    age: text("age"),
    phone: text("phone"),
    ethnicity: text("ethnicity"),
    permanentAddress: text("permanent_address"),
    residentialAddress: text("residential_address"),
    declaredTypeRaw: text("declared_type_raw"),
    deptName: text("dept_name"),
    groupName: text("group_name"),
    workDuration: text("work_duration"),
    referralChannel: text("referral_channel"),
    startingDateRaw: text("starting_date_raw"), // giá trị GỐC từ file — giữ nguyên để hiện trong báo cáo lỗi
    startingDateParsed: text("starting_date_parsed"), // yyyy-MM-dd đã chuẩn hoá bằng date-parser.ts, hoặc NULL nếu không parse được
    appointmentList: text("appointment_list"),
    note: text("note"),
    vaccine: text("vaccine"),
    codeCheck: text("code_check"),
    itCode: text("it_code"),
    regDateRaw: text("reg_date_raw"), // giá trị GỐC từ file — giữ nguyên để hiện trong báo cáo lỗi
    regDateParsed: text("reg_date_parsed"), // ISO 8601 đã chuẩn hoá bằng date-parser.ts, hoặc NULL nếu không parse được
    customAnswers: jsonb("custom_answers").$type<Record<string, string>>().default({}),
    // Kết quả matching (set-based, đổ vào ở giai đoạn MATCHING trước khi MERGING) —
    // tránh phải SELECT dw_data / departments lặp lại ở giai đoạn MERGING.
    resolvedDwId: uuid("resolved_dw_id"),
    resolvedDwCode: text("resolved_dw_code"),
    resolvedDwMatch: varchar("resolved_dw_match", { length: 10 }),
    resolvedDeptId: uuid("resolved_dept_id"),
    valid: boolean("valid").notNull().default(true),
    invalidReason: text("invalid_reason"),
  },
  (t) => [index("staging_daily_app_job_idx").on(t.jobId, t.valid), index("staging_daily_app_cccd_idx").on(t.jobId, t.cccd)],
);

export type ImportJob = typeof importJobs.$inferSelect;
export type ImportJobError = typeof importJobErrors.$inferSelect;

export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type FieldDefinition = typeof fieldDefinitions.$inferSelect;
export type WorkflowStage = typeof workflowStages.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type UserDepartmentScope = typeof userDepartmentScopes.$inferSelect;
export type WorkforceMovement = typeof workforceMovements.$inferSelect;
export type PlanningPeriod = typeof planningPeriods.$inferSelect;
export type PlanningTarget = typeof planningTargets.$inferSelect;
export type PlanningAllocation = typeof planningAllocations.$inferSelect;

/* ============================================================
   WORKFORCE RECRUITMENT REQUEST PLANNING (Phase 3)
   ---------------------------------------------------------------
   Mở rộng module Planning (Nhu cầu) thành Workforce Recruitment
   Request Planning, tích hợp với planning_periods, planning_targets,
   planning_allocations, Daily Application, Employment Session và
   Workforce Movement.
   Bảng này lưu chi tiết từng yêu cầu tuyển dụng (import từ Excel/
   Google Sheets) với header alias mapping linh hoạt, preview và
   validation trước import.
   ============================================================ */
export const recruitmentRequests = pgTable(
  "recruitment_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planningPeriodId: uuid("planning_period_id").references(() => planningPeriods.id, { onDelete: "set null" }),
    requestCode: varchar("request_code", { length: 80 }).notNull(),
    requester: varchar("requester", { length: 160 }).notNull().default(""),
    position: varchar("position", { length: 160 }),
    jobTitle: varchar("job_title", { length: 255 }),
    location: varchar("location", { length: 120 }),
    section: varchar("section", { length: 120 }),
    groupName: varchar("group_name", { length: 120 }),
    division: varchar("division", { length: 120 }),
    department: varchar("department", { length: 255 }),
    reason: text("reason"),
    noteForReason: text("note_for_reason"),
    specialRequirements: text("special_requirements"),
    maleRq: integer("male_rq").notNull().default(0),
    femaleRq: integer("female_rq").notNull().default(0),
    maleApplication: integer("male_application").notNull().default(0),
    femaleApplication: integer("female_application").notNull().default(0),
    maleInterviewed: integer("male_interviewed").notNull().default(0),
    femaleInterviewed: integer("female_interviewed").notNull().default(0),
    maleRecruited: integer("male_recruited").notNull().default(0),
    femaleRecruited: integer("female_recruited").notNull().default(0),
    maleQuit: integer("male_quit").notNull().default(0),
    femaleQuit: integer("female_quit").notNull().default(0),
    maleBalance: integer("male_balance").notNull().default(0),
    femaleBalance: integer("female_balance").notNull().default(0),
    totalBalance: integer("total_balance").notNull().default(0),

    /* --- SNAPSHOT TẠI THỜI ĐIỂM MỞ REQUEST (Workforce Recruitment Request
       Planning upgrade) ---------------------------------------------------
       CỐ ĐỊNH — không recompute lại mỗi lần refresh. Chỉ được ghi MỘT LẦN khi
       Request được tạo (import lần đầu hoặc POST); import lại cùng Request
       Code KHÔNG được overwrite. Chỉ Admin explicit correction mới sửa được.
       Dùng làm đầu vào công thức Recruitment Balance:
         Balance = max(0, Rq − CurrentAtStart + QuitDuringRequest)
       PHÂN BIỆT với Realtime Gap = max(0, Rq − Current Workforce NOW), là
       KPI tính live, KHÔNG lưu cột riêng — xem src/lib/recruitment-kpi.ts. */
    maleCurrentAtStart: integer("male_current_at_start").notNull().default(0),
    femaleCurrentAtStart: integer("female_current_at_start").notNull().default(0),
    totalCurrentAtStart: integer("total_current_at_start").notNull().default(0),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),

    // PENDING | PROCESSING | COMPLETED | CANCELLED | EXPIRED
    // EXPIRED TÁCH BIỆT với CANCELLED: quá End Date KHÔNG BAO GIỜ tự thành CANCELLED.
    status: varchar("status", { length: 24 }).notNull().default("PENDING"),

    /* --- SÁU TRƯỜNG NGÀY TÁCH BIỆT (Yêu cầu #6) ------------------------
       requestedDate  Ngày yêu cầu
       expectedDate   Ngày cần nhân lực   ← mốc SẮP XẾP MẶC ĐỊNH
       startingDate   Ngày nhận việc
       endDate        Ngày kết thúc yêu cầu (hết hạn ≠ DW nghỉ việc)
       offeredDate    Ngày đề nghị
       completedDate  Ngày tuyển đủ                                     */
    requestedDate: date("requested_date"),
    expectedDate: date("expected_date"),
    startingDate: date("starting_date"),
    endDate: date("end_date"),
    offeredDate: date("offered_date"),
    completedDate: date("completed_date"),
    /** DERIVED: offeredDate − requestedDate (số ngày). */
    offeredVsRequested: integer("offered_vs_requested"),
    /** DERIVED: completedDate − requestedDate (số ngày). */
    completedVsRequested: integer("completed_vs_requested"),

    month: varchar("month", { length: 10 }),
    cost: integer("cost").notNull().default(0),
    remarks: text("remarks"),
    to: varchar("to", { length: 160 }),
    rqStatus: varchar("rq_status", { length: 40 }),
    monthRc: varchar("month_rc", { length: 10 }),
    totalRequest: integer("total_request").notNull().default(0),
    recruitedVsExpected: integer("recruited_vs_expected").notNull().default(0),
    screened: integer("screened").notNull().default(0),
    interview: integer("interview").notNull().default(0),
    recruit: integer("recruit").notNull().default(0),
    departmentText: varchar("department_text", { length: 255 }),
    monthReport: varchar("month_report", { length: 10 }),

    /** FK thật tới departments.id — khoá lọc Data Scope phía server.
     *  Cột text `department` chỉ dùng để hiển thị/import từ Excel. */
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),

    /* --- CHUỖI LỊCH SỬ APPEND-ONLY (Yêu cầu #4) ------------------------
       Không bao giờ ghi đè/xoá yêu cầu cũ; yêu cầu mới nối vào chuỗi. */
    previousRequestId: uuid("previous_request_id"),
    supersedesRequestId: uuid("supersedes_request_id"),

    createdBy: varchar("created_by", { length: 64 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: varchar("deleted_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("recruitment_requests_code_uq").on(t.requestCode).where(sql`deleted_at is null`),
    index("recruitment_requests_period_idx").on(t.planningPeriodId),
    index("recruitment_requests_status_idx").on(t.status),
    index("recruitment_requests_month_idx").on(t.month),
    index("recruitment_requests_location_idx").on(t.location),
    index("recruitment_requests_division_idx").on(t.division),
    index("recruitment_requests_dept_idx").on(t.department),
    index("recruitment_requests_section_idx").on(t.section),
    index("recruitment_requests_group_idx").on(t.groupName),
    index("recruitment_requests_requester_idx").on(t.requester),
    index("recruitment_requests_department_id_idx").on(t.departmentId),
    index("recruitment_requests_previous_idx").on(t.previousRequestId),
    index("recruitment_requests_supersedes_idx").on(t.supersedesRequestId),
    index("recruitment_requests_expected_date_idx")
      .on(t.expectedDate)
      .where(sql`deleted_at is null`),
    index("recruitment_requests_end_date_idx")
      .on(t.endDate)
      .where(sql`deleted_at is null`),
  ],
);

export type PlanningColumnConfig = typeof planningColumnConfigs.$inferSelect;
export type PlanningTask = typeof planningTasks.$inferSelect;
export type NewPlanningTask = typeof planningTasks.$inferInsert;

export type RecruitmentRequest = typeof recruitmentRequests.$inferSelect;
export type NewRecruitmentRequest = typeof recruitmentRequests.$inferInsert;

/* ============================================================
   WORKFORCE REQUEST LINKAGE (Phase 4)
   ------------------------------------------------------------
   Architecture: Workforce Request ↔ Planning ↔ Employment/Allocation.
   Bảng dưới đây là LỚP ALLOCATION CỦA WORKFORCE REQUEST:
     - request_allocations:        1 ACTIVE worker → 1 ACTIVE request
                                   allocation (source of truth "worker đang
                                   được tính vào request nào").
     - request_allocation_history:  audit mọi thay đổi allocation (mục 15).
     - request_allocation_overrides: log RIÊNG cho override vượt tổng
                                   nhu cầu (mục 6 + 15).
     - request_comments:            bình luận của Dept Manager (mục 11).
     - request_kpi_cache:           cache KPI có timestamp + recompute job
                                   (mục 9) — KHÔNG phải source of truth.
   ============================================================ */
export const requestAllocations = pgTable(
  "request_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employmentSessionId: uuid("employment_session_id").notNull(), // tham chiếu mềm tới employment_sessions
    workerId: uuid("worker_id").notNull(), // denormalized — để chốt unique theo WORKER
    requestId: uuid("request_id").notNull(), // tham chiếu mềm tới recruitment_requests
    status: varchar("status", { length: 16 }).notNull().default("ACTIVE"), // ACTIVE | ENDED
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    allocatedBy: varchar("allocated_by", { length: 64 }).notNull(),
    endedBy: varchar("ended_by", { length: 64 }),
    endReason: text("end_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // CHỐT DB (mục 4): 1 worker tối đa 1 ACTIVE request allocation tại 1 thời điểm.
    // Lớp cuối chống double-click/race sau khi transaction đã kiểm tra logic.
    uniqueIndex("request_alloc_one_active_per_worker_uq").on(t.workerId).where(sql`status = 'ACTIVE'`),
    index("request_alloc_request_status_idx").on(t.requestId, t.status),
    index("request_alloc_session_idx").on(t.employmentSessionId),
    index("request_alloc_worker_idx").on(t.workerId),
  ],
);

export const requestAllocationHistory = pgTable(
  "request_allocation_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id").notNull(), // request liên quan (to trước, from nếu END)
    workerId: uuid("worker_id").notNull(),
    employmentSessionId: uuid("employment_session_id"),
    fromRequestId: uuid("from_request_id"),
    toRequestId: uuid("to_request_id"),
    action: varchar("action", { length: 24 }).notNull(), // ALLOCATE | REALLOCATE | END | OVERRIDE
    reason: text("reason"),
    overrideConfirmed: boolean("override_confirmed").notNull().default(false),
    changedBy: varchar("changed_by", { length: 64 }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("request_alloc_history_request_idx").on(t.requestId, t.changedAt),
    index("request_alloc_history_worker_idx").on(t.workerId, t.changedAt),
    index("request_alloc_history_from_idx").on(t.fromRequestId),
    index("request_alloc_history_to_idx").on(t.toRequestId),
  ],
);

export const requestAllocationOverrides = pgTable(
  "request_allocation_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    changedBy: varchar("changed_by", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    confirmed: boolean("confirmed").notNull().default(true),
    currentTotal: integer("current_total").notNull().default(0), // tổng hiện có tại thời điểm override
    totalRequest: integer("total_request").notNull().default(0), // tổng nhu cầu
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("request_override_request_idx").on(t.requestId, t.createdAt)],
);

export const requestComments = pgTable(
  "request_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id").notNull(),
    userId: uuid("user_id"),
    username: varchar("username", { length: 64 }).notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("request_comment_request_idx").on(t.requestId, t.createdAt)],
);

export const requestKpiCache = pgTable(
  "request_kpi_cache",
  {
    requestId: uuid("request_id").primaryKey(),
    asOfDate: date("as_of_date").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("request_kpi_cache_computed_idx").on(t.computedAt)],
);

export type RequestAllocation = typeof requestAllocations.$inferSelect;
export type NewRequestAllocation = typeof requestAllocations.$inferInsert;
export type RequestAllocationHistory = typeof requestAllocationHistory.$inferSelect;
export type RequestAllocationOverride = typeof requestAllocationOverrides.$inferSelect;
export type RequestComment = typeof requestComments.$inferSelect;
export type RequestKpiCache = typeof requestKpiCache.$inferSelect;

/* ============================================================
   DOCUMENT MERGE ENGINE
   Generic Document Merge Center - cho phép Admin tạo Google Docs template,
   quản lý placeholders, map với dữ liệu hệ thống và merge hồ sơ thành Google Docs.
   ============================================================ */

export const mergeTemplates = pgTable(
  "merge_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    googleDocId: varchar("google_doc_id", { length: 120 }).notNull(),
    outputFolderId: varchar("output_folder_id", { length: 120 }),
    outputFileNamePattern: varchar("output_file_name_pattern", { length: 255 }),
    defaultMergeMode: varchar("default_merge_mode", { length: 24 }).notNull().default("ONE_DOCUMENT"),
    dataSources: jsonb("data_sources").$type<string[]>().default([]),
    // A = Cam kết / Tái ký (DW Cũ); B = Hợp đồng đào tạo nghề (DW Mới); GENERIC = dùng chung
    documentKind: varchar("document_kind", { length: 16 }).notNull().default("GENERIC"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: varchar("created_by", { length: 64 }).notNull(),
    updatedBy: varchar("updated_by", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merge_template_active_idx").on(t.isActive),
    index("merge_template_google_doc_idx").on(t.googleDocId),
  ],
);

export const mergeTemplateFields = pgTable(
  "merge_template_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id").notNull(),
    placeholder: varchar("placeholder", { length: 255 }).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull().default("CORE_FIELD"),
    sourceEntity: varchar("source_entity", { length: 64 }),
    sourceField: varchar("source_field", { length: 128 }),
    sourcePath: varchar("source_path", { length: 255 }),
    optionValue: varchar("option_value", { length: 255 }),
    formatType: varchar("format_type", { length: 32 }),
    fallbackValue: text("fallback_value"),
    isRequired: boolean("is_required").notNull().default(false),
    isOrphaned: boolean("is_orphaned").notNull().default(false),
    isSuggested: boolean("is_suggested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("merge_template_field_uq").on(t.templateId, t.placeholder),
    index("merge_template_field_template_idx").on(t.templateId),
  ],
);

export const mergeJobs = pgTable(
  "merge_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id"),
    templateNameSnapshot: varchar("template_name_snapshot", { length: 255 }).notNull().default(""),
    mergeMode: varchar("merge_mode", { length: 24 }).notNull().default("ONE_DOCUMENT"),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"),
    recordCount: integer("record_count").notNull().default(0),
    outputDocId: varchar("output_doc_id", { length: 120 }),
    outputUrl: text("output_url"),
    createdBy: varchar("created_by", { length: 64 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // --- ASYNC PDF ENGINE (migration 2026-08-20) -----------------------------
    // engine = GOOGLE_DOCS (legacy fallback) | HTML_PDF (Playwright renderer).
    // Neon chỉ lưu metadata/job/progress/URL — KHÔNG lưu PDF binary.
    engine: varchar("engine", { length: 16 }).notNull().default("GOOGLE_DOCS"),
    queuedCount: integer("queued_count").notNull().default(0),
    processingCount: integer("processing_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    progressPercent: integer("progress_percent").notNull().default(0),
    outputPdfUrl: text("output_pdf_url"),
    outputZipUrl: text("output_zip_url"),
    errorSummary: text("error_summary"),
  },
  (t) => [
    index("merge_job_status_idx").on(t.status),
    index("merge_job_created_by_idx").on(t.createdBy),
    index("merge_job_template_idx").on(t.templateId),
    index("merge_job_created_at_idx").on(t.createdAt),
    index("merge_job_status_updated_idx").on(t.status, t.updatedAt),
  ],
);

export const mergeJobRecords = pgTable(
  "merge_job_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mergeJobId: uuid("merge_job_id").notNull(),
    sourceEntity: varchar("source_entity", { length: 64 }).notNull(),
    sourceRecordId: uuid("source_record_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // --- ASYNC PDF ENGINE (migration 2026-08-20) -----------------------------
    // Bảng này CHÍNH LÀ bảng "item" của async queue (không tạo bảng trùng).
    // sort_order = sequence (thứ tự user chọn, source of truth khi gộp PDF).
    // template_id = template áp dụng cho record này (auto-route A/B có thể khác nhau/record).
    templateId: uuid("template_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    pdfUrl: text("pdf_url"),
    storageKey: text("storage_key"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
  },
  (t) => [
    index("merge_job_record_job_idx").on(t.mergeJobId),
    index("merge_job_record_source_idx").on(t.sourceEntity, t.sourceRecordId),
    index("merge_job_record_claim_idx")
      .on(t.mergeJobId, t.status, t.sortOrder)
      .where(sql`status IN ('QUEUED', 'RETRY')`),
  ],
);

// Type exports
export type MergeTemplate = typeof mergeTemplates.$inferSelect;
export type MergeTemplateField = typeof mergeTemplateFields.$inferSelect;
export type MergeJob = typeof mergeJobs.$inferSelect;
export type MergeJobRecord = typeof mergeJobRecords.$inferSelect;
