/**
 * Document Merge Engine — Templates API
 * 
 * CRUD cho merge templates.
 * GET /api/document-merge/templates - List templates
 * POST /api/document-merge/templates - Create template
 */

import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { requireAnyPermission, requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { mergeTemplates, mergeTemplateFields } from '@/db/schema';
import { extractGoogleDocId } from '@/lib/document-merge/template-routing';

// Dynamic RBAC V2 audit (Document Merge module visibility): listing templates is
// useful both to a plain viewer (document_merge.view) AND to someone who can only
// MANAGE templates (document_merge.templates.manage) — a templates.manage-only
// grant must still be able to open the Templates tab and see the list to manage,
// not just POST blind creates. Neither permission is a "parent" of the other.
export async function GET() {
  const guard = await requireAnyPermission(['ADMIN', 'HR_RECRUITER', 'HR_DIRECTOR', 'HR_SUPPORT'], ['document_merge.view', 'document_merge.templates.manage']);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  try {
    const templates = await db
      .select()
      .from(mergeTemplates)
      .orderBy(desc(mergeTemplates.updatedAt));
    
    // Lấy số placeholders cho mỗi template
    const templatesWithCounts = await Promise.all(
      templates.map(async (template) => {
        const fields = await db
          .select()
          .from(mergeTemplateFields)
          .where(eq(mergeTemplateFields.templateId, template.id));
        
        return {
          ...template,
          placeholderCount: fields.filter(f => !f.isOrphaned).length,
          fieldMappingsCount: fields.length,
          orphanedCount: fields.filter(f => f.isOrphaned).length,
        };
      })
    );
    
    return NextResponse.json(templatesWithCounts);
  } catch (error) {
    console.error('[document-merge/templates] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.templates.manage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  try {
    const body = await request.json();
    const { name, description, googleDocId, outputFolderId, outputFileNamePattern, defaultMergeMode, dataSources, documentKind } = body;

    const extractedDocId = extractGoogleDocId(String(googleDocId ?? ''));
    
    // Validation
    if (!name || !extractedDocId) {
      return NextResponse.json(
        { error: 'Name and Google Doc ID are required' },
        { status: 400 }
      );
    }

    const kind = documentKind === 'A' || documentKind === 'B' ? documentKind : 'GENERIC';
    
    const [template] = await db
      .insert(mergeTemplates)
      .values({
        name,
        description: description || null,
        googleDocId: extractedDocId,
        outputFolderId: outputFolderId || null,
        outputFileNamePattern: outputFileNamePattern || null,
        defaultMergeMode: defaultMergeMode || 'ONE_DOCUMENT',
        dataSources: dataSources || [],
        documentKind: kind,
        isActive: true,
        createdBy: guard.session.username,
        updatedBy: guard.session.username,
      })
      .returning();
    
    // Audit
    await import('@/lib/auth').then(m => m.writeAudit(
      guard.session,
      'CREATE_MERGE_TEMPLATE',
      'merge_templates',
      { templateId: template.id, name, googleDocId }
    ));
    
    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    console.error('[document-merge/templates] POST error:', error);
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }
}
