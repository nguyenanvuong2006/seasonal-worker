#!/usr/bin/env bash
# ============================================================
# DEPLOY STAGING — Cloud Run PDF worker (dùng cho verification)
# ------------------------------------------------------------
# Yêu cầu: gcloud CLI đã auth (gcloud auth login / ADC), project đã chọn.
#
# Cách dùng:
#   export DATABASE_URL=postgresql://...   # Neon STAGING (KHÔNG dùng production)
#   export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
#   export GOOGLE_DRIVE_ROOT_FOLDER_ID=... # folder 'Seasonal Worker Documents' (STAGING)
#   export MERGE_WORKER_SECRET=$(openssl rand -hex 32)
#   ./worker/deploy-staging.sh
#
# KHÔNG đổi production: service staging riêng, không touch production env.
# ============================================================
set -euo pipefail

SERVICE="${CLOUD_RUN_SERVICE:-seasonal-worker-pdf-staging}"
REGION="${CLOUD_RUN_REGION:-asia-southeast1}"
PROJECT="${GCP_PROJECT:?Cần GCP_PROJECT (gcloud config get-value project)}"

REQUIRED_ENV=(DATABASE_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN MERGE_WORKER_SECRET)
for v in "${REQUIRED_ENV[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "❌ Thiếu env $v" >&2
    exit 1
  fi
done

echo "🚀 Deploy staging service: $SERVICE ($REGION) — project $PROJECT"
echo "   ⚠️  KHÔNG dùng production DATABASE_URL / Drive root production!"

cd "$(dirname "$0")/.."

gcloud run deploy "$SERVICE" \
  --source ./worker \
  --region "$REGION" \
  --project "$PROJECT" \
  --cpu 2 \
  --memory 4Gi \
  --min-instances 0 \
  --max-instances 2 \
  --timeout 3600 \
  --concurrency 80 \
  --no-allow-unauthenticated \
  --set-env-vars \
    "DATABASE_URL=${DATABASE_URL},STORAGE_PROVIDER=google_drive,PDF_RENDER_CONCURRENCY=4,MERGE_WORKER_SECRET=${MERGE_WORKER_SECRET},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET},GOOGLE_REFRESH_TOKEN=${GOOGLE_REFRESH_TOKEN},GOOGLE_DRIVE_ROOT_FOLDER_ID=${GOOGLE_DRIVE_ROOT_FOLDER_ID:-},MERGE_JOB_BATCH_TTL_DAYS=${MERGE_JOB_BATCH_TTL_DAYS:-14},MERGE_DEFAULT_RETENTION_YEARS=${MERGE_DEFAULT_RETENTION_YEARS:-3}"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format 'value(status.url)')
echo ""
echo "✅ Worker staging: $URL"
echo "   POST $URL/run  (Authorization: Bearer \$MERGE_WORKER_SECRET)"
echo "   GET  $URL/health"
