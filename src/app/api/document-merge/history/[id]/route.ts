/**
 * Document Merge Engine — History Detail API
 * 
 * GET /api/document-merge/history/[id] - Get merge job details
 * DELETE /api/document-merge/history/[id] - Delete merge job
 * POST /api/document-merge/history/[id]/rerun - Re-run merge job
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { mergeJobs, mergeJobRecords } from '@/db/schema';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER', 'HR_DIRECTOR'], 'document_merge.history.view');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    const [job] = await db
      .select()
      .from(mergeJobs)
      .where(eq(mergeJobs.id, id))
      .limit(1);
    
    if (!job) {
      return NextResponse.json({ error: 'Merge job not found' }, { status: 404 });
    }
    
    const records = await db
      .select()
      .from(mergeJobRecords)
      .where(eq(mergeJobRecords.mergeJobId, id));
    
    return NextResponse.json({
      ...job,
      records,
    });
  } catch (error) {
    console.error('[document-merge/history/[id]] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch merge job' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.history.delete');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    // Delete records first (cascade)
    await db.delete(mergeJobRecords).where(eq(mergeJobRecords.mergeJobId, id));
    
    // Delete job
    await db.delete(mergeJobs).where(eq(mergeJobs.id, id));
    
    // Audit
    await import('@/lib/auth').then(m => m.writeAudit(
      guard.session,
      'DELETE_MERGE_JOB',
      'merge_jobs',
      { jobId: id }
    ));
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[document-merge/history/[id]] DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete merge job' }, { status: 500 });
  }
}

/**
 * POST /api/document-merge/history/[id]/rerun
 * Re-run a merge job with the same parameters
 */
export async function rerunMerge(_request: Request, context: RouteContext) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.execute');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  const { id } = await context.params;
  
  try {
    // Get original job
    const [originalJob] = await db
      .select()
      .from(mergeJobs)
      .where(eq(mergeJobs.id, id))
      .limit(1);
    
    if (!originalJob) {
      return NextResponse.json({ error: 'Merge job not found' }, { status: 404 });
    }
    
    // Get records from original job
    const originalRecords = await db
      .select()
      .from(mergeJobRecords)
      .where(eq(mergeJobRecords.mergeJobId, id));
    
    if (originalRecords.length === 0) {
      return NextResponse.json({ error: 'No records in original job' }, { status: 400 });
    }
    
    // Prepare records for re-run
    const records = {
      entityType: originalRecords[0].sourceEntity,
      recordIds: originalRecords.map(r => r.sourceRecordId),
    };
    
    // Call merge execute API
    const mergeResponse = await fetch(new URL('/api/document-merge/merge/execute', _request.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId: originalJob.templateId,
        mergeMode: originalJob.mergeMode,
        records,
      }),
    });
    
    if (!mergeResponse.ok) {
      const error = await mergeResponse.json();
      return NextResponse.json(error, { status: mergeResponse.status });
    }
    
    const result = await mergeResponse.json();
    
    // Audit re-run
    await import('@/lib/auth').then(m => m.writeAudit(
      guard.session,
      'RERUN_MERGE',
      'merge_jobs',
      {
        originalJobId: id,
        newJobId: result.jobId,
        templateId: originalJob.templateId,
        templateName: originalJob.templateNameSnapshot,
        recordCount: records.recordIds.length,
      }
    ));
    
    return NextResponse.json({
      success: true,
      jobId: result.jobId,
      outputUrl: result.outputUrl,
      message: 'Re-run successful. A new document has been created.',
    });
  } catch (error) {
    console.error('[document-merge/history/[id]/rerun] error:', error);
    return NextResponse.json({ error: 'Failed to re-run merge' }, { status: 500 });
  }
}
