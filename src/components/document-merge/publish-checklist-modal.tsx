"use client";

/**
 * PUBLISH CHECKLIST MODAL — the explicit, manual gate required before a
 * template version is published (Admin Template Version Workflow, Phase 7).
 *
 * Replaces the previous plain `window.confirm("Xuất bản...?")` on the
 * "Xuất bản phiên bản" (DRAFT) and "Khôi phục" (ARCHIVED) actions.
 *
 * HOW IT VALIDATES (read-only — ZERO DB writes while open or on cancel):
 *   STEP 1 — re-reads the target version row from the server
 *            (GET .../versions, SELECT-only) so the gate ALWAYS judges the
 *            LATEST saved html_body/print_css/status — never the React state
 *            snapshot the card held at click time (no stale "version loaded
 *            before the last Save" can drive the decision).
 *   STEP 2 — runs the EXISTING, already-tested POST .../ai-analyze endpoint
 *            (zero backend changes) on that fresh content: HTML/CSS validity,
 *            security blockers, placeholder/mapping diff — plus the
 *            placeholderCoverage verdict, which is the SAME
 *            validatePlaceholderCoverage() the backend enforces inside
 *            publishTemplateVersion (unmapped + required-unresolvable
 *            placeholders). The checklist can therefore show the EXACT
 *            blocker (with placeholder names) that would make the publish
 *            API reject — a silent 400 at confirm time is no longer possible.
 *
 * THE GATE — `canConfirmPublish(machine, checks)`: machine checks (html/css/
 * security/coverage/htmlBody/status — mirroring every backend precondition)
 * must have RUN and PASSED, and all 5 operator checkboxes must be checked.
 * Every failed machine check is rendered as a specific blocker line
 * (describePublishBlockers) — the Confirm button is never silently disabled.
 *
 * This modal never publishes anything itself — it only gates the caller's
 * onConfirmed(), which the caller wires to the existing publish/rollback
 * fetch (POST .../versions/:vid/publish|rollback — unchanged).
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import {
  PUBLISH_CHECKLIST_ITEMS,
  canConfirmPublish,
  describePublishBlockers,
  emptyPublishChecklistState,
  machineChecksPassed,
  type PublishChecklistKey,
  type PublishChecklistState,
  type PublishMachineChecks,
} from "@/lib/document-merge/publish-checklist";
import type { TemplateAnalyzeResult } from "./template-change-analyzer";

export type PublishChecklistTarget = {
  id: string;
  version: number;
  htmlBody: string | null;
  printCss: string | null;
};

/** Shape of one row of GET .../templates/:id/versions (full row, incl. HTML). */
type FreshVersionRow = {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" | string;
  htmlBody: string | null;
  printCss: string | null;
  mappingSnapshot?: unknown;
};

function snapshotCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function PublishChecklistModal({
  templateId,
  templateName,
  target,
  currentPublishedVersionId,
  currentPublishedVersionNumber,
  action,
  onClose,
  onConfirmed,
}: {
  templateId: string;
  templateName: string;
  target: PublishChecklistTarget;
  /** id of the version currently PUBLISHED, if any — diff baseline + subtitle only, NEVER a content source. */
  currentPublishedVersionId: string | null;
  currentPublishedVersionNumber: number | null;
  action: "publish" | "rollback";
  onClose: () => void;
  /** Caller performs the actual POST .../publish|rollback and closes on success. */
  onConfirmed: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** FRESH server row for target.id — the ONLY content source for the machine checks. */
  const [freshVersion, setFreshVersion] = useState<FreshVersionRow | null>(null);
  const [result, setResult] = useState<TemplateAnalyzeResult | null>(null);
  const [checks, setChecks] = useState<PublishChecklistState>(emptyPublishChecklistState());
  const [confirming, setConfirming] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    setLoading(true);
    setLoadError(null);
    setFreshVersion(null);
    setResult(null);
    (async () => {
      try {
        // STEP 1 — re-read the version row from the server (GET, SELECT-only,
        // zero DB writes). The gate must judge the LATEST saved content, not
        // the React snapshot captured when the card button was clicked.
        const listRes = await fetch(`/api/document-merge/templates/${templateId}/versions`, { cache: "no-store" });
        const listData: unknown = await listRes.json().catch(() => null);
        if (mySeq !== seq.current) return;
        if (!listRes.ok || !Array.isArray(listData)) {
          const errField = (listData as { error?: unknown } | null)?.error;
          throw new Error(typeof errField === "string" ? errField : "Không tải được phiên bản hiện tại trên server.");
        }
        const fresh = listData.find(
          (row): row is FreshVersionRow =>
            typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string" &&
            (row as { id: string }).id === target.id,
        );
        if (!fresh) {
          throw new Error("Version không còn tồn tại trên server (có thể vừa bị xoá). Đóng checklist và tải lại danh sách phiên bản.");
        }
        setFreshVersion(fresh);

        const hasHtmlBody = typeof fresh.htmlBody === "string" && fresh.htmlBody.trim().length > 0;
        if (!hasHtmlBody) {
          // Backend would reject with 400 "chưa có nội dung HTML" — stop here
          // and say exactly that (do not call ai-analyze with empty html).
          return;
        }

        // STEP 2 — machine analysis of the FRESH content (read-only).
        // Diff against the currently PUBLISHED version when one exists and is
        // not the version being published itself; otherwise self-diff — still
        // yields html/css/security/coverage checks with a zero diff.
        const baseVersionId =
          currentPublishedVersionId && currentPublishedVersionId !== target.id ? currentPublishedVersionId : target.id;
        const res = await fetch(`/api/document-merge/templates/${templateId}/ai-analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html: fresh.htmlBody, printCss: fresh.printCss ?? null, baseVersionId }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (mySeq !== seq.current) return;
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : "Không phân tích được phiên bản trước khi xuất bản.");
        }
        setResult(data as unknown as TemplateAnalyzeResult);
      } catch (err) {
        if (mySeq !== seq.current) return;
        setLoadError(err instanceof Error ? err.message : "Không phân tích được phiên bản trước khi xuất bản.");
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    })();
    return () => {
      seq.current += 1;
    };
    // `action` is fixed per modal open (the parent creates a fresh target on
    // every card-button click) — included so the gate never runs with a
    // stale action while judging the fresh server row.
  }, [templateId, target.id, currentPublishedVersionId, action]);

  // Machine gate — mirrors EVERY backend publish precondition. `null` until
  // the fresh row is loaded (and the analysis done when HTML is non-empty).
  const machine: PublishMachineChecks | null = freshVersion && (result !== null || !hasHtmlBodyOf(freshVersion))
    ? (() => {
        const coverage = result?.placeholderCoverage;
        const issues = coverage?.issues ?? [];
        const versionStatus: PublishMachineChecks["versionStatus"] =
          freshVersion.status === "DRAFT" || freshVersion.status === "PUBLISHED" || freshVersion.status === "ARCHIVED"
            ? freshVersion.status
            : "UNKNOWN";
        return {
          htmlValid: result ? result.htmlValid : true, // empty HTML: nothing to structurally validate
          htmlIssueCount: result ? result.htmlIssues.length : 0,
          cssValid: result ? result.cssValid : true,
          cssIssueCount: result ? result.cssIssues.length : 0,
          securityBlockerCount: result ? result.security.errors.length : 0,
          placeholderCoverageOk: result ? Boolean(coverage?.ok) : true,
          unmappedPlaceholders: issues.filter((i) => i.reason === "UNMAPPED").map((i) => i.placeholder),
          requiredUnresolvablePlaceholders: issues.filter((i) => i.reason === "REQUIRED_UNRESOLVABLE").map((i) => i.placeholder),
          hasHtmlBody: hasHtmlBodyOf(freshVersion),
          versionStatus,
          statusPublishable: action === "publish" ? versionStatus === "DRAFT" : versionStatus === "ARCHIVED",
        };
      })()
    : null;

  const blockers = machine && !machineChecksPassed(machine) ? describePublishBlockers(machine) : [];
  const canConfirm = canConfirmPublish(machine, checks) && !confirming && !loading;

  const toggle = (key: PublishChecklistKey) => setChecks((prev) => ({ ...prev, [key]: !prev[key] }));

  const confirm = async () => {
    if (!canConfirm) return;
    setConfirming(true);
    try {
      await onConfirmed();
    } finally {
      setConfirming(false);
    }
  };

  const unmapped = machine?.unmappedPlaceholders ?? [];
  const requiredUnresolvable = machine?.requiredUnresolvablePlaceholders ?? [];
  const coverage = result?.placeholderCoverage;
  const layoutWarnings = result?.layoutWarnings ?? [];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              {action === "publish" ? "Xác nhận xuất bản" : "Xác nhận khôi phục"} v{target.version}
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              Bạn sắp {action === "publish" ? "xuất bản" : "khôi phục (rollback)"} v{target.version}
              {currentPublishedVersionNumber != null && currentPublishedVersionNumber !== target.version
                ? ` và thay thế v${currentPublishedVersionNumber} hiện đang PUBLISHED`
                : ""}{" "}
              của &quot;{templateName}&quot;.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && <p className="mt-4 text-xs text-slate-500">Đang tải phiên bản hiện tại + chạy kiểm tra tự động...</p>}
        {loadError && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{loadError}</p>
          </div>
        )}

        {freshVersion && machine && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-bold text-slate-800">Kiểm tra tự động (trên nội dung MỚI NHẤT trên server)</p>
            <ul className="mt-2 space-y-1">
              {/* VERSION STATUS — re-read from the server, not from the card's React state. */}
              <ChecklistLine
                ok={machine.statusPublishable}
                label={
                  machine.statusPublishable
                    ? `Version v${freshVersion.version} đang ${freshVersion.status} — đủ điều kiện ${action === "publish" ? "xuất bản" : "khôi phục"}.`
                    : `Version v${freshVersion.version} hiện đang ${freshVersion.status} — không thể ${action === "publish" ? "xuất bản" : "khôi phục"} từ trạng thái này.`
                }
              />
              <ChecklistLine
                ok={machine.hasHtmlBody}
                label={machine.hasHtmlBody ? "HTML body (html_body) có nội dung." : "HTML body (html_body) TRỐNG — version chưa có nội dung để xuất bản."}
              />
              <ChecklistLine
                ok={machine.htmlValid}
                label={
                  result
                    ? `HTML ${machine.htmlValid ? "hợp lệ" : `— ${machine.htmlIssueCount} lỗi cấu trúc`}`
                    : "HTML — (không có nội dung để kiểm tra)"
                }
              />
              <ChecklistLine
                ok={machine.cssValid}
                label={
                  result
                    ? `CSS bản in ${machine.cssValid ? "hợp lệ (hoặc trống — CSS A4 chung được tự thêm)" : `— ${machine.cssIssueCount} lỗi cấu trúc`}`
                    : "CSS — (không có nội dung để kiểm tra)"
                }
              />
              <ChecklistLine
                ok={machine.securityBlockerCount === 0}
                label={
                  result
                    ? machine.securityBlockerCount === 0
                      ? "Không có mã nguy hiểm"
                      : `${machine.securityBlockerCount} mã nguy hiểm bị chặn`
                    : "Bảo mật — (chưa phân tích được)"
                }
              />
              {/* PLACEHOLDER — the same verdict the backend publish enforces. */}
              {result && coverage ? (
                coverage.ok ? (
                  <ChecklistLine
                    ok
                    label={`Placeholder: tất cả ${coverage.totalPlaceholders} placeholder trong HTML đều đã có mapping dữ liệu.`}
                  />
                ) : (
                  <ChecklistLine
                    ok={false}
                    label={`Placeholder: ${coverage.issues.length} placeholder có vấn đề (publish sẽ bị hệ thống từ chối).`}
                  />
                )
              ) : machine.hasHtmlBody ? (
                <ChecklistLine ok label="Placeholder — (chưa phân tích được nội dung HTML)." />
              ) : (
                <ChecklistLine ok label="Placeholder: không có (html_body trống)." />
              )}
              {/* MAPPING SNAPSHOT — informational: DRAFT freezes at publish time; PUBLISHED/ARCHIVED already frozen. */}
              {freshVersion.status === "DRAFT" ? (
                <li className="flex items-start gap-1.5 text-slate-600">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span>
                    Mapping snapshot: DRAFT — sẽ được <b>freeze từ {coverage ? coverage.mappedFields : "bảng mapping hiện hành"}</b>{" "}
                    trường (không orphan) tại thời điểm publish.
                  </span>
                </li>
              ) : (
                <li className="flex items-start gap-1.5 text-slate-600">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span>
                    Mapping snapshot: đã freeze lúc publish ({snapshotCount(freshVersion.mappingSnapshot)} placeholder) — bất biến.
                  </span>
                </li>
              )}
              {/* A4/PDF — layout warnings are ADVISORY (non-blocking); the operator's
                  "Tôi xác nhận bố cục A4" checkbox is the explicit gate. */}
              {result ? (
                layoutWarnings.length === 0 ? (
                  <ChecklistLine ok label="Bố cục A4/PDF: không có cảnh báo tràn/đè." />
                ) : (
                  <li className="flex items-start gap-1.5 font-semibold text-amber-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Bố cục A4/PDF: {layoutWarnings.length} vị trí có nguy cơ tràn/đè khi dữ liệu dài — kiểm tra PDF TEST trước khi confirm.</span>
                  </li>
                )
              ) : null}
            </ul>

            {result && (
              <>
                <p className="mt-3 text-slate-700">
                  Placeholder (so với base): {result.placeholders.unchanged} không đổi · {result.placeholders.added} mới ·{" "}
                  {result.placeholders.removed} bị xóa
                </p>
                <p className={result.mappingsAffected > 0 ? "mt-1 font-semibold text-amber-700" : "mt-1 text-slate-500"}>
                  {result.mappingsAffected} trường mapping bị ảnh hưởng
                  {result.mappingsAffected === 0 ? " — không cần remapping gì cả." : " — kiểm tra mapping trước khi xuất bản."}
                </p>
              </>
            )}

            {(unmapped.length > 0 || requiredUnresolvable.length > 0) && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-red-700">
                {unmapped.length > 0 && (
                  <p className="font-bold">
                    ❌ {unmapped.length} placeholder chưa được mapping: {unmapped.join(", ")}
                  </p>
                )}
                {requiredUnresolvable.length > 0 && (
                  <p className="mt-1 font-bold">
                    ❌ {requiredUnresolvable.length} placeholder bắt buộc chưa có nguồn dữ liệu/fallback:{" "}
                    {requiredUnresolvable.join(", ")}
                  </p>
                )}
                <p className="mt-1 text-red-600">
                  Sửa trong tab Mapping (gắn nguồn dữ liệu hoặc bỏ cờ &quot;bắt buộc&quot; nếu để trống có chủ đích), lưu mapping rồi mở lại checklist.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-bold text-slate-800">Xác nhận của người vận hành</p>
          <div className="mt-2 space-y-2">
            {PUBLISH_CHECKLIST_ITEMS.map((item) => (
              <label key={item.key} className="flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" checked={checks[item.key]} onChange={() => toggle(item.key)} className="accent-emerald-700" />
                {item.label}
              </label>
            ))}
          </div>
        </div>

        {/* NO SILENT DISABLE — every blocker that keeps Confirm disabled is listed here, specifically. */}
        {blockers.length > 0 && (
          <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700">
            <p className="flex items-center gap-1.5 font-bold">
              <AlertTriangle className="h-3.5 w-3.5" /> Không thể confirm cho tới khi khắc phục:
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Hủy
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!canConfirm}
            className="rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirming ? "Đang xuất bản..." : action === "publish" ? "Xuất bản phiên bản" : "Xác nhận khôi phục"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Backend publish precondition: non-empty html_body (400 otherwise). */
function hasHtmlBodyOf(row: FreshVersionRow): boolean {
  return typeof row.htmlBody === "string" && row.htmlBody.trim().length > 0;
}

function ChecklistLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? "text-emerald-700" : "text-red-700"}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
      {label}
    </li>
  );
}
