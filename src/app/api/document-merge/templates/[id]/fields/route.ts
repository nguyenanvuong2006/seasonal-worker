/**
 * Document Merge Engine — Template Fields API
 *
 * CRUD cho field mappings của một template.
 * PUT /api/document-merge/templates/[id]/fields - Bulk update mappings
 * GET /api/document-merge/templates/[id]/fields - Read mappings
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { mergeTemplateFields, mergeTemplates } from '@/db/schema';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PUT /api/document-merge/templates/[id]/fields
 * Bulk update field mappings.
 * IMPORTANT: placeholder uniqueness is scoped to templateId.
 */
export async function PUT(request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.templates.manage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await context.params;

  try {
    const body = await request.json();
    const { fields } = body;

    if (!Array.isArray(fields)) {
      return NextResponse.json({ error: 'Fields must be an array' }, { status: 400 });
    }

    const [template] = await db
      .select()
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, id))
      .limit(1);

    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    const updatedFields = [];

    for (const field of fields) {
      const {
        placeholder,
        sourceType,
        sourceEntity,
        sourceField,
        sourcePath,
        optionValue,
        formatType,
        fallbackValue,
        isRequired,
        isOrphaned,
      } = field;

      if (!placeholder) continue;

      const [existing] = await db
        .select()
        .from(mergeTemplateFields)
        .where(
          and(
            eq(mergeTemplateFields.templateId, id),
            eq(mergeTemplateFields.placeholder, placeholder),
          ),
        )
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(mergeTemplateFields)
          .set({
            sourceType: sourceType ?? existing.sourceType,
            sourceEntity: sourceEntity ?? existing.sourceEntity,
            sourceField: sourceField ?? existing.sourceField,
            sourcePath: sourcePath ?? existing.sourcePath,
            optionValue: optionValue ?? existing.optionValue,
            formatType: formatType ?? existing.formatType,
            fallbackValue: fallbackValue ?? existing.fallbackValue,
            isRequired: isRequired ?? existing.isRequired,
            isOrphaned: isOrphaned ?? existing.isOrphaned,
            isSuggested: false,
            updatedAt: new Date(),
          })
          .where(eq(mergeTemplateFields.id, existing.id))
          .returning();

        updatedFields.push(updated);
      } else {
        const [created] = await db
          .insert(mergeTemplateFields)
          .values({
            templateId: id,
            placeholder,
            sourceType: sourceType ?? 'CORE_FIELD',
            sourceEntity: sourceEntity ?? null,
            sourceField: sourceField ?? null,
            sourcePath: sourcePath ?? null,
            optionValue: optionValue ?? null,
            formatType: formatType ?? null,
            fallbackValue: fallbackValue ?? null,
            isRequired: isRequired ?? false,
            isOrphaned: isOrphaned ?? false,
            isSuggested: false,
          })
          .returning();

        updatedFields.push(created);
      }
    }

    await import('@/lib/auth').then((m) =>
      m.writeAudit(guard.session, 'UPDATE_MERGE_FIELD_MAPPINGS', 'merge_template_fields', {
        templateId: id,
        fieldCount: fields.length,
      }),
    );

    return NextResponse.json(updatedFields);
  } catch (error) {
    console.error('[document-merge/templates/[id]/fields] PUT error:', error);
    return NextResponse.json({ error: 'Failed to update field mappings' }, { status: 500 });
  }
}

/**
 * GET /api/document-merge/templates/[id]/fields
 */
export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER', 'HR_DIRECTOR'], 'document_merge.view');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await context.params;

  try {
    const fields = await db
      .select()
      .from(mergeTemplateFields)
      .where(eq(mergeTemplateFields.templateId, id))
      .orderBy(mergeTemplateFields.placeholder);

    return NextResponse.json(fields);
  } catch (error) {
    console.error('[document-merge/templates/[id]/fields] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch field mappings' }, { status: 500 });
  }
}
