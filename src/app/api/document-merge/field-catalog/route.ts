/**
 * Document Merge Engine — Field Catalog API
 * 
 * GET /api/document-merge/field-catalog - Get all mergeable fields
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@/lib/auth';
import { db } from '@/db';
import { fieldDefinitions, formQuestions } from '@/db/schema';
import { buildFieldCatalogFromDefinitions } from '@/lib/document-merge/field-catalog';

export async function GET() {
  const guard = await requirePermission(['ADMIN', 'HR_RECRUITER', 'HR_DIRECTOR'], 'document_merge.view');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  
  try {
    // Get all field definitions
    const fields = await db.select().from(fieldDefinitions);
    
    // Get active form questions
    const questions = await db
      .select()
      .from(formQuestions)
      .where(eq(formQuestions.isActive, true));
    
    // Build catalog
    const catalog = buildFieldCatalogFromDefinitions(fields, questions);
    
    // Group by category
    const groupedCatalog: Record<string, typeof catalog> = {};
    for (const field of catalog) {
      if (!groupedCatalog[field.category]) {
        groupedCatalog[field.category] = [];
      }
      groupedCatalog[field.category].push(field);
    }
    
    return NextResponse.json({
      catalog,
      groupedCatalog,
      totalFields: catalog.length,
      categories: Object.keys(groupedCatalog).length,
    });
  } catch (error) {
    console.error('[document-merge/field-catalog] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch field catalog' }, { status: 500 });
  }
}
