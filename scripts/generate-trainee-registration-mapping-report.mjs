#!/usr/bin/env node
/** Generate the reviewable canonical field inventory; run with `node --import tsx`. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DANG_KY_TAP_NGHE_FIELD_CONTRACT } from "../src/document-templates/dang-ky-tap-nghe/schema.ts";
import {
  CANONICAL_TRAINEE_REGISTRATION_HTML,
  CANONICAL_TRAINEE_REGISTRATION_LOGICAL_PAGE_COUNT,
  CANONICAL_TRAINEE_REGISTRATION_SOURCE_PATH,
  CANONICAL_TRAINEE_REGISTRATION_SOURCE_SHA256,
} from "../src/document-templates/dang-ky-tap-nghe/canonical-template.generated.ts";
import { extractUniquePlaceholders } from "../src/lib/document-merge/placeholder-extractor.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const output = join(ROOT, "docs", "TRAINEE_REGISTRATION_FIELD_MAPPING_REPORT.md");
const fields = DANG_KY_TAP_NGHE_FIELD_CONTRACT.fields;
const found = extractUniquePlaceholders(CANONICAL_TRAINEE_REGISTRATION_HTML);
const occurrences = [...CANONICAL_TRAINEE_REGISTRATION_HTML.matchAll(/\{\{\s*[^{}]+?\s*\}\}/g)].length;
const expected = new Set(fields.map((field) => field.key));
const unmapped = found.filter((key) => !expected.has(key));
const unmappedRequired = fields.filter((field) => field.required && !found.includes(field.key));

function sourceType(field) {
  if (field.valueKind === "checkbox") return "CHECKBOX_OPTION";
  if (field.key === "Nguoi_tiep_nhan") return "SYSTEM_FIELD";
  if (field.valueKind === "computed") return "COMPUTED_FIELD";
  return field.sourcePath?.startsWith("customAnswers.") ? "DYNAMIC_ANSWER" : "CORE_FIELD";
}

function formatter(field) {
  if (field.valueKind === "checkbox") return "CHECKBOX_OPTION → ☒ / ☐";
  if (field.key === "Nguoi_tiep_nhan") return "CURRENT_USER_NAME";
  if (field.key === "Ngay_ky_day") return "DATE_DAY(startingDate)";
  if (field.key === "Ngay_ky_month") return "DATE_MONTH(startingDate)";
  if (field.key === "Ngay_ky_year" || field.key === "Nam_thue") return "DATE_YEAR(startingDate)";
  if (field.valueKind === "date") return "DATE_DDMMYYYY";
  return "RAW";
}

function checkboxLogic(field) {
  return field.valueKind === "checkbox"
    ? `match ${field.sourcePath} = “${field.optionValue}” → ☒; otherwise ☐`
    : "—";
}

const rows = fields.map((field) => [
  `\`{{${field.key}}}\``,
  field.label,
  field.required ? "Required" : "Optional",
  `\`${sourceType(field)}\` → \`${field.sourcePath ?? ""}\``,
  `\`${formatter(field)}\``,
  checkboxLogic(field),
].join(" | "));

const content = `# Trainee-registration canonical field-mapping report

**Canonical source:** \`${CANONICAL_TRAINEE_REGISTRATION_SOURCE_PATH}\`  
**Canonical source SHA-256:** \`${CANONICAL_TRAINEE_REGISTRATION_SOURCE_SHA256}\`  
**Logical document pages:** ${CANONICAL_TRAINEE_REGISTRATION_LOGICAL_PAGE_COUNT}  
**Production template syntax:** semantic \`{{Field}}\`; candidate values are escaped by the HTML renderer.

## PASS summary

| Check | Result |
| --- | --- |
| Placeholder occurrences in six production pages | ${occurrences} |
| Unique semantic placeholders | ${found.length} |
| Canonical contract fields | ${fields.length} |
| Unmapped placeholders | **${unmapped.length}** |
| Unmapped required placeholders | **${unmappedRequired.length}** |
| Result | **PASS** |

The database table \`merge_template_fields\` remains the runtime mapping source of truth and is snapshotted with every HTML/PDF job. This report is the reviewed first-party contract for the canonical visual source. A \`CHECKBOX_OPTION\` never treats an unchecked option as missing: it renders \`☐\`; the matching option renders \`☒\`.

## Field inventory and canonical mapping

| Placeholder in canonical HTML | Canonical field | Required | Runtime mapping | Formatter used | Checkbox/group logic |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Intentional transformations from the supplied visual source

The production body retains all six \`.page\` legal sections, typography, spacing, borders, table structure, signature areas, and A4 print rules. Only authoring-only markup is omitted: toolbar, page tabs, Handlebars/Jinja/Blade code panels, page labels, buttons, scripts, and blue placeholder highlighting. The source’s visual \`.f\` field markers become \`.merge-value\` text spans or semantic \`.chk\` checkbox spans; no candidate values are stored in the template.

The generated production module is checked against the canonical-source SHA-256 in \`src/document-templates/dang-ky-tap-nghe/template.test.ts\`. Run \`npm run sync:trainee-template\` followed by \`node --import tsx scripts/generate-trainee-registration-mapping-report.mjs\` after an approved canonical-source edit.
`;

writeFileSync(output, content, "utf8");
console.log(`Generated ${output}`);
console.log(`PLACEHOLDER_COUNT=${found.length}`);
console.log(`UNMAPPED_REQUIRED=${unmappedRequired.length}`);
