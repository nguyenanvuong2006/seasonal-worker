/**
 * Document Merge Engine — Execute Merge API
 * 
 * POST /api/document-merge/merge/execute
 * Thực hiện merge operation
 */

import { NextResponse } from 'next/server';
import { eq, and, inArray } from 'drizzle-orm';
import { requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { mergeTemplates, mergeTemplateFields, mergeJobs, mergeJobRecords, workerProfiles, employmentSessions, departments } from '@/db/schema';
import { createGoogleDocsService } from '@/lib/document-merge/google-docs-service';
import { extractUniquePlaceholders, replaceMultiplePlaceholders } from '@/lib/document-merge/placeholder-extractor';
import { resolveAllFields, validateRequiredFields } from '@/lib/document-merge/data-resolver';
import type { MergeContext } from '@/lib/document-merge/data-resolver';
import type { Session } from '@/lib/auth';

type MergeMode = 'ONE_DOCUMENT' | 'INDIVIDUAL_DOCUMENTS';

interface RecordSelection {
  entityType: 'worker_profiles' | 'employment_sessions' | 'daily_applications';
  recordIds: string[];
}

/**
 * Build merge context từ session
 */
function buildMergeContext(session: Session): MergeContext {
  return {
    currentUserId: session.id,
    currentUserName: session.fullName,
    currentDate: new Date(),
  };
}

/**
 * Lấy record data theo entity type
 */
async function getRecordData(
  entityType: string,
  recordIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const dataMap = new Map<string, Record<string, unknown>>();
  
  switch (entityType) {
    case 'worker_profiles': {
      const records = await db
        .select()
        .from(workerProfiles)
        .where(inArray(workerProfiles.id, recordIds));
      
      for (const record of records) {
        dataMap.set(record.id, { ...record });
      }
      break;
    }
    case 'employment_sessions': {
      const records = await db
        .select({
          id: employmentSessions.id,
          workerId: employmentSessions.workerId,
          deptId: employmentSessions.deptId,
          regDate: employmentSessions.regDate,
          status: employmentSessions.status,
          startingDate: employmentSessions.startingDate,
          endDate: employmentSessions.endDate,
          note: employmentSessions.note,
        })
        .from(employmentSessions)
        .where(inArray(employmentSessions.id, recordIds));
      
      // Enrich with worker data
      const workerIds = records.map(r => r.workerId);
      const workers = await db
        .select()
        .from(workerProfiles)
        .where(inArray(workerProfiles.id, workerIds));
      const workerMap = new Map(workers.map(w => [w.id, w]));
      
      // Enrich with department data
      const deptIds = records.map(r => r.deptId).filter(Boolean);
      const depts = await db
        .select()
        .from(departments)
        .where(inArray(departments.id, deptIds as string[]));
      const deptMap = new Map(depts.map(d => [d.id, d]));
      
      for (const record of records) {
        const worker = workerMap.get(record.workerId);
        const dept = record.deptId ? deptMap.get(record.deptId) : null;
        dataMap.set(record.id, {
          ...record,
          worker: worker ? {
            fullName: worker.fullName,
            cccd: worker.cccd,
            gender: worker.gender,
            dob: worker.dob,
            phone: worker.phone,
            residentialAddress: worker.residentialAddress,
          } : {},
          department: dept ? {
            deptName: dept.deptName,
            groupName: dept.groupName,
            location: dept.location,
          } : {},
        });
      }
      break;
    }
    default:
      break;
  }
  
  return dataMap;
}

/**
 * Execute ONE_DOCUMENT merge
 */
async function executeOneDocumentMerge(
  template: typeof mergeTemplates.$inferSelect,
  fields: typeof mergeTemplateFields.$inferSelect[],
  records: RecordSelection,
  context: MergeContext
): Promise<{ outputDocId: string; outputUrl: string }> {
  const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
  
  // Get template content
  const templateContent = await docsService.getDocumentContent(template.googleDocId);
  
  // Get all record data
  const dataMap = await getRecordData(records.entityType, records.recordIds);
  
  // Build merged content
  const mergedContents: string[] = [];
  let index = 0;
  
  for (const recordId of records.recordIds) {
    const recordData = dataMap.get(recordId);
    if (!recordData) continue;
    
    index++;
    const recordContext = { ...context, mergeIndex: index, mergeCount: records.recordIds.length };
    
    // Resolve all fields for this record
    const fieldValues = resolveAllFields(fields, recordData as Record<string, unknown>, recordContext);
    
    // Replace placeholders
    let recordContent = templateContent;
    for (const [placeholder, value] of Object.entries(fieldValues)) {
      recordContent = recordContent.replace(new RegExp(`<<${placeholder}>>`, 'g'), value);
    }
    
    mergedContents.push(recordContent);
    
    // Add page break between records (except last)
    if (index < records.recordIds.length) {
      mergedContents.push('\n\n--- PAGE BREAK ---\n\n');
    }
  }
  
  // Copy template to output
  const outputDocId = await docsService.copyDocument(
    template.googleDocId,
    template.outputFolderId || undefined
  );
  
  // Update output document content
  await docsService.updateDocumentContent(outputDocId, mergedContents.join('\n'));
  
  const outputUrl = `https://docs.google.com/document/d/${outputDocId}/edit`;
  
  return { outputDocId, outputUrl };
}

/**
 * Execute INDIVIDUAL_DOCUMENTS merge
 */
async function executeIndividualDocumentsMerge(
  template: typeof mergeTemplates.$inferSelect,
  fields: typeof mergeTemplateFields.$inferSelect[],
  records: RecordSelection,
  context: MergeContext
): Promise<{ outputDocId: string; outputUrl: string }> {
  const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
  
  // Get template content
  const templateContent = await docsService.getDocumentContent(template.googleDocId);
  
  // Get all record data
  const dataMap = await getRecordData(records.entityType, records.recordIds);
  
  // Create output document
  const outputDocId = await docsService.createDocument(
    `Merge_${Date.now()}`,
    '',
    template.outputFolderId || undefined
  );
  
  // Process each record and combine
  const mergedContents: string[] = [];
  let index = 0;
  
  for (const recordId of records.recordIds) {
    const recordData = dataMap.get(recordId);
    if (!recordData) continue;
    
    index++;
    const recordContext = { ...context, mergeIndex: index, mergeCount: records.recordIds.length };
    
    // Resolve all fields for this record
    const fieldValues = resolveAllFields(fields, recordData as Record<string, unknown>, recordContext);
    
    // Replace placeholders
    let recordContent = templateContent;
    for (const [placeholder, value] of Object.entries(fieldValues)) {
      recordContent = recordContent.replace(new RegExp(`<<${placeholder}>>`, 'g'), value);
    }
    
    mergedContents.push(recordContent);
    
    // Add page break between records
    if (index < records.recordIds.length) {
      mergedContents.push('\n\n--- PAGE BREAK ---\n\n');
    }
  }
  
  // Update output document
  await docsService.updateDocumentContent(outputDocId, mergedContents.join('\n'));
  
  const outputUrl = `https://docs.google.com/document/d/${outputDocId}/edit`;
  
  return { outputDocId, outputUrl };
}

export async function POST(request: Request) {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER'], 'document_merge.execute');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  try {
    const body = await request.json();
    const { templateId, mergeMode, records, preflight } = body;
    
    if (!templateId || !records || !records.recordIds || records.recordIds.length === 0) {
      return NextResponse.json(
        { error: 'Template ID and records are required' },
        { status: 400 }
      );
    }
    
    // Get template
    const [template] = await db
      .select()
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, templateId))
      .limit(1);
    
    if (!template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }
    
    if (!template.isActive) {
      return NextResponse.json({ error: 'Template is inactive' }, { status: 400 });
    }
    
    // Get field mappings
    const fields = await db
      .select()
      .from(mergeTemplateFields)
      .where(and(
        eq(mergeTemplateFields.templateId, templateId),
        eq(mergeTemplateFields.isOrphaned, false)
      ));
    
    // PREFLIGHT: Validate required fields
    if (preflight) {
      const dataMap = await getRecordData(records.entityType, records.recordIds);
      const validationResults: { recordId: string; missingFields: string[] }[] = [];
      
      for (const recordId of records.recordIds) {
        const recordData = dataMap.get(recordId);
        if (!recordData) continue;
        
        const context = buildMergeContext(guard.session);
        const fieldValues = resolveAllFields(fields, recordData as Record<string, unknown>, context);
        const validation = validateRequiredFields(fields, fieldValues);
        
        if (!validation.valid) {
          validationResults.push({
            recordId,
            missingFields: validation.missingFields,
          });
        }
      }
      
      return NextResponse.json({
        preflight: true,
        valid: validationResults.length === 0,
        totalRecords: records.recordIds.length,
        totalPlaceholders: fields.length,
        mappedPlaceholders: fields.filter(f => f.sourceField).length,
        validationResults,
      });
    }
    
    // CREATE MERGE JOB
    const mode = mergeMode || template.defaultMergeMode || 'ONE_DOCUMENT';
    const context = buildMergeContext(guard.session);
    
    const [job] = await db
      .insert(mergeJobs)
      .values({
        templateId,
        templateNameSnapshot: template.name,
        mergeMode: mode,
        status: 'RUNNING',
        recordCount: records.recordIds.length,
        createdBy: guard.session.username,
        startedAt: new Date(),
      })
      .returning();
    
    // Create job records
    await db.insert(mergeJobRecords).values(
      records.recordIds.map((recordId: string, index: number) => ({
        mergeJobId: job.id,
        sourceEntity: records.entityType,
        sourceRecordId: recordId,
        sortOrder: index,
        status: 'PENDING',
      }))
    );
    
    // EXECUTE MERGE (try-catch để handle error)
    try {
      let result: { outputDocId: string; outputUrl: string };
      
      if (mode === 'INDIVIDUAL_DOCUMENTS') {
        result = await executeIndividualDocumentsMerge(template, fields, records, context);
      } else {
        result = await executeOneDocumentMerge(template, fields, records, context);
      }
      
      // Update job as completed
      await db
        .update(mergeJobs)
        .set({
          status: 'COMPLETED',
          outputDocId: result.outputDocId,
          outputUrl: result.outputUrl,
          completedAt: new Date(),
          metadata: { outputUrl: result.outputUrl },
        })
        .where(eq(mergeJobs.id, job.id));
      
      // Update job records as completed
      await db
        .update(mergeJobRecords)
        .set({ status: 'COMPLETED' })
        .where(eq(mergeJobRecords.mergeJobId, job.id));
      
      // Audit
      await import('@/lib/auth').then(m => m.writeAudit(
        guard.session,
        'EXECUTE_MERGE',
        'merge_jobs',
        {
          jobId: job.id,
          templateId,
          templateName: template.name,
          mergeMode: mode,
          recordCount: records.recordIds.length,
          outputDocId: result.outputDocId,
        }
      ));
      
      return NextResponse.json({
        success: true,
        jobId: job.id,
        outputDocId: result.outputDocId,
        outputUrl: result.outputUrl,
        status: 'COMPLETED',
      });
      
    } catch (mergeError) {
      // Update job as failed
      const errorMessage = mergeError instanceof Error ? mergeError.message : 'Unknown error';
      
      await db
        .update(mergeJobs)
        .set({
          status: 'FAILED',
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(mergeJobs.id, job.id));
      
      // Update job records as failed
      await db
        .update(mergeJobRecords)
        .set({ status: 'FAILED', error: errorMessage })
        .where(eq(mergeJobRecords.mergeJobId, job.id));
      
      // Audit failure
      await import('@/lib/auth').then(m => m.writeAudit(
        guard.session,
        'MERGE_FAILED',
        'merge_jobs',
        {
          jobId: job.id,
          templateId,
          error: errorMessage,
        }
      ));
      
      return NextResponse.json(
        { error: 'Merge failed', details: errorMessage },
        { status: 500 }
      );
    }
    
  } catch (error) {
    console.error('[document-merge/merge/execute] POST error:', error);
    return NextResponse.json({ error: 'Failed to execute merge' }, { status: 500 });
  }
}
