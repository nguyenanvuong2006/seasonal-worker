/**
 * Document Merge Engine — History API
 * 
 * GET /api/document-merge/history - List merge history
 */

import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { mergeJobs, mergeJobRecords } from '@/db/schema';

export async function GET() {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER', 'HR_DIRECTOR', 'HR_SUPPORT'], 'document_merge.history.view');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  try {
    const jobs = await db
      .select()
      .from(mergeJobs)
      .orderBy(desc(mergeJobs.createdAt))
      .limit(100);
    
    // Get records for each job
    const jobsWithRecords = await Promise.all(
      jobs.map(async (job) => {
        const records = await db
          .select()
          .from(mergeJobRecords)
          .where(eq(mergeJobRecords.mergeJobId, job.id));
        
        return {
          ...job,
          records,
          recordCount: records.length,
          completedRecords: records.filter(r => r.status === 'COMPLETED').length,
          failedRecords: records.filter(r => r.status === 'FAILED').length,
        };
      })
    );
    
    return NextResponse.json(jobsWithRecords);
  } catch (error) {
    console.error('[document-merge/history] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}
