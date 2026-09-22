import pg from 'pg';

async function run() {
  console.log("=== PRODUCTION DIAGNOSTIC RUN ===");
  if (!process.env.DATABASE_URL) {
    console.error("No DATABASE_URL provided.");
    process.exit(1);
  }
  
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    const schemaRes = await pool.query(`
      SELECT column_name, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'form_questions';
    `);
    
    console.log("--- SCHEMA ---");
    const cols = schemaRes.rows;
    console.log("form_questions exists:", cols.length > 0 ? "YES" : "NO");
    console.log("apply_from exists:", cols.some(c => c.column_name === 'apply_from') ? "YES" : "NO");
    console.log("effective_to exists:", cols.some(c => c.column_name === 'effective_to') ? "YES" : "NO");
    console.log("aliases exists:", cols.some(c => c.column_name === 'aliases') ? "YES" : "NO");
    console.log("export_column_name exists:", cols.some(c => c.column_name === 'export_column_name') ? "YES" : "NO");
    
    const applyFromCol = cols.find(c => c.column_name === 'apply_from');
    console.log("apply_from nullable:", applyFromCol ? applyFromCol.is_nullable : "N/A");

    const idxRes = await pool.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'form_questions' AND indexdef LIKE '%field_key%';
    `);
    console.log("Indexes involving field_key:");
    idxRes.rows.forEach(r => console.log(r.indexname, "-", r.indexdef));

    console.log("--- AGGREGATES ---");
    const countRes = await pool.query(`SELECT count(*) as c FROM form_questions;`);
    console.log("Total form_questions rows:", countRes.rows[0].c);

    if (applyFromCol) {
      const applyFromNullRes = await pool.query(`SELECT count(*) as c FROM form_questions WHERE apply_from IS NULL;`);
      console.log("rows where apply_from IS NULL:", applyFromNullRes.rows[0].c);
    } else {
      console.log("rows where apply_from IS NULL: N/A");
    }

    const createdNullRes = await pool.query(`SELECT count(*) as c FROM form_questions WHERE created_at IS NULL;`);
    console.log("rows where created_at IS NULL:", createdNullRes.rows[0].c);

    const dupRes = await pool.query(`
      SELECT count(*) as count
      FROM form_questions
      GROUP BY field_key, COALESCE(apply_from, created_at::date)
      HAVING count(*) > 1;
    `);
    console.log("number of duplicate groups:", dupRes.rows.length);
    
    let maxDup = 0;
    dupRes.rows.forEach(r => {
      if (parseInt(r.count) > maxDup) maxDup = parseInt(r.count);
    });
    console.log("maximum duplicate-group size:", maxDup);

    const effectiveToCol = cols.some(c => c.column_name === 'effective_to');
    if (effectiveToCol) {
      const overlap1 = await pool.query(`
        SELECT count(*) as c 
        FROM form_questions 
        WHERE effective_to <= COALESCE(apply_from, created_at::date);
      `);
      console.log("existing effective_to <= proposed effective apply_from count:", overlap1.rows[0].c);
      
      const overlap2 = await pool.query(`
        SELECT count(*) as c 
        FROM form_questions f1 
        JOIN form_questions f2 ON f1.field_key = f2.field_key AND f1.id != f2.id
        WHERE f1.effective_to > COALESCE(f2.apply_from, f2.created_at::date) 
          AND COALESCE(f1.apply_from, f1.created_at::date) < f2.effective_to;
      `);
      console.log("overlapping effective-window pair count:", overlap2.rows[0].c);
    } else {
      console.log("existing effective_to <= proposed effective apply_from count: N/A");
      console.log("overlapping effective-window pair count: N/A");
    }
  } catch (e) {
    console.error("Error running diagnostic:", e);
  } finally {
    await pool.end();
  }
}

run();
