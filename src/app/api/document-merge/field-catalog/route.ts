/**
 * Document Merge Engine — Field Catalog API
 * 
 * GET /api/document-merge/field-catalog - Get all mergeable fields
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAnyPermission } from '@/lib/auth';
import { db } from '@/db';
import { fieldDefinitions, formQuestions } from '@/db/schema';
import { buildFieldCatalogFromDefinitions } from '@/lib/document-merge/field-catalog';

// Dynamic RBAC V2 audit (Issue: execute-only user cannot use existing templates) —
// the placeholder catalog is a READ-ONLY dependency of BOTH executing a merge
// (Mapping Inspector shows it automatically once a template is selected) AND
// managing template mapping (building/checking mappings needs the same catalog).
// Neither document_merge.execute nor document_merge.templates.manage is a
// "parent" of the other here — both are genuinely independent reasons to read it.
export async function GET() {
  const guard = await requireAnyPermission(['ADMIN', 'HR_RECRUITER', 'HR_DIRECTOR', 'HR_SUPPORT'], ['document_merge.view', 'document_merge.execute', 'document_merge.templates.manage']);
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
