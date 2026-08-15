import { NextResponse } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, formQuestions } from "@/db/schema";
import { normalizePersonName } from "@/lib/person-name";
import { isQuestionForAudience } from "@/lib/form-targeting";
import { LOOKUP_NOT_FOUND_MESSAGE, verifyLookupIdentity } from "@/lib/lookup-identity";
import { resolveDocumentKind, resolveDwClassification } from "@/lib/document-merge/template-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * P0-2 — Tra cứu công khai bắt buộc CCCD + SĐT.
 * Bổ sung link tài liệu đã merge + câu hỏi xác nhận tập nghề (không trả chữ ký ảnh).
 */
export async function POST(req: Request) {
  let body: { cccd?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }

  const identity = await verifyLookupIdentity(body.cccd, body.phone);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }

  const history = await db
    .select({
      id: dailyApplications.id,
      regDate: dailyApplications.regDate,
      status: dailyApplications.status,
      fullName: dailyApplications.fullName,
      declaredType: dailyApplications.declaredType,
      dwMatch: dailyApplications.dwMatch,
      deptName: departments.deptName,
      groupName: departments.groupName,
      startingDate: dailyApplications.startingDate,
      mergedDocUrl: dailyApplications.mergedDocUrl,
      mergedDocPdfUrl: dailyApplications.mergedDocPdfUrl,
      documentSentAt: dailyApplications.documentSentAt,
      signatureConfirmedAt: dailyApplications.signatureConfirmedAt,
      confirmedAnswers: dailyApplications.confirmedAnswers,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(eq(dailyApplications.cccd, identity.cccd))
    .orderBy(desc(dailyApplications.regDate))
    .limit(20);

  if (!identity.dwFullName && history.length === 0) {
    return NextResponse.json({ error: LOOKUP_NOT_FOUND_MESSAGE }, { status: 404 });
  }

  const confirmTarget =
    history.find((row) => row.mergedDocUrl && !row.signatureConfirmedAt) ??
    history.find((row) => row.mergedDocUrl) ??
    history.find((row) => row.status === "APPROVED") ??
    history[0] ??
    null;

  let confirmationQuestions: {
    fieldKey: string;
    questionText: string;
    fieldType: string;
    options: string[];
    isRequired: boolean;
  }[] = [];

  if (confirmTarget) {
    const audience = resolveDwClassification({
      declaredType: confirmTarget.declaredType,
      dwMatch: confirmTarget.dwMatch,
    }) === "OLD"
      ? "RETURNING"
      : "NEW";

    const questions = await db
      .select()
      .from(formQuestions)
      .where(and(eq(formQuestions.isActive, true), eq(formQuestions.visibleToApplicants, true)))
      .orderBy(asc(formQuestions.sortOrder));

    confirmationQuestions = questions
      .filter((question) => isQuestionForAudience(question, audience))
      .map((question) => ({
        fieldKey: question.fieldKey,
        questionText: question.questionText,
        fieldType: question.fieldType,
        options: Array.isArray(question.options) ? question.options : [],
        isRequired: question.isRequired,
      }));
  }

  return NextResponse.json({
    worker: {
      fullName: normalizePersonName(identity.dwFullName ?? history[0]?.fullName ?? ""),
      isVerified: Boolean(identity.dwFullName),
    },
    history: history.map((row) => ({
      id: row.id,
      regDate: row.regDate,
      status: row.status,
      deptName: row.deptName ? `${row.deptName}${row.groupName ? " — " + row.groupName : ""}` : null,
      startingDate: row.startingDate,
      dwClassification: resolveDwClassification({
        declaredType: row.declaredType,
        dwMatch: row.dwMatch,
      }),
      documentKind: resolveDocumentKind({
        declaredType: row.declaredType,
        dwMatch: row.dwMatch,
      }),
      mergedDocUrl: row.mergedDocUrl,
      mergedDocPdfUrl: row.mergedDocPdfUrl,
      documentSentAt: row.documentSentAt,
      signatureConfirmedAt: row.signatureConfirmedAt,
      hasSignature: Boolean(row.signatureConfirmedAt),
    })),
    confirmation: confirmTarget
      ? {
          applicationId: confirmTarget.id,
          documentReady: Boolean(confirmTarget.mergedDocUrl),
          alreadyConfirmed: Boolean(confirmTarget.signatureConfirmedAt),
          signatureConfirmedAt: confirmTarget.signatureConfirmedAt,
          mergedDocUrl: confirmTarget.mergedDocUrl,
          mergedDocPdfUrl: confirmTarget.mergedDocPdfUrl,
          confirmedAnswers: confirmTarget.confirmedAnswers ?? {},
          questions: confirmationQuestions,
        }
      : null,
  });
}
