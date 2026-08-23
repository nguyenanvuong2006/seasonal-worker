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
 * Keep the original typography/layout, but compact vertical whitespace only in
 * print media so the six reviewed logical sections fit six physical A4 pages.
 * We deliberately do NOT use transforms/zoom or tiny text. Body text remains
 * readable (10.5pt) and long merge values still wrap safely.
 */
const CANONICAL_TRAINEE_REGISTRATION_PRINT_LOCK = String.raw`
@media print {
  .page {
    box-shadow: none;
    margin: 0;
    width: 210mm;
    min-height: 297mm;
    height: 297mm;
    padding: 8mm 14mm;
    overflow: visible;
    break-after: page;
    page-break-after: always;
    break-inside: avoid;
    page-break-inside: avoid;
    font-size: 10.5pt;
    line-height: 1.15;
  }

  .page:last-child {
    break-after: auto;
    page-break-after: auto;
  }

  /* Preserve visual hierarchy while removing preview-style vertical slack. */
  .doc-header { margin-bottom: 3mm; }
  .doc-header .hd-left { padding-top: 2mm; padding-bottom: 2mm; }
  .doc-header .hd-right { padding-top: 2.2mm; padding-bottom: 2.2mm; }

  .line { margin-bottom: 1.1mm; }
  .tight { margin-bottom: 0.35mm; }
  .sec { margin: 1.2mm 0 0.7mm; }

  .mt2 { margin-top: 1mm; }
  .mt4 { margin-top: 2mm; }
  .mt6 { margin-top: 3mm; }
  .mt8 { margin-top: 4mm; }
  .mt10 { margin-top: 5mm; }
  .mt14 { margin-top: 7mm; }
  .mt20 { margin-top: 10mm; }

  .attach-box {
    padding: 1.4mm 3mm;
    margin: 2mm 0 4mm;
  }
  .attach-box td { padding: 0.25mm 0; }

  .sign-3-table { margin-top: 2mm; }
  .sign-gap { height: 11mm; }

  .photo-wrap .body-col { min-width: 0; }
  .merge-value {
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .attach-box,
  .sign-single,
  .sign-3-table {
    break-inside: avoid;
    page-break-inside: avoid;
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
