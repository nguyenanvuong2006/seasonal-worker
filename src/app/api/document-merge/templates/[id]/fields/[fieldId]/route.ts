/**
 * Document Merge Engine — Field Detail API
 * 
 * DELETE /api/document-merge/templates/[id]/fields/[fieldId] - Delete field mapping
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { mergeTemplateFields } from '@/db/schema';

type RouteContext = { params: Promise<{ id: string; fieldId: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.templates.manage');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { fieldId } = await context.params;
  
  try {
    await db
      .delete(mergeTemplateFields)
      .where(eq(mergeTemplateFields.id, fieldId));
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[document-merge/templates/[id]/fields/[fieldId]] DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete field mapping' }, { status: 500 });
  }
}
