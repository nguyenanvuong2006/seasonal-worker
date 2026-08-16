/* ============================================================
   PLANNING / RECRUITMENT REQUEST — PURE CORE
   ------------------------------------------------------------
   Không import "server-only", không đụng DB → chạy được trong
   unit test, ở server và ở client.

   Chứa các quy tắc nghiệp vụ BẤT BIẾN của module Planning:
     * Công thức Balance (Yêu cầu #10)
     * Chênh lệch ngày Offered/Completed vs Requested (Yêu cầu #1)
     * Sắp xếp MẶC ĐỊNH theo Expected Date + nhóm Quá hạn (Yêu cầu #5)
     * Tách bạch "yêu cầu hết hạn" và "DW nghỉ việc" (Yêu cầu #9)
     * Chặn Excel ghi đè cột hệ thống (Yêu cầu #10)
   ============================================================ */

// Import tương đối + đuôi .ts để `node --test` chạy trực tiếp được file này
// (đây là quy ước sẵn có của repo cho các module thuần, xem src/lib/ai/*).
import { SYSTEM_OWNED_COLUMN_KEYS, COLUMN_BY_KEY } from "./recruitment-request-columns.ts";

/* ============================================================
   1. TRẠNG THÁI
   ============================================================ */
export const REQUEST_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED", "EXPIRED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Trạng thái coi là "còn đang chạy" — vẫn cần theo dõi tiến độ tuyển. */
export const OPEN_STATUSES: RequestStatus[] = ["PENDING", "PROCESSING"];

/** Trạng thái kết thúc — không sinh Task, không tính là quá hạn. */
export const TERMINAL_STATUSES: RequestStatus[] = ["COMPLETED", "CANCELLED"];

export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as string[]).includes(status);
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status);
}

/**
 * Chuẩn hoá Status từ Excel. Hỗ trợ EXPIRED.
 *
 * QUY TẮC CỨNG (Yêu cầu #13): EXPIRED và CANCELLED là HAI trạng thái khác
 * nhau. Quá End Date KHÔNG BAO GIỜ tự động trở thành CANCELLED — hàm này
 * không bao giờ suy diễn CANCELLED từ việc hết hạn.
 */
export function normalizeRequestStatus(s: string | undefined | null): RequestStatus | null {
  if (!s || !String(s).trim()) return null;
  const upper = String(s).trim().toUpperCase();
  if ((REQUEST_STATUSES as readonly string[]).includes(upper)) return upper as RequestStatus;
  if (upper.includes("EXPIRE") || upper.includes("HET HAN") || upper.includes("HẾT HẠN")) return "EXPIRED";
  if (upper.includes("CANCEL") || upper.includes("HUY") || upper.includes("HUỶ")) return "CANCELLED";
  if (upper.includes("COMPLETE") || upper.includes("DONE")) return "COMPLETED";
  if (upper.includes("PROCESS") || upper.includes("PROGRESS")) return "PROCESSING";
  if (upper.includes("PEND")) return "PENDING";
  return null;
}

/* ============================================================
   2. BALANCE (Yêu cầu #10 + PHASE 6 double-count fix)
   ------------------------------------------------------------
   Male Balance   = max(0, Male Rq − Male Recruited/Allocated)
   Female Balance = max(0, Female Rq − Female Recruited/Allocated)
   Total Balance  = Male Balance + Female Balance

   LÝ DO ĐỔI (PHASE 6 audit): Công thức cũ cộng thêm `Quit` đã double-count
   khi worker nghỉ — vì worker nghỉ đã bị loại khỏi "Recruited/Allocated" rồi
   (qua workforce_movement RESIGNATION set employment_session.end_date). Test
   bắt buộc: Rq=10, Current-before=10, 1 quit → Current=9, Quit=1 → Balance
   cũ = 10 − 9 + 1 = 2 (SAI); Balance mới = max(0, 10 − 9) = 1 (ĐÚNG).
   `Quit` vẫn được lưu như historical KPI riêng (attrition reporting), KHÔNG
   cộng vào nhu cầu tuyển mới.

   Clamp về 0: phân bổ vượt nhu cầu thì "còn thiếu" = 0, không âm.
   Đây là công thức DUY NHẤT trong hệ thống — mọi nơi khác phải gọi vào đây.
   ============================================================ */
export type BalanceInput = {
  maleRq: number;
  femaleRq: number;
  maleRecruited: number;
  femaleRecruited: number;
  /** Nhận nhưng KHÔNG dùng trong công thức — giữ để không phá call-site cũ. */
  maleQuit?: number;
  femaleQuit?: number;
};

export type BalanceResult = {
  maleBalance: number;
  femaleBalance: number;
  totalBalance: number;
};

export function computeBalance(input: BalanceInput): BalanceResult {
  const n = (v: number) => (Number.isFinite(v) ? Math.trunc(v) : 0);
  const maleBalance = Math.max(0, n(input.maleRq) - n(input.maleRecruited));
  const femaleBalance = Math.max(0, n(input.femaleRq) - n(input.femaleRecruited));
  return { maleBalance, femaleBalance, totalBalance: maleBalance + femaleBalance };
}

/** Tổng yêu cầu = Nam yêu cầu + Nữ yêu cầu (DERIVED, không nhận từ Excel). */
export function computeTotalRequest(maleRq: number, femaleRq: number): number {
  return Math.max(0, Math.trunc(maleRq || 0)) + Math.max(0, Math.trunc(femaleRq || 0));
}

/** % hoàn thành = round(đã tuyển / tổng yêu cầu × 100). Không giới hạn trần 100
 *  để Recruiter thấy được trường hợp tuyển vượt. */
export function computeRecruitedVsExpected(
  maleRecruited: number,
  femaleRecruited: number,
  totalRequest: number,
): number {
  if (!totalRequest || totalRequest <= 0) return 0;
  const recruited = Math.max(0, Math.trunc(maleRecruited || 0)) + Math.max(0, Math.trunc(femaleRecruited || 0));
  return Math.round((recruited / totalRequest) * 100);
}

/* ============================================================
   3. CHÊNH LỆCH NGÀY (Yêu cầu #1)
   ============================================================ */
const MS_PER_DAY = 86_400_000;

/** Số ngày giữa hai mốc yyyy-MM-dd. null nếu thiếu một trong hai. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

export type DateDeltas = {
  offeredVsRequested: number | null;
  completedVsRequested: number | null;
};

export function computeDateDeltas(row: {
  requestedDate?: string | null;
  offeredDate?: string | null;
  completedDate?: string | null;
}): DateDeltas {
  return {
    offeredVsRequested: daysBetween(row.requestedDate, row.offeredDate),
    completedVsRequested: daysBetween(row.requestedDate, row.completedDate),
  };
}

/* ============================================================
   4. HẾT HẠN — KHÔNG PHẢI NGHỈ VIỆC (Yêu cầu #7, #9, #13)
   ============================================================ */

/**
 * Yêu cầu đã quá hạn chưa?
 *
 * QUY TẮC CỨNG: "hết hạn" CHỈ có nghĩa yêu cầu tuyển dụng không còn hiệu lực.
 * Nó KHÔNG:
 *   - làm DW nghỉ việc,
 *   - ghi quit date,
 *   - đặt cờ inactive,
 *   - chuyển trạng thái sang CANCELLED.
 * Chỉ workforce_movements loại RESIGNATION mới là nghỉ việc thật.
 */
export function isRequestExpired(
  row: { endDate?: string | null; status: string },
  today: string,
): boolean {
  if (isTerminalStatus(row.status)) return false;
  if (!row.endDate) return false;
  return row.endDate < today;
}

/** Yêu cầu quá hạn NHƯNG chưa tuyển đủ → phải nổi lên đầu bảng. */
export function isOverdueIncomplete(
  row: { expectedDate?: string | null; status: string; totalBalance?: number | null },
  today: string,
): boolean {
  if (isTerminalStatus(row.status)) return false;
  if (!row.expectedDate) return false;
  if (row.expectedDate >= today) return false;
  // Còn thiếu người → thật sự cần xử lý.
  return (row.totalBalance ?? 0) > 0;
}

/* ============================================================
   5. SẮP XẾP MẶC ĐỊNH THEO EXPECTED DATE (Yêu cầu #5)
   ------------------------------------------------------------
   Thứ tự nhóm:
     0 = Quá hạn / Cần xử lý  (Expected Date < hôm nay, chưa tuyển đủ)
     1 = Sắp tới              (Expected Date >= hôm nay)
     2 = Không có Expected Date
   Trong từng nhóm: Expected Date GẦN NHẤT → XA NHẤT.

   TUYỆT ĐỐI KHÔNG sắp theo ngày kết thúc mùa vụ.
   ============================================================ */
export const SORT_BUCKET_OVERDUE = 0;
export const SORT_BUCKET_UPCOMING = 1;
export const SORT_BUCKET_UNDATED = 2;

export type SortableRequest = {
  expectedDate?: string | null;
  status: string;
  totalBalance?: number | null;
  requestCode?: string | null;
};

export function expectedDateBucket(row: SortableRequest, today: string): number {
  if (!row.expectedDate) return SORT_BUCKET_UNDATED;
  if (isOverdueIncomplete(row, today)) return SORT_BUCKET_OVERDUE;
  return SORT_BUCKET_UPCOMING;
}

/** Nhãn nhóm hiển thị trên UI. */
export function bucketLabel(bucket: number): string {
  if (bucket === SORT_BUCKET_OVERDUE) return "Quá hạn / Cần xử lý";
  if (bucket === SORT_BUCKET_UPCOMING) return "Sắp tới";
  return "Chưa có ngày cần nhân lực";
}

/**
 * So sánh MẶC ĐỊNH của bảng Planning.
 * Dùng cho cả sort phía client và kiểm chứng kết quả sort phía server.
 */
export function compareByExpectedDate(a: SortableRequest, b: SortableRequest, today: string): number {
  const ba = expectedDateBucket(a, today);
  const bb = expectedDateBucket(b, today);
  if (ba !== bb) return ba - bb;

  // Trong cùng nhóm: gần nhất trước. Nhóm "quá hạn" cũng vậy — quá hạn lâu
  // nhất (ngày nhỏ nhất) đứng trên cùng vì cấp bách nhất.
  const da = a.expectedDate ?? "";
  const db = b.expectedDate ?? "";
  if (da !== db) return da < db ? -1 : 1;

  return (a.requestCode ?? "").localeCompare(b.requestCode ?? "");
}

/** Sắp xếp mặc định danh sách yêu cầu (không đột biến mảng gốc). */
export function sortByExpectedDate<T extends SortableRequest>(rows: T[], today: string): T[] {
  return [...rows].sort((a, b) => compareByExpectedDate(a, b, today));
}

/* ============================================================
   6. BẢO VỆ CỘT HỆ THỐNG KHỎI IMPORT EXCEL (Yêu cầu #10)
   ============================================================ */

export type StripResult<T> = {
  /** Payload đã loại bỏ mọi cột hệ thống. */
  safe: T;
  /** Các cột bị Excel cố ghi đè — báo lại cho người import biết. */
  rejected: string[];
};

/**
 * Loại bỏ mọi cột SYSTEM/DERIVED khỏi payload import/patch.
 *
 * Excel KHÔNG BAO GIỜ được ghi đè giá trị mà hệ thống đã có nguồn thật
 * (Daily Application, Employment Session, planning_allocations,
 * workforce_movements) hoặc giá trị tính theo công thức (Balance, ratio).
 */
export function stripSystemOwnedFields<T extends Record<string, unknown>>(payload: T): StripResult<Partial<T>> {
  const safe: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (SYSTEM_OWNED_COLUMN_KEYS.includes(key)) {
      if (value !== undefined && value !== null && value !== "") rejected.push(key);
      continue;
    }
    safe[key] = value;
  }
  return { safe: safe as Partial<T>, rejected };
}

/** Vai trò chỉ-đọc có được sửa cột này không (Yêu cầu #3). */
export function canEditColumn(columnKey: string, opts: { readOnlyRole: boolean }): boolean {
  if (opts.readOnlyRole) return false;
  const col = COLUMN_BY_KEY[columnKey];
  if (!col) return false;
  return col.source === "INPUT";
}

/* ============================================================
   7. TÁI PHÂN BỔ — QUY TẮC KIỂM TRA (Yêu cầu #8)
   ============================================================ */
export type ReallocationCheckInput = {
  fromRequestId: string;
  toRequestId: string;
  allocationIds: string[];
};

export type ReallocationCheck = { ok: true } | { ok: false; error: string };

export const MAX_REALLOCATION_BATCH = 500;

export function validateReallocationInput(input: ReallocationCheckInput): ReallocationCheck {
  if (!input.fromRequestId || !input.toRequestId) {
    return { ok: false, error: "Thiếu yêu cầu nguồn hoặc yêu cầu đích." };
  }
  if (input.fromRequestId === input.toRequestId) {
    return { ok: false, error: "Yêu cầu đích phải khác yêu cầu nguồn." };
  }
  if (!Array.isArray(input.allocationIds) || input.allocationIds.length === 0) {
    return { ok: false, error: "Chưa chọn DW nào để chuyển phân bổ." };
  }
  if (input.allocationIds.length > MAX_REALLOCATION_BATCH) {
    return { ok: false, error: `Tối đa ${MAX_REALLOCATION_BATCH} DW mỗi lần chuyển.` };
  }
  const unique = new Set(input.allocationIds);
  if (unique.size !== input.allocationIds.length) {
    return { ok: false, error: "Danh sách DW bị trùng." };
  }
  return { ok: true };
}

/* ============================================================
   8. TASK CENTER (Yêu cầu #14)
   ============================================================ */
export const TASK_PLANNING_REALLOCATION_REQUIRED = "PLANNING_REALLOCATION_REQUIRED";

export function buildReallocationTaskTitle(requestCode: string): string {
  return `Yêu cầu nhân lực ${requestCode} đã hết hạn — cần xác nhận phân bổ DW sang yêu cầu mới.`;
}

/**
 * Task tái phân bổ đã có thể đóng chưa?
 * Đóng khi KHÔNG còn phân bổ nào đang mở trên yêu cầu hết hạn — tức mọi DW
 * đã được chuyển sang yêu cầu khác hoặc đã được xử lý bằng nghiệp vụ khác
 * (nghỉ việc THẬT qua Workforce Movement, thuyên chuyển...).
 */
export function shouldAutoCloseReallocationTask(openAllocationCount: number): boolean {
  return openAllocationCount <= 0;
}
