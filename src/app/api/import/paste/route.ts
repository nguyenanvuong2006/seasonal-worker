import crypto from "crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { getImportTemplate } from "@/lib/import-template";
import { cleanupPartialImportJob, createJob, isImportEngineJobType, stageRows, triggerWorker } from "@/lib/import-jobs";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Bảng dán trực tiếp chỉ phục vụ Import Engine chung; recruitment_request
// dùng luồng import riêng tại /api/recruitment-requests/import.
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 150;
const MAX_CELL_LENGTH = 50_000;
const MAX_TOTAL_CHARACTERS = 20_000_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

type PasteBody = {
  jobType?: unknown;
  columnIds?: unknown;
  rows?: unknown;
};

function errorJson(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

/** Nhận trực tiếp ma trận từ Paste Grid, không vòng qua File/multipart parser. */
export async function POST(req: Request) {
  let jobId: string | null = null;
  try {
    const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
    if (!guard.ok) return errorJson(guard.error, guard.status);

    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return errorJson("Bảng quá lớn để gửi trong một lần. Hãy chia bảng thành các phần nhỏ hơn.", 413);
    }

    let body: PasteBody;
    try {
      body = await req.json() as PasteBody;
    } catch {
      return errorJson("Nội dung JSON không hợp lệ hoặc đã vượt giới hạn request.", 400);
    }

    if (!isImportEngineJobType(body.jobType)) {
      return errorJson("Loại dữ liệu không hợp lệ. Chỉ chấp nhận department, dw_data hoặc daily_application.", 400);
    }
    const jobType = body.jobType;

    if (!Array.isArray(body.columnIds) || body.columnIds.length === 0) {
      return errorJson("Bảng chưa có cột để xử lý.", 400);
    }
    if (body.columnIds.length > MAX_COLUMNS) {
      return errorJson(`Bảng có quá nhiều cột. Tối đa ${MAX_COLUMNS} cột mỗi lần.`, 400);
    }
    if (!body.columnIds.every((id) => typeof id === "string" && id.length > 0)) {
      return errorJson("Danh sách columnIds không hợp lệ.", 400);
    }
    const columnIds = body.columnIds as string[];
    if (new Set(columnIds).size !== columnIds.length) {
      return errorJson("Danh sách cột có column ID bị trùng.", 400);
    }

    const template = await getImportTemplate(jobType);
    const columnById = new Map(template.map((column) => [column.id, column]));
    const invalidIds = columnIds.filter((id) => !columnById.has(id));
    if (invalidIds.length > 0) {
      return errorJson(`Có cột không còn hợp lệ trong template: ${invalidIds.slice(0, 5).join(", ")}. Hãy tải lại trang.`, 400);
    }
    const missingRequired = template.filter((column) => column.requiredForImport && !columnIds.includes(column.id));
    if (missingRequired.length > 0) {
      return errorJson(`Hãy thêm lại cột bắt buộc: ${missingRequired.map((column) => column.label).join(", ")}.`, 400);
    }

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return errorJson("Bảng chưa có dòng dữ liệu nào.", 400);
    }
    if (body.rows.length > MAX_ROWS) {
      return errorJson(`Mỗi lần chỉ được xử lý tối đa ${MAX_ROWS.toLocaleString("vi-VN")} dòng.`, 400);
    }

    let totalCharacters = 0;
    const matrix: string[][] = [];
    for (let rowIndex = 0; rowIndex < body.rows.length; rowIndex++) {
      const row = body.rows[rowIndex];
      if (!Array.isArray(row) || row.length !== columnIds.length) {
        return errorJson(`Dòng ${rowIndex + 1} không có đúng ${columnIds.length} ô theo bố cục cột.`, 400);
      }
      const outputRow: string[] = [];
      for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
        const value = row[columnIndex];
        if (typeof value !== "string") {
          return errorJson(`Ô tại dòng ${rowIndex + 1}, cột ${columnIndex + 1} phải là chuỗi.`, 400);
        }
        if (value.length > MAX_CELL_LENGTH) {
          return errorJson(`Ô tại dòng ${rowIndex + 1}, cột ${columnIndex + 1} dài quá ${MAX_CELL_LENGTH.toLocaleString("vi-VN")} ký tự.`, 400);
        }
        totalCharacters += value.length;
        if (totalCharacters > MAX_TOTAL_CHARACTERS) {
          return errorJson("Tổng dữ liệu trong bảng quá lớn. Hãy chia bảng thành các phần nhỏ hơn.", 413);
        }
        outputRow.push(value);
      }
      if (outputRow.every((value) => value.trim() === "")) {
        return errorJson(`Dòng ${rowIndex + 1} đang trống. Hãy xóa dòng trống rồi thử lại.`, 400);
      }
      matrix.push(outputRow);
    }

    const selectedColumns = columnIds.map((id) => columnById.get(id)!);
    const records: Record<string, string>[] = matrix.map((row) => Object.fromEntries(
      selectedColumns.map((column, index) => [column.header, row[index]]),
    ));
    const checksum = crypto.createHash("sha256").update(JSON.stringify({ jobType, columnIds, matrix })).digest("hex");
    const fileName = `Bang-dan-truc-tiep-${jobType}-${new Date().toISOString().slice(0, 10)}.json`;

    const job = await createJob(jobType, fileName, checksum, guard.session.username, records.length);
    jobId = job.id;
    try {
      await stageRows(job.id, jobType, records);
      await db.update(importJobs).set({ status: "QUEUED" }).where(eq(importJobs.id, job.id));
    } catch (stageError) {
      let cleaned = false;
      try {
        await cleanupPartialImportJob(job.id);
        jobId = null;
        cleaned = true;
      } catch (cleanupError) {
        // Safety net: nếu transaction dọn dẹp cũng gặp sự cố kết nối, đánh dấu
        // CANCELLED để watchdog/Retry tuyệt đối không xử lý staging thiếu.
        try {
          await db.update(importJobs).set({
            status: "CANCELLED",
            lastError: "Staging chưa hoàn chỉnh; Job đã bị khóa để tránh xử lý dữ liệu thiếu.",
          }).where(eq(importJobs.id, job.id));
        } catch {
          // Kết nối DB đang hỏng hoàn toàn; ghi log để vận hành can thiệp.
        }
        console.error("Không thể dọn Job paste staging dở", { jobId: job.id, cleanupError });
      }
      console.error("Paste Grid staging thất bại", { jobId: job.id, stageError });
      return errorJson(
        cleaned
          ? "Không thể nạp dữ liệu vào staging. Job chưa hoàn chỉnh đã được dọn; bạn có thể thử lại an toàn."
          : "Không thể nạp dữ liệu vào staging. Job lỗi đã bị khóa để không xử lý dữ liệu thiếu; vui lòng thử lại sau.",
        500,
      );
    }

    triggerWorker(job.id, job.resumeToken, new URL(req.url).origin);
    await writeAudit(guard.session, "IMPORT_PASTE_JOB_CREATED", jobType, {
      jobId: job.id,
      totalRows: records.length,
      columnIds,
    }, "IMPORT");

    return NextResponse.json({
      jobId: job.id,
      totalRows: records.length,
      columns: selectedColumns.map((column) => column.header),
    });
  } catch (error) {
    console.error("POST /api/import/paste thất bại", { jobId, error });
    return errorJson("Không thể xử lý bảng do lỗi hệ thống. Vui lòng thử lại; nếu lỗi tiếp diễn, liên hệ quản trị viên.", 500);
  }
}
