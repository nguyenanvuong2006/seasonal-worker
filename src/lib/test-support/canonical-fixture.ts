/**
 * TEST SUPPORT — load the canonical document body the way production gets it.
 *
 * Tests must not import a document body from `src/`: no runtime module is
 * allowed to contain one. Instead we read the DRAFT migration that carries the
 * canonical html_body/print_css into `merge_template_versions`, which is
 * exactly the payload an operator publishes.
 *
 * This file is test-only and is never imported by runtime code.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CanonicalDocumentSnapshot,
  CanonicalMapping,
} from "../document-merge/canonical-document.ts";

/**
 * Repo root resolved from this module's own location, so the fixture works
 * whether tests run from the repo root or from worker/.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CANONICAL_MIGRATION = "migrations/2026-08-23-trainee-registration-canonical-html-draft.sql";
const MANIFEST = "templates/document-merge/trainee-registration/canonical-source.manifest.json";

export interface CanonicalManifest {
  sourcePath: string;
  sourceSha256: string;
  canonicalBodySha256: string;
  logicalPageCount: number;
  placeholderCount: number;
  placeholders: string[];
  sourceDocxName: string;
}

function readRepoFile(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

export function readCanonicalManifest(): CanonicalManifest {
  return JSON.parse(readRepoFile(MANIFEST)) as CanonicalManifest;
}

function extractDollarQuoted(sql: string, tag: string): string {
  const open = `$${tag}$`;
  const start = sql.indexOf(open);
  if (start < 0) throw new Error(`canonical migration is missing ${open}`);
  const bodyStart = start + open.length;
  const end = sql.indexOf(open, bodyStart);
  if (end < 0) throw new Error(`canonical migration has an unterminated ${open}`);
  return sql.slice(bodyStart, end);
}

/** The canonical html_body/print_css exactly as the migration inserts them. */
export function readCanonicalVersionParts(): { htmlBody: string; printCss: string } {
  const sql = readRepoFile(CANONICAL_MIGRATION);
  return {
    htmlBody: extractDollarQuoted(sql, "canonical_html"),
    printCss: extractDollarQuoted(sql, "canonical_css"),
  };
}

/**
 * Build a snapshot equivalent to what `buildCanonicalSnapshot` freezes onto a
 * job once an operator publishes the canonical draft.
 */
export function canonicalSnapshotFixture(
  mappings: CanonicalMapping[] = [],
  overrides: Partial<CanonicalDocumentSnapshot> = {},
): CanonicalDocumentSnapshot {
  const { htmlBody, printCss } = readCanonicalVersionParts();
  return {
    templateId: "tpl-canonical",
    templateVersion: 7,
    htmlBody,
    printCss,
    mappings,
    formatting: {
      contractKey: "dang-ky-tap-nghe",
      retentionYears: 3,
      documentKind: "B",
      templateName: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
    },
    ...overrides,
  };
}

/**
 * OBSOLETE SENTINEL FIXTURE.
 *
 * Represents the legacy/incomplete document body that must never render again.
 * The sentinel string exists ONLY here, in a test fixture — never in runtime
 * code, never in a seed, never in the database as a publishable default.
 */
export const LEGACY_TEMPLATE_SENTINEL = "LEGACY_TEMPLATE_MUST_NEVER_RENDER";

export const LEGACY_OBSOLETE_BODY = `<div class="page">
  <h1>GIẤY ĐĂNG KÝ TẬP NGHỀ</h1>
  <p>${LEGACY_TEMPLATE_SENTINEL}</p>
  <p>Ho ten: <<Ho_ten>></p>
</div>`;

export const LEGACY_OBSOLETE_CSS = `/* ${LEGACY_TEMPLATE_SENTINEL} */ .page { color: #000; }`;
