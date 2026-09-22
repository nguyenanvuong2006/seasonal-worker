import fs from 'fs';
import pg from 'pg';

async function run() {
  console.log("=== LOCAL MIGRATION VALIDATION ===");
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    console.log("1. Setting up mock Production schema...");
    await pool.query(`
      CREATE TABLE form_questions (
        id serial PRIMARY KEY,
        field_key text,
        created_at timestamp DEFAULT now(),
        apply_from date,
        aliases jsonb DEFAULT '[]'::jsonb,
        export_column_name varchar(160)
      );
      CREATE UNIQUE INDEX form_questions_field_key_key ON form_questions (field_key);
    `);
    
    await pool.query(`
      INSERT INTO form_questions (field_key, apply_from)
      SELECT 'key_' || i, NULL
      FROM generate_series(1, 24) i;
    `);

    console.log("2. Running migration...");
    const migrationSql = fs.readFileSync('migrations/2026-09-22-effective-dated-dynamic-questions.sql', 'utf8');
    await pool.query(migrationSql);

    console.log("3. Verifying final state...");
    const colsRes = await pool.query(`
      SELECT column_name, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'form_questions';
    `);
    const cols = colsRes.rows;
    
    const applyFrom = cols.find(c => c.column_name === 'apply_from');
    console.log("apply_from NOT NULL:", applyFrom && applyFrom.is_nullable === 'NO' ? "YES" : "NO");
    console.log("default CURRENT_DATE:", applyFrom && applyFrom.column_default === 'CURRENT_DATE' ? "YES" : applyFrom.column_default);
    
    const effectiveTo = cols.find(c => c.column_name === 'effective_to');
    console.log("effective_to exists:", effectiveTo ? "YES" : "NO");

    const idxRes = await pool.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'form_questions' AND indexdef LIKE '%field_key%';
    `);
    const indexes = idxRes.rows.map(r => r.indexname);
    
    console.log("composite unique exists:", indexes.includes('form_questions_field_key_apply_from_idx') ? "YES" : "NO");
    console.log("old field_key-only uniqueness gone:", (!indexes.includes('form_questions_field_key_key') && !indexes.includes('form_questions_field_key_unique')) ? "YES" : "NO");
    
    const countRes = await pool.query(`SELECT count(*) as c FROM form_questions`);
    console.log("original rows preserved:", countRes.rows[0].c == 24 ? "YES (24)" : "NO (" + countRes.rows[0].c + ")");
    
    const dupRes = await pool.query(`
      SELECT field_key, count(*) 
      FROM form_questions 
      GROUP BY field_key HAVING count(*) > 1
    `);
    console.log("no duplicate versions created:", dupRes.rows.length === 0 ? "YES" : "NO");

  } catch (e) {
    console.error("Local Validation Error:", e);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
