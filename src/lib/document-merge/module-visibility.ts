/**
 * DYNAMIC RBAC V2 AUDIT — Document Merge module/tab visibility (pure, no
 * "server-only"/"@/db"/React — runs in the sidebar server component, the
 * Document Merge client page, AND node:test, same source everywhere).
 *
 * Fixes the reported defect: the entire "Trộn tài liệu" module used to be
 * gated on the single permission `document_merge.view`, so a user granted
 * ONLY `document_merge.execute` (or history.view, or templates.manage) —
 * each independently enforced by its own backend route, none of them
 * requiring document_merge.view — could never reach the module at all.
 *
 * Rule enforced here (per the audit's required general rule):
 *   - Module navigation visibility = ANY effective permission in the group.
 *   - Specific tab/page/action visibility = its own permission.
 *   - Backend execution = its own permission (unchanged, enforced in each
 *     route.ts independently of anything in this file — this module only
 *     decides what the UI shows, never what the API accepts).
 */
import { PERMISSION_CATALOG } from "../rbac-catalog.ts";

/** Canonical Document Merge permission keys, read from the ONE catalog — never hardcoded/duplicated here. */
export const DOCUMENT_MERGE_PERMISSION_KEYS: readonly string[] = PERMISSION_CATALOG.filter((p) => p.group === "document_merge").map((p) => p.key);

export type DocumentMergeTab = "templates" | "merge" | "history" | "fields" | "pdfmapper" | "verification";

/**
 * Each tab -> the ONE permission that actually gates its backend route(s).
 * "verification" has no permission key (its routes hard-require role ADMIN
 * server-side, no permission bypasses that) — handled separately in canSeeTab.
 */
export const TAB_PERMISSION: Record<Exclude<DocumentMergeTab, "verification">, string> = {
  merge: "document_merge.execute",
  history: "document_merge.history.view",
  templates: "document_merge.templates.manage",
  fields: "document_merge.view",
  pdfmapper: "document_merge.templates.manage",
};

/** Landing priority when entering the module — first tab the user can actually use. */
export const LANDING_PRIORITY: readonly Exclude<DocumentMergeTab, "verification">[] = ["merge", "history", "templates", "fields"];

/** Module nav visibility: true if the session has ANY document_merge permission. */
export function hasAnyDocumentMergePermission(permissions: ReadonlySet<string> | readonly string[]): boolean {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  return DOCUMENT_MERGE_PERMISSION_KEYS.some((key) => set.has(key));
}

export function canSeeTab(tab: DocumentMergeTab, permissions: ReadonlySet<string>, role: string): boolean {
  if (tab === "verification") return role === "ADMIN";
  return permissions.has(TAB_PERMISSION[tab]);
}

/** First tab the user is allowed to land on, or null if genuinely nothing is permitted. */
export function firstPermittedTab(permissions: ReadonlySet<string>, role: string): DocumentMergeTab | null {
  for (const tab of LANDING_PRIORITY) {
    if (canSeeTab(tab, permissions, role)) return tab;
  }
  if (role === "ADMIN") return "verification";
  return null;
}
