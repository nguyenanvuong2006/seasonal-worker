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

export const dangKyTapNgheTemplate: HtmlTemplate = {
  key: "dang-ky-tap-nghe",
  name: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  googleDocIds: [GOOGLE_DOC_ID],
  html: CANONICAL_TRAINEE_REGISTRATION_HTML,
  css: CANONICAL_TRAINEE_REGISTRATION_CSS,
  fieldContract: DANG_KY_TAP_NGHE_FIELD_CONTRACT,
};
