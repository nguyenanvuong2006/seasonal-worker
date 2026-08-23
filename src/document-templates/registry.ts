/**
 * FIRST-PARTY TEMPLATE CATALOG — METADATA ONLY.
 *
 * ⚠️ This registry deliberately contains NO document body and cannot supply
 * one. There is exactly one runtime document definition: the explicitly
 * PUBLISHED canonical version in `merge_template_versions`, snapshotted onto
 * each job and rendered by `renderCanonicalDocument()`.
 *
 * What lives here:
 *   - placeholder metadata (which semantic tokens a first-party document uses)
 *   - validation metadata (required / checkbox semantics)
 *   - labels and format definitions
 *
 * What must NEVER live here:
 *   - HTML/CSS document body content
 *   - a "default"/fallback template used when nothing is published
 *
 * Removing the body from this module is what makes the obsolete legacy
 * template unable to return as a runtime fallback.
 */

import type { TemplateContract } from "../lib/document-merge/template-contract.ts";
import {
  DANG_KY_TAP_NGHE_FIELD_CONTRACT,
  GOOGLE_DOC_ID as DANG_KY_TAP_NGHE_GOOGLE_DOC_ID,
} from "./dang-ky-tap-nghe/schema.ts";

/**
 * Catalog entry: identity + reviewable field contract. No `html`, no `css`.
 */
export interface TemplateCatalogEntry {
  /** Stable registry key, e.g. "dang-ky-tap-nghe". */
  key: string;
  name: string;
  /** Authoring-source identifiers used to recognise a first-party template. */
  googleDocIds: string[];
  /** Reviewable semantic field contract — metadata only. */
  fieldContract: TemplateContract;
}

export const TEMPLATE_CATALOG: TemplateCatalogEntry[] = [
  {
    key: "dang-ky-tap-nghe",
    name: DANG_KY_TAP_NGHE_FIELD_CONTRACT.name,
    googleDocIds: [DANG_KY_TAP_NGHE_GOOGLE_DOC_ID],
    fieldContract: DANG_KY_TAP_NGHE_FIELD_CONTRACT,
  },
];

const byGoogleDocId = new Map<string, TemplateCatalogEntry>();
const byKey = new Map<string, TemplateCatalogEntry>();
for (const entry of TEMPLATE_CATALOG) {
  byKey.set(entry.key, entry);
  for (const id of entry.googleDocIds) byGoogleDocId.set(id, entry);
}

export function getTemplateCatalogEntryByKey(key: string | null | undefined): TemplateCatalogEntry | null {
  if (!key) return null;
  return byKey.get(key) ?? null;
}

export function getTemplateCatalogEntryByGoogleDocId(
  googleDocId: string | null | undefined,
): TemplateCatalogEntry | null {
  if (!googleDocId) return null;
  return byGoogleDocId.get(googleDocId) ?? null;
}

/** Stable contract key for a first-party authoring source (metadata only). */
export function getRegisteredContractKeyByGoogleDocId(googleDocId: string | null | undefined): string | null {
  return getTemplateCatalogEntryByGoogleDocId(googleDocId)?.key ?? null;
}

export function getHtmlTemplateContractByKey(key: string | null | undefined): TemplateContract | null {
  return getTemplateCatalogEntryByKey(key)?.fieldContract ?? null;
}

export function getHtmlTemplateContractByGoogleDocId(
  googleDocId: string | null | undefined,
): TemplateContract | null {
  return getTemplateCatalogEntryByGoogleDocId(googleDocId)?.fieldContract ?? null;
}
