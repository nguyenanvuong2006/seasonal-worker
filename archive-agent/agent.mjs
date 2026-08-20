#!/usr/bin/env node
/**
 * ARCHIVE AGENT — Seasonal Worker (Phase 12)
 *
 * Chạy trên máy HR hoặc NAS (Node >= 18, KHÔNG cần dependency):
 *   npm start            # chạy một lượt archive
 *   npm run dry-run      # không ghi file, không verify (chỉ log)
 *
 * Workflow:
 *   1. POST /api/archive/runs            → mở phiên (runId)
 *   2. GET  /api/archive/documents       → danh sách PDF chưa archive (phân trang)
 *   3. GET  /api/archive/documents/[id]/download → tải PDF (backend proxy — không lộ Drive token)
 *   4. Lưu ARCHIVE_DESTINATION/YYYY/MM/DD/<filename>.pdf
 *   5. Tính SHA-256 local → so khớp doc.sha256
 *   6. POST /api/archive/verify          → VERIFIED (match) / ARCHIVE_VERIFY_FAILED (mismatch — GIỮ Drive)
 *   7. Ghi manifest.csv (theo tháng hoặc năm) — index độc lập, không secrets
 *   8. POST /api/archive/runs/complete   → đóng phiên (COMPLETED/PARTIAL/FAILED)
 *
 * Resume: file đã VERIFIED bị skip (không tải lại). Lỗi 1 file không dừng run.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile, appendFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
function loadEnv() {
  try {
    const content = readFileSync(new URL("./.env", import.meta.url), "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* không có .env — dùng env hệ thống */
  }
}
loadEnv();

const API_URL = (process.env.ARCHIVE_API_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.ARCHIVE_API_KEY || "";
const DEST = process.env.ARCHIVE_DESTINATION || "HR_DOCUMENT_ARCHIVE";
const MANIFEST_INTERVAL = (process.env.ARCHIVE_MANIFEST_INTERVAL || "MONTHLY").toUpperCase();
const LIMIT = Math.min(500, Math.max(1, Number(process.env.ARCHIVE_LIMIT ?? 200)));
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";

if (!API_URL || !API_KEY) {
  console.error("❌ Thiếu ARCHIVE_API_URL / ARCHIVE_API_KEY (xem .env.example).");
  process.exit(1);
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function api(path, init = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${path}: ${detail.slice(0, 300)}`);
  }
  return res;
}

function manifestName(now, interval) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return interval === "YEARLY" ? `manifest-${y}.csv` : `manifest-${y}-${m}.csv`;
}

const MANIFEST_HEADER =
  "generated_at,candidate_name,candidate_id,application_id,document_type,template_version,filename,file_size,sha256,archive_path,archived_at\n";

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvRow(doc, archivePath, archivedAt) {
  return [
    doc.generatedAt,
    doc.candidateName || "",
    doc.candidateId || "",
    doc.applicationId || "",
    doc.documentType || "",
    doc.templateVersion ?? "",
    doc.filename,
    doc.fileSize ?? "",
    doc.sha256 || "",
    archivePath,
    archivedAt,
  ]
    .map(csvEscape)
    .join(",") + "\n";
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
const startedAt = new Date();
let runId = null;
let downloaded = 0;
let verified = 0;
let failed = 0;
const manifestRows = [];

async function main() {
  console.log(`📦 Archive Agent — ${DRY_RUN ? "DRY RUN" : "RUN"} bắt đầu ${startedAt.toISOString()}`);
  console.log(`   Đích: ${DEST} · Interval manifest: ${MANIFEST_INTERVAL}`);

  if (!DRY_RUN) {
    const res = await api("/api/archive/runs", {
      method: "POST",
      body: JSON.stringify({ runType: "MANUAL" }),
    });
    runId = (await res.json()).runId;
    console.log(`   Phiên archive: ${runId}`);
  }

  let offset = 0;
  let page = 0;
  while (true) {
    page += 1;
    const res = await api(`/api/archive/documents?limit=${LIMIT}&offset=${offset}`);
    const data = await res.json();
    const docs = data.documents ?? [];
    console.log(`   Trang ${page}: ${docs.length} tài liệu (offset ${offset})`);
    if (docs.length === 0) break;

    for (const doc of docs) {
      if (doc.archiveStatus === "VERIFIED") {
        console.log(`   ⏭  SKIP (đã VERIFIED): ${doc.filename}`);
        continue; // resume — không tải lại
      }

      const ymd = String(doc.generatedAt ?? "").slice(0, 10).split("-");
      const [y, m, d] = ymd.length === 3 ? ymd : ["", "", ""];
      const dir = join(DEST, y, m, d);
      const filePath = join(dir, doc.filename.replace(/[\\/:*?"<>|]/g, "_"));

      try {
        const dl = await api(`/api/archive/documents/${doc.id}/download`);
        const buffer = Buffer.from(await dl.arrayBuffer());
        const localSha = sha256Hex(buffer);
        const match = Boolean(doc.sha256) && localSha === doc.sha256;

        if (!DRY_RUN) {
          await mkdir(dir, { recursive: true });
          await writeFile(filePath, buffer);
        }

        console.log(
          `   ${match ? "✅" : "❌"} ${doc.filename} — sha256 ${match ? "MATCH" : "MISMATCH"}` +
            (DRY_RUN ? " [DRY RUN]" : ""),
        );

        if (!DRY_RUN) {
          const verifyRes = await api("/api/archive/verify", {
            method: "POST",
            body: JSON.stringify({
              historyId: doc.id,
              sha256Match: match,
              archivePath: filePath.replace(/\\/g, "\\"),
              archiveSha256: localSha,
            }),
          });
          const v = await verifyRes.json();
          downloaded += 1;
          if (v.archiveStatus === "VERIFIED") {
            verified += 1;
            manifestRows.push(toCsvRow(doc, filePath, new Date().toISOString()));
          } else {
            failed += 1; // ARCHIVE_VERIFY_FAILED — GIỮ Drive, thử lại lần sau
          }
        } else {
          downloaded += 1;
          if (match) verified += 1;
          else failed += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(`   ⚠️  Lỗi ${doc.filename}: ${err.message}`);
      }
    }

    offset += docs.length;
    if (docs.length < LIMIT) break;
  }

  // Manifest (chỉ ghi khi có ít nhất 1 VERIFIED hoặc đã tồn tại manifest)
  let manifestPath = "";
  if (!DRY_RUN && manifestRows.length > 0) {
    manifestPath = join(DEST, manifestName(new Date(), MANIFEST_INTERVAL));
    await mkdir(dirname(manifestPath), { recursive: true });
    try {
      await access(manifestPath);
    } catch {
      await writeFile(manifestPath, MANIFEST_HEADER);
    }
    await appendFile(manifestPath, manifestRows.join(""));
    console.log(`   📄 Manifest: ${manifestPath} (+${manifestRows.length} dòng)`);
  }

  const status = failed > 0 && verified > 0 ? "PARTIAL" : failed > 0 ? "FAILED" : "COMPLETED";
  if (!DRY_RUN && runId) {
    await api("/api/archive/runs/complete", {
      method: "POST",
      body: JSON.stringify({
        runId,
        status,
        downloadedCount: downloaded,
        verifiedCount: verified,
        failedCount: failed,
        manifestPath: manifestPath || null,
      }),
    });
  }

  console.log(`\n📊 Kết quả: downloaded=${downloaded} verified=${verified} failed=${failed} status=${status}`);
  console.log(`   Thời gian: ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`);
  if (DRY_RUN) console.log("   (DRY RUN — không ghi file, không verify)");
  process.exit(failed > 0 && verified === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("❌ Archive agent thất bại:", err.message);
  process.exit(1);
});
