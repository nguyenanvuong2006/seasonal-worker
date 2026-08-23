/**
 * Production registration template generated from the operator-provided visual
 * canonical source. The immutable source file intentionally contains preview
 * navigation and code panels for human review; the generated module includes
 * only its six legal A4 page sections and semantic merge spans.
 *
 * Mapping stays in merge_template_fields. This module never contains applicant
 * values and is used for the registered first-party contract/preview path;
 * accepted jobs still snapshot the published DB version and CSS.
 */

import type { HtmlTemplate } from "../../lib/document-merge/html-renderer.ts";
import { DANG_KY_TAP_NGHE_FIELD_CONTRACT, GOOGLE_DOC_ID } from "./schema.ts";
import {
  CANONICAL_TRAINEE_REGISTRATION_CSS,
  CANONICAL_TRAINEE_REGISTRATION_HTML,
} from "./canonical-template.generated.ts";

/**
 * Canonical print lock.
 *
 * The source template already defines each logical `.page` as one physical A4
 * page. An earlier production-normalisation rule changed `height: 297mm` to
 * `height: auto`, which allowed dense logical pages to fragment and produced
 * 11 physical PDF pages from the six-page canonical document.
 *
 * Keep this override last so the production renderer and the browser evidence
 * harness use the intended six-page geometry without hiding/clipping content.
 * The visual gate separately checks per-page vertical overflow.
 */
const CANONICAL_TRAINEE_REGISTRATION_PRINT_LOCK = String.raw`
@media print {
  .page {
    box-shadow: none;
    margin: 0;
    width: 210mm;
    min-height: 297mm;
    height: 297mm;
    padding: 14mm 16mm;
    overflow: visible;
    break-after: page;
    page-break-after: always;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .page:last-child {
    break-after: auto;
    page-break-after: auto;
  }
}
`;

export const dangKyTapNgheTemplate: HtmlTemplate = {
  key: "dang-ky-tap-nghe",
  name: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  googleDocIds: [GOOGLE_DOC_ID],
  html: CANONICAL_TRAINEE_REGISTRATION_HTML,
  css: `${CANONICAL_TRAINEE_REGISTRATION_CSS}\n${CANONICAL_TRAINEE_REGISTRATION_PRINT_LOCK}`,
  fieldContract: DANG_KY_TAP_NGHE_FIELD_CONTRACT,
};
