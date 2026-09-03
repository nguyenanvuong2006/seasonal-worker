#!/usr/bin/env bash
# =============================================================================
# provision-merge-worker-watchdog.sh — INDEPENDENT RECOVERY ACTOR (sự cố 28–29/08)
# -----------------------------------------------------------------------------
# Document Merge recovery không được phụ thuộc vào:
#   - người dùng bấm Merge khác (pre-merge sweep chỉ là backstop), hay
#   - Vercel cron 1 lần/ngày (Hobby cap).
#
# Script này tạo/update 1 Cloud Scheduler job gọi worker POST /run (watchdog
# mode, không jobId) mỗi 5 phút — worker tự reclaim item hết lease rồi xử lý
# job non-terminal kế tiếp (GOOGLE_DOCS + HTML_PDF). Auth 2 lớp:
#   - OIDC: scheduler mượn identity của RUNTIME_SA → Cloud Run IAM
#     (RUNTIME_SA phải có roles/run.invoker trên service — cấp 1 lần).
#   - App secret: header `X-Merge-Worker-Secret: <MERGE_WORKER_SECRET>` (KHÔNG
#     tiền tố "Bearer ") đọc trực tiếp từ Secret Manager (KHÔNG in ra log).
#     KHÔNG dùng `Authorization` cho secret này — header đó đã bị OIDC token
#     (dòng trên) chiếm giữ; 2 giá trị không thể cùng tồn tại trên 1 header.
#
# IDEMPOTENT: chạy lại bao nhiêu lần cũng an toàn (create nếu chưa có,
# update nếu đã tồn tại).
#
# Yêu cầu 1 lần: gcloud CLI đã auth + Cloud Scheduler API đã bật:
#   gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT_ID"
#
# Cách dùng (production):
#   export PROJECT_ID=... REGION=asia-southeast1 \
#     WORKER_URL=https://seasonal-worker-pdf-production-xxxx.run.app \
#     RUNTIME_SA=seasonal-worker-merge-prod@<project>.iam.gserviceaccount.com \
#     SECRET_NAME=PROD_MERGE_WORKER_SECRET
#   ./scripts/provision-merge-worker-watchdog.sh --yes
# =============================================================================

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-asia-southeast1}"
WORKER_URL="${WORKER_URL:-}"
RUNTIME_SA="${RUNTIME_SA:-}"
SECRET_NAME="${SECRET_NAME:-PROD_MERGE_WORKER_SECRET}"
JOB_NAME="${JOB_NAME:-merge-worker-watchdog}"
SCHEDULE="${SCHEDULE:-*/5 * * * *}"
TIME_ZONE="${TIME_ZONE:-Asia/Ho_Chi_Minh}"

usage() {
  echo "Usage: PROJECT_ID=... WORKER_URL=... RUNTIME_SA=... [REGION=...] \\" >&2
  echo "       [SECRET_NAME=PROD_MERGE_WORKER_SECRET] ./scripts/provision-merge-worker-watchdog.sh --yes" >&2
}

# Guardrail 1 — phải xác nhận tường minh.
if [[ "${1:-}" != "--yes" ]]; then
  echo "❌ Chưa xác nhận. Đây là thao tác production — chạy lại với --yes." >&2
  usage
  exit 1
fi

# Guardrail 2 — đủ tham số bắt buộc.
if [[ -z "${PROJECT_ID}" || -z "${WORKER_URL}" || -z "${RUNTIME_SA}" ]]; then
  echo "❌ Thiếu PROJECT_ID / WORKER_URL / RUNTIME_SA." >&2
  usage
  exit 1
fi

# Guardrail 3 — URL worker phải là https (Cloud Run).
if [[ "${WORKER_URL}" != https://* ]]; then
  echo "❌ WORKER_URL phải bắt đầu bằng https:// (Cloud Run service URL)." >&2
  exit 1
fi

# Guardrail 4 — service/SA không được là staging (giữ ranh giới production).
LOWER_URL=$(echo "${WORKER_URL}" | tr '[:upper:]' '[:lower:]')
LOWER_SA=$(echo "${RUNTIME_SA}" | tr '[:upper:]' '[:lower:]')
if [[ "${LOWER_URL}" == *staging* || "${LOWER_SA}" == *staging* ]]; then
  echo "❌ WORKER_URL / RUNTIME_SA chứa 'staging' — script này dành cho PRODUCTION." >&2
  exit 1
fi

echo "➡ Provision Cloud Scheduler watchdog:"
echo "   project  = ${PROJECT_ID}"
echo "   region   = ${REGION}"
echo "   job      = ${JOB_NAME}"
echo "   schedule = ${SCHEDULE} (${TIME_ZONE})"
echo "   uri      = ${WORKER_URL}/run"
echo "   oidc SA  = ${RUNTIME_SA}"

# Đọc app secret trực tiếp từ Secret Manager — không in giá trị ra log.
SECRET_VALUE=$(gcloud secrets versions access latest \
  --secret="${SECRET_NAME}" --format='get(payload.data)' | base64 -d)
if [[ -z "${SECRET_VALUE}" ]]; then
  echo "❌ Không đọc được secret '${SECRET_NAME}' từ Secret Manager — dừng lại." >&2
  exit 1
fi

# GitHub Actions không tự biết giá trị này nhạy cảm (đọc runtime từ GCP Secret
# Manager, không phải 1 `secrets.*` đã đăng ký sẵn) — tự đăng ký mask log.
# No-op khi chạy ngoài CI (GITHUB_ACTIONS không set, vd. Cloud Shell) — nếu
# không guard, dòng này sẽ tự in giá trị ra terminal y hệt điều nó định ngăn.
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::add-mask::${SECRET_VALUE}"
fi

# gcloud scheduler jobs create/update http KHÔNG có input header dạng file —
# --headers-from-file không tồn tại cho lệnh này (đã xác nhận với gcloud CLI
# reference thật, không suy đoán). Cơ chế DUY NHẤT được hỗ trợ là danh sách
# inline KEY=VALUE, nên secret buộc phải xuất hiện như 1 argument của lệnh
# gcloud này — không có cách nào khác qua CLI. Không bao giờ echo/log lệnh
# này (script không bật `set -x` ở đâu cả).
#
# QUAN TRỌNG: KHÔNG đặt app secret vào header `Authorization` — header đó đã
# bị --oidc-service-account-email chiếm giữ cho Cloud Run IAM (Cloud Scheduler
# CHỈ hỗ trợ gắn OIDC token vào đúng header `Authorization`, không có cờ nào
# đổi sang header khác). 2 giá trị không thể cùng tồn tại trên 1 header HTTP —
# đặt secret vào đây sẽ ghi đè/xung đột với OIDC token, worker nhận về
# `Authorization: Bearer <OIDC JWT>` (không khớp app secret) → 401, đã xác
# nhận bằng chẩn đoán trực tiếp production (status 401, body
# {"error":"unauthorized"}) — không phải suy đoán.
#
# Dùng header thay thế `X-Merge-Worker-Secret` mà worker/src/index.ts đã hỗ
# trợ sẵn (isAuthorized(), dòng ~100-109 — được giữ lại chính xác cho tình
# huống `Authorization` không rảnh cho app secret). Giá trị KHÔNG có tiền tố
# "Bearer " — isAuthorized() so sánh trực tiếp với WORKER_SECRET nguyên văn.
AUTH_HEADER="X-Merge-Worker-Secret=${SECRET_VALUE},Content-Type=application/json"

if gcloud scheduler jobs describe "${JOB_NAME}" \
  --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --location="${REGION}" --project="${PROJECT_ID}" \
    --schedule="${SCHEDULE}" --time-zone "${TIME_ZONE}" \
    --uri="${WORKER_URL}/run" --http-method POST \
    --oidc-service-account-email "${RUNTIME_SA}" \
    --oidc-token-audience "${WORKER_URL}" \
    --update-headers "${AUTH_HEADER}" \
    --message-body '{}'
  echo "✅ Cloud Scheduler watchdog '${JOB_NAME}' đã UPDATE."
else
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --location="${REGION}" --project="${PROJECT_ID}" \
    --schedule="${SCHEDULE}" --time-zone "${TIME_ZONE}" \
    --uri="${WORKER_URL}/run" --http-method POST \
    --oidc-service-account-email "${RUNTIME_SA}" \
    --oidc-token-audience "${WORKER_URL}" \
    --headers "${AUTH_HEADER}" \
    --message-body '{}'
  echo "✅ Cloud Scheduler watchdog '${JOB_NAME}' đã CREATE."
fi

echo "LƯU Ý: '${RUNTIME_SA}' phải có roles/run.invoker trên Cloud Run service"
echo "(gcloud run services add-iam-policy-binding <service> --member=serviceAccount:${RUNTIME_SA} --role=roles/run.invoker)."
echo "Worker tự reclaim item hết lease + xử lý job non-terminal kế tiếp — recovery"
echo "độc lập với Vercel cron và không cần người dùng thao tác gì."
