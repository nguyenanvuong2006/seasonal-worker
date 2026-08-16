import assert from "node:assert/strict";
import test from "node:test";

/**
 * EMPLOYMENT LIFECYCLE — kiểm chứng invariant "1 worker = tối đa 1 ACTIVE session" ở mức
 * mô hình transaction (synthetic, DB-agnostic) — cùng phong cách registration-persistence.test.ts.
 * Production dùng db.transaction() + SELECT..FOR UPDATE + partial unique index; ở đây mô phỏng
 * store in-memory có "unique index" để chứng minh:
 *   - double-click/retry không tạo 2 ACTIVE (idempotent);
 *   - confirm resignation + assign mới là atomic: A ENDED trước khi B ACTIVE;
 *   - lỗi giữa chừng rollback toàn bộ.
 */

type SessionRow = {
  id: string;
  workerId: string;
  status: string;
  endDate: string | null;
  deptId: string | null;
  startingDate: string | null;
  endReason: string | null;
};

class UniqueActiveViolation extends Error {
  constructor() {
    super("duplicate key value violates unique constraint \"employment_session_one_active_uq\"");
  }
}

/** Store mô phỏng bảng employment_sessions + partial unique index + transaction/rollback. */
function makeStore(initial: SessionRow[]) {
  let committed = initial.map((r) => ({ ...r }));

  function assertInvariant(rows: SessionRow[]) {
    const activeByWorker = new Map<string, number>();
    for (const r of rows) {
      if (r.status === "APPROVED" && !r.endDate) {
        const n = (activeByWorker.get(r.workerId) ?? 0) + 1;
        if (n > 1) throw new UniqueActiveViolation();
        activeByWorker.set(r.workerId, n);
      }
    }
  }

  return {
    rows: () => committed.map((r) => ({ ...r })),
    active: (workerId: string) => committed.filter((r) => r.workerId === workerId && r.status === "APPROVED" && !r.endDate),
    async transaction<T>(fn: (draft: SessionRow[]) => Promise<T> | T): Promise<T> {
      const draft = committed.map((r) => ({ ...r }));
      const result = await fn(draft); // lỗi ⇒ throw ⇒ không commit (rollback)
      assertInvariant(draft); // unique index kiểm tra lúc "commit"
      committed = draft;
      return result;
    },
  };
}

/** Nghiệp vụ "xác nhận nghỉ A + xếp việc B" viết theo đúng thứ tự production. */
async function confirmResignationAndAssign(
  store: ReturnType<typeof makeStore>,
  input: { workerId: string; newSessionId: string; newDeptId: string; actualResignationDate: string; startingDate: string },
) {
  return store.transaction((draft) => {
    const target = draft.find((r) => r.id === input.newSessionId);
    if (!target) throw new Error("SESSION_NOT_FOUND");
    // Idempotent: session mới đã ACTIVE rồi (double-click) → không lặp lại nghiệp vụ.
    if (target.status === "APPROVED" && !target.endDate) {
      const otherActive = draft.find((r) => r.id !== target.id && r.workerId === input.workerId && r.status === "APPROVED" && !r.endDate);
      if (!otherActive) return { idempotent: true };
    }
    const active = draft.find((r) => r.workerId === input.workerId && r.status === "APPROVED" && !r.endDate && r.id !== target.id);
    if (active) {
      active.status = "ENDED";
      active.endDate = input.actualResignationDate;
      active.endReason = "RESIGNATION";
    }
    target.status = "APPROVED";
    target.deptId = input.newDeptId;
    target.startingDate = input.startingDate;
    return { idempotent: false };
  });
}

/* ============================================================
   TEST #1 (bắt buộc) — worker mới assign bình thường
   ============================================================ */

test("worker mới → assign bình thường tạo đúng 1 ACTIVE session", async () => {
  const store = makeStore([
    { id: "s1", workerId: "w1", status: "PENDING", endDate: null, deptId: null, startingDate: null, endReason: null },
  ]);
  await store.transaction((draft) => {
    const s = draft.find((r) => r.id === "s1")!;
    s.status = "APPROVED";
    s.deptId = "dept-a";
    s.startingDate = "2026-08-16";
  });
  assert.equal(store.active("w1").length, 1);
  assert.equal(store.active("w1")[0].startingDate, "2026-08-16");
});

/* ============================================================
   TEST #6 (bắt buộc) — confirm resignation A + assign B: A ENDED, B ACTIVE
   ============================================================ */

test("confirm A + assign B: A ENDED (RESIGNATION, đúng ngày) và B ACTIVE — atomic", async () => {
  const store = makeStore([
    { id: "sA", workerId: "w1", status: "APPROVED", endDate: null, deptId: "dept-a", startingDate: "2026-06-01", endReason: null },
    { id: "sB", workerId: "w1", status: "PENDING", endDate: null, deptId: null, startingDate: null, endReason: null },
  ]);
  await confirmResignationAndAssign(store, {
    workerId: "w1",
    newSessionId: "sB",
    newDeptId: "dept-b",
    actualResignationDate: "2026-08-15",
    startingDate: "2026-08-16",
  });
  const rows = store.rows();
  const a = rows.find((r) => r.id === "sA")!;
  const b = rows.find((r) => r.id === "sB")!;
  assert.equal(a.status, "ENDED");
  assert.equal(a.endDate, "2026-08-15");
  assert.equal(a.endReason, "RESIGNATION");
  assert.equal(b.status, "APPROVED");
  assert.equal(b.endDate, null);
  assert.equal(b.deptId, "dept-b");
  // TEST #7 — không tồn tại 2 ACTIVE
  assert.equal(store.active("w1").length, 1);
});

/* ============================================================
   TEST #5 + #7 (bắt buộc) — assign B khi A vẫn ACTIVE mà KHÔNG confirm → bị chặn
   ============================================================ */

test("assign B trực tiếp khi A còn ACTIVE (bỏ qua guard) → unique index chặn, không commit gì", async () => {
  const store = makeStore([
    { id: "sA", workerId: "w1", status: "APPROVED", endDate: null, deptId: "dept-a", startingDate: "2026-06-01", endReason: null },
    { id: "sB", workerId: "w1", status: "PENDING", endDate: null, deptId: null, startingDate: null, endReason: null },
  ]);
  await assert.rejects(
    store.transaction((draft) => {
      const b = draft.find((r) => r.id === "sB")!;
      b.status = "APPROVED"; // xếp việc âm thầm — không đóng A
    }),
    UniqueActiveViolation,
  );
  // Rollback toàn bộ: B vẫn PENDING, A vẫn ACTIVE duy nhất.
  assert.equal(store.rows().find((r) => r.id === "sB")!.status, "PENDING");
  assert.equal(store.active("w1").length, 1);
});

/* ============================================================
   TEST #14 (bắt buộc) — double click / retry không tạo duplicate
   ============================================================ */

test("double-click confirm+assign: lần 2 idempotent, vẫn đúng 1 ACTIVE", async () => {
  const store = makeStore([
    { id: "sA", workerId: "w1", status: "APPROVED", endDate: null, deptId: "dept-a", startingDate: "2026-06-01", endReason: null },
    { id: "sB", workerId: "w1", status: "PENDING", endDate: null, deptId: null, startingDate: null, endReason: null },
  ]);
  const input = { workerId: "w1", newSessionId: "sB", newDeptId: "dept-b", actualResignationDate: "2026-08-15", startingDate: "2026-08-16" };
  const first = await confirmResignationAndAssign(store, input);
  const second = await confirmResignationAndAssign(store, input); // retry
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(store.active("w1").length, 1);
  assert.equal(store.rows().filter((r) => r.workerId === "w1").length, 2, "không sinh thêm session mới khi retry");
});

/* ============================================================
   TEST #8 (bắt buộc) — nghỉ rồi quay lại: history có 2 sessions
   ============================================================ */

test("worker nghỉ rồi quay lại → lịch sử giữ đủ 2 sessions (không overwrite)", async () => {
  const store = makeStore([
    { id: "s1", workerId: "w1", status: "ENDED", endDate: "2026-07-20", deptId: "dept-packing", startingDate: "2026-06-01", endReason: "RESIGNATION" },
    { id: "s2", workerId: "w1", status: "PENDING", endDate: null, deptId: null, startingDate: null, endReason: null },
  ]);
  await store.transaction((draft) => {
    const s = draft.find((r) => r.id === "s2")!;
    s.status = "APPROVED";
    s.deptId = "dept-chrysanthemum";
    s.startingDate = "2026-08-05";
  });
  const history = store.rows().filter((r) => r.workerId === "w1");
  assert.equal(history.length, 2);
  const ended = history.find((r) => r.id === "s1")!;
  assert.equal(ended.status, "ENDED");
  assert.equal(ended.endDate, "2026-07-20");
  assert.equal(ended.endReason, "RESIGNATION");
  assert.equal(store.active("w1").length, 1);
});

/* ============================================================
   Rollback giữa chừng — không để trạng thái nửa vời
   ============================================================ */

test("lỗi sau khi đóng A nhưng trước khi mở B → rollback: A vẫn ACTIVE", async () => {
  const store = makeStore([
    { id: "sA", workerId: "w1", status: "APPROVED", endDate: null, deptId: "dept-a", startingDate: "2026-06-01", endReason: null },
    { id: "sB", workerId: "w1", status: "PENDING", endDate: null, deptId: null, startingDate: null, endReason: null },
  ]);
  await assert.rejects(
    store.transaction((draft) => {
      const a = draft.find((r) => r.id === "sA")!;
      a.status = "ENDED";
      a.endDate = "2026-08-15";
      throw new Error("mất kết nối giữa chừng");
    }),
  );
  const a = store.rows().find((r) => r.id === "sA")!;
  assert.equal(a.status, "APPROVED");
  assert.equal(a.endDate, null);
  assert.equal(store.active("w1").length, 1);
});
