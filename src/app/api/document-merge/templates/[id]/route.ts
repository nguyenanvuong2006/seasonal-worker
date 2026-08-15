/**
 * Document Merge Engine — Template Detail API
 * 
 * CRUD operations cho một template cụ thể.
 * GET /api/document-merge/templates/[id] - Get template
 * PUT /api/document-merge/templates/[id] - Update template
 * DELETE /api/document-merge/templates/[id] - Delete template
 * POST /api/document-merge/templates/[id]/scan - Scan placeholders from Google Docs
 * POST /api/document-merge/templates/[id]/activate - Toggle active status
 */

import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { mergeTemplates, mergeTemplateFields } from '@/db/schema';
import { extractUniquePlaceholders } from '@/lib/document-merge/placeholder-extractor';
import { createGoogleDocsService } from '@/lib/document-merge/google-docs-service';
import { autoMapAllPlaceholders } from '@/lib/document-merge/auto-mapping';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER', 'HR_DIRECTOR'], 'document_merge.view');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    const [template] = await db
      .select()
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, id))
      .limit(1);
    
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    
    // Lấy fields
    const fields = await db
      .select()
      .from(mergeTemplateFields)
      .where(eq(mergeTemplateFields.templateId, id));
    
    return NextResponse.json({
      ...template,
      fields,
    });
  } catch (error) {
    console.error('[document-merge/templates/[id]] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch template' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.templates.manage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    const body = await request.json();
    const { name, description, googleDocId, outputFolderId, outputFileNamePattern, defaultMergeMode, dataSources } = body;
    
    const [template] = await db
      .update(mergeTemplates)
      .set({
        name: name ?? undefined,
        description: description ?? undefined,
        googleDocId: googleDocId ?? undefined,
        outputFolderId: outputFolderId ?? undefined,
        outputFileNamePattern: outputFileNamePattern ?? undefined,
        defaultMergeMode: defaultMergeMode ?? undefined,
        dataSources: dataSources ?? undefined,
        updatedBy: guard.session.username,
        updatedAt: new Date(),
      })
      .where(eq(mergeTemplates.id, id))
      .returning();
    
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    
    // Audit
    await import('@/lib/auth').then(m => m.writeAudit(
      guard.session,
      'UPDATE_MERGE_TEMPLATE',
      'merge_templates',
      { templateId: id, changes: body }
    ));
    
    return NextResponse.json(template);
  } catch (error) {
    console.error('[document-merge/templates/[id]] PUT error:', error);
    return NextResponse.json({ error: 'Failed to update template' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.templates.manage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    // Lấy template trước khi xóa
    const [template] = await db
      .select()
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, id))
      .limit(1);
    
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    
    // Xóa template (cascade xóa fields)
    await db.delete(mergeTemplates).where(eq(mergeTemplates.id, id));
    
    // Audit
    await import('@/lib/auth').then(m => m.writeAudit(
      guard.session,
      'DELETE_MERGE_TEMPLATE',
      'merge_templates',
      { templateId: id, templateName: template.name }
    ));
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[document-merge/templates/[id]] DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
  }
}

/**
 * POST /api/document-merge/templates/[id]/scan
 * Scan placeholders từ Google Docs
 */
export async function scanPlaceholders(request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.templates.manage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    const body = await request.json();
    const { googleDocId } = body;
    
    // Lấy template
    const [template] = await db
      .select()
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, id))
      .limit(1);
    
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    
    const docId = googleDocId || template.googleDocId;
    
    // Lấy nội dung từ Google Docs
    const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
    const content = await docsService.getDocumentContent(docId);
    
    // Extract placeholders
    const placeholders = extractUniquePlaceholders(content);
    
    // Lấy fields hiện có
    const existingFields = await db
      .select()
      .from(mergeTemplateFields)
      .where(eq(mergeTemplateFields.templateId, id));
    
    const existingMap = new Map(existingFields.map(f => [f.placeholder, f]));
    
    // Lấy field definitions và form questions cho auto-mapping
    let fieldDefinitions: any[] = [];
    let formQuestions: any[] = [];
    
    try {
      const metadata = await import('@/lib/metadata');
      fieldDefinitions = await metadata.getFieldDefinitions();
      // Get form questions directly from schema
      const { formQuestions: fqTable } = await import('@/db/schema');
      const { db } = await import('@/db');
      const { eq, and } = await import('drizzle-orm');
      formQuestions = await db.select().from(fqTable).where(eq(fqTable.isActive, true));
    } catch {
      // Fallback: empty arrays
    }
    
    // Auto-map suggestions
    const suggestions = autoMapAllPlaceholders(placeholders, fieldDefinitions, formQuestions);
    const suggestionMap = new Map(suggestions.map(s => [s.placeholder, s]));
    
    // Mark orphaned fields (placeholders không còn trong docs)
    const newPlaceholders = new Set(placeholders);
    const orphanedFields = existingFields.filter(f => !newPlaceholders.has(f.placeholder));
    
    for (const field of orphanedFields) {
      await db
        .update(mergeTemplateFields)
        .set({ isOrphaned: true, updatedAt: new Date() })
        .where(eq(mergeTemplateFields.id, field.id));
    }
    
    // Add new placeholders (với suggestions)
    const newFields: typeof existingFields = [];
    for (const placeholder of placeholders) {
      if (!existingMap.has(placeholder)) {
        const suggestion = suggestionMap.get(placeholder);
        const [newField] = await db
          .insert(mergeTemplateFields)
          .values({
            templateId: id,
            placeholder,
            sourceType: 'CORE_FIELD',
            isSuggested: !!suggestion,
            isOrphaned: false,
            isRequired: false,
            // Nếu có suggestion, pre-fill mapping
            sourceField: suggestion?.sourceField ?? null,
            sourcePath: suggestion ? `${suggestion.sourceEntity}.${suggestion.sourceField}` : null,
            sourceEntity: suggestion?.sourceEntity ?? null,
          })
          .returning();
        newFields.push(newField);
      }
    }
    
    // Get all fields sau khi update
    const allFields = await db
      .select()
      .from(mergeTemplateFields)
      .where(eq(mergeTemplateFields.templateId, id));
    
    return NextResponse.json({
      placeholders,
      newFields,
      orphanedFields: orphanedFields.map(f => f.placeholder),
      suggestions: suggestions.filter(s => s.confidence >= 0.7),
      totalFields: allFields.length,
      activeFields: allFields.filter(f => !f.isOrphaned).length,
    });
  } catch (error) {
    console.error('[document-merge/templates/[id]/scan] error:', error);
    return NextResponse.json({ error: 'Failed to scan placeholders' }, { status: 500 });
  }
}

/**
 * POST /api/document-merge/templates/[id]/activate
 * Toggle active status
 */
export async function toggleActive(request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.templates.manage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    const body = await request.json();
    const { isActive } = body;
    
    const [template] = await db
      .update(mergeTemplates)
      .set({
        isActive: isActive ?? undefined,
        updatedBy: guard.session.username,
        updatedAt: new Date(),
      })
      .where(eq(mergeTemplates.id, id))
      .returning();
    
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    
    // Audit
    await import('@/lib/auth').then(m => m.writeAudit(
      guard.session,
      isActive ? 'ACTIVATE_MERGE_TEMPLATE' : 'DEACTIVATE_MERGE_TEMPLATE',
      'merge_templates',
      { templateId: id, templateName: template.name }
    ));
    
    return NextResponse.json(template);
  } catch (error) {
    console.error('[document-merge/templates/[id]/activate] error:', error);
    return NextResponse.json({ error: 'Failed to toggle template status' }, { status: 500 });
  }
}
