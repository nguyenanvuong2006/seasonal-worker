/**
 * POST /api/lookup/confirm
 * Người xin việc xác nhận hồ sơ Tập nghề: lưu chữ ký điện tử + câu trả lời.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, dailyApplications, formQuestions } from "@/db/schema";
import { isQuestionForAudience } from "@/lib/form-targeting";
import { verifyLookupIdentity } from "@/lib/lookup-identity";
import { resolveDwClassification } from "@/lib/document-merge/template-routing";
import {
  isValidSignatureDataUrl,
  normalizeConfirmedAnswersInput,
  validateConfirmedAnswers,
} from "@/lib/document-merge/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    cccd?: string;
    phone?: string;
    applicationId?: string;
    signatureDataUrl?: string;
    confirmedAnswers?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }

  const identity = await verifyLookupIdentity(body.cccd, body.phone);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }

  const applicationId = String(body.applicationId ?? "").trim();
  if (!applicationId) {
    return NextResponse.json({ error: "Thiếu mã hồ sơ cần xác nhận." }, { status: 400 });
  }

  if (!isValidSignatureDataUrl(body.signatureDataUrl)) {
    return NextResponse.json(
      { error: "Vui lòng ký tên vào Ô chữ ký điện tử trước khi gửi xác nhận." },
      { status: 400 },
    );
  }

  const [application] = await db
    .select()
    .from(dailyApplications)
    .where(
      and(
        eq(dailyApplications.id, applicationId),
        eq(dailyApplications.cccd, identity.cccd),
        isNull(dailyApplications.deletedAt),
      ),
    )
    .limit(1);

  if (!application) {
    return NextResponse.json({ error: "Không tìm thấy hồ sơ khớp với CCCD đã tra cứu." }, { status: 404 });
  }

  if (application.signatureConfirmedAt) {
    return NextResponse.json(
      { error: "Hồ sơ này đã được ký xác nhận trước đó. Liên hệ HR nếu cần ký lại." },
      { status: 409 },
    );
  }

  if (!application.mergedDocUrl && !application.documentSentAt) {
    return NextResponse.json(
      { error: "Chưa có tài liệu merge để ký. Vui lòng đợi HR đẩy tài liệu vào hồ sơ tra cứu." },
      { status: 409 },
    );
  }

  const audience =
    resolveDwClassification({
      declaredType: application.declaredType,
      dwMatch: application.dwMatch,
    }) === "OLD"
      ? "RETURNING"
      : "NEW";

  const questions = await db
    .select()
    .from(formQuestions)
    .where(and(eq(formQuestions.isActive, true), eq(formQuestions.visibleToApplicants, true)));

  const applicable = questions.filter((question) => isQuestionForAudience(question, audience));
  const answersInput = normalizeConfirmedAnswersInput(body.confirmedAnswers);
  const validated = validateConfirmedAnswers(applicable, answersInput);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const confirmedAt = new Date();
  const [updated] = await db
    .update(dailyApplications)
    .set({
      signatureDataUrl: body.signatureDataUrl!.trim(),
      signatureConfirmedAt: confirmedAt,
      confirmedAnswers: validated.answers,
      updatedAt: confirmedAt,
    })
    .where(eq(dailyApplications.id, application.id))
    .returning({
      id: dailyApplications.id,
      signatureConfirmedAt: dailyApplications.signatureConfirmedAt,
    });

  try {
    await db.insert(auditLogs).values({
      userId: null,
      username: "applicant",
      action: "APPLICANT_SIGN_CONFIRM",
      targetType: "daily_applications",
      category: "AUDIT",
      details: {
        applicationId: application.id,
        cccdTail: identity.cccd.slice(-4),
        answerKeys: Object.keys(validated.answers),
      },
    });
  } catch {
    /* audit must never break the request */
  }

  return NextResponse.json({
    success: true,
    applicationId: updated?.id ?? application.id,
    signatureConfirmedAt: updated?.signatureConfirmedAt ?? confirmedAt,
  });
}
