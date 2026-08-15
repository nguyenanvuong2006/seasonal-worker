/**
 * POST /api/document-merge/templates/[id]/scan
 * Quét placeholders <<...>> từ Google Docs và auto-map.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { fieldDefinitions, formQuestions, mergeTemplateFields, mergeTemplates } from "@/db/schema";
import { extractUniquePlaceholders } from "@/lib/document-merge/placeholder-extractor";
import { createGoogleDocsService } from "@/lib/document-merge/google-docs-service";
import { autoMapAllPlaceholders } from "@/lib/document-merge/auto-mapping";
import { extractGoogleDocId } from "@/lib/document-merge/template-routing";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await context.params;

  try {
    let googleDocIdFromBody = "";
    try {
      const body = await request.json();
      googleDocIdFromBody = String(body.googleDocId ?? "").trim();
    } catch {
      googleDocIdFromBody = "";
    }

    const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, id)).limit(1);
    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const extracted = extractGoogleDocId(googleDocIdFromBody || template.googleDocId);
    const docId = extracted || template.googleDocId;

    const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
    const content = await docsService.getDocumentContent(docId);
    const placeholders = extractUniquePlaceholders(content);

    const existingFields = await db
      .select()
      .from(mergeTemplateFields)
      .where(eq(mergeTemplateFields.templateId, id));
    const existingMap = new Map(existingFields.map((field) => [field.placeholder, field]));

    const definitions = await db.select().from(fieldDefinitions);
    const questions = await db.select().from(formQuestions).where(eq(formQuestions.isActive, true));
    const suggestions = autoMapAllPlaceholders(placeholders, definitions, questions);
    const suggestionMap = new Map(suggestions.map((item) => [item.placeholder, item]));

    const newPlaceholders = new Set(placeholders);
    const orphanedFields = existingFields.filter((field) => !newPlaceholders.has(field.placeholder));
    for (const field of orphanedFields) {
      await db
        .update(mergeTemplateFields)
        .set({ isOrphaned: true, updatedAt: new Date() })
        .where(eq(mergeTemplateFields.id, field.id));
    }

    const newFields = [];
    for (const placeholder of placeholders) {
      if (existingMap.has(placeholder)) continue;
      const suggestion = suggestionMap.get(placeholder);
      const [created] = await db
        .insert(mergeTemplateFields)
        .values({
          templateId: id,
          placeholder,
          sourceType: suggestion?.sourceType ?? "CORE_FIELD",
          isSuggested: Boolean(suggestion),
          isOrphaned: false,
          isRequired: false,
          sourceField: suggestion?.sourceField ?? null,
          sourcePath: suggestion ? `${suggestion.sourceEntity}.${suggestion.sourceField}` : null,
          sourceEntity: suggestion?.sourceEntity ?? null,
        })
        .returning();
      newFields.push(created);
    }

    const allFields = await db.select().from(mergeTemplateFields).where(eq(mergeTemplateFields.templateId, id));

    await writeAudit(guard.session, "SCAN_MERGE_TEMPLATE", "merge_templates", {
      templateId: id,
      placeholderCount: placeholders.length,
    });

    return NextResponse.json({
      placeholders,
      newFields,
      orphanedFields: orphanedFields.map((field) => field.placeholder),
      suggestions: suggestions.filter((item) => item.confidence >= 0.7),
      totalFields: allFields.length,
      activeFields: allFields.filter((field) => !field.isOrphaned).length,
    });
  } catch (error) {
    console.error("[document-merge/templates/scan] error:", error);
    return NextResponse.json({ error: "Failed to scan placeholders" }, { status: 500 });
  }
}
