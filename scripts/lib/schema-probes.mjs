/**
 * SCHEMA EVIDENCE PROBES — shared, reusable, read-only structural checks
 * against information_schema / pg_catalog (Mission B section 18: "These
 * probes must be reusable by reconciliation script and post-migration
 * verification. No duplicated SQL if practical.").
 *
 * Every function here does exactly one SELECT, takes an explicit `client`
 * (never a module-level singleton), and returns a boolean. No writes, ever.
 * This module has NO business-logic opinion about what any probe result
 * MEANS (that's the caller's job — see scripts/reconcile-schema-migrations.mjs
 * and scripts/production-health-check.mjs) — it only answers "does this
 * object exist in the public schema right now?".
 *
 * IMPORTANT (Mission B section 6): "Never equate 'all columns exist' with
 * 'migration definitely ran' — another migration/hotfix may have created
 * the same schema." These probes prove PRESENCE, not PROVENANCE.
 */

export async function tableExists(client, tableName) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
    [tableName],
  );
  return r.rowCount > 0;
}

export async function columnExists(client, tableName, columnName) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [tableName, columnName],
  );
  return r.rowCount > 0;
}

export async function indexExists(client, indexName) {
  const r = await client.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [indexName]);
  return r.rowCount > 0;
}

export async function constraintExists(client, constraintName) {
  const r = await client.query(
    `SELECT 1 FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.conname = $1`,
    [constraintName],
  );
  return r.rowCount > 0;
}

export async function functionExists(client, functionName) {
  const r = await client.query(
    `SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [functionName],
  );
  return r.rowCount > 0;
}

export async function triggerExists(client, triggerName) {
  const r = await client.query("SELECT 1 FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal", [triggerName]);
  return r.rowCount > 0;
}

export async function extensionExists(client, extensionName) {
  const r = await client.query("SELECT 1 FROM pg_extension WHERE extname = $1", [extensionName]);
  return r.rowCount > 0;
}

export async function viewExists(client, viewName) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = $1",
    [viewName],
  );
  return r.rowCount > 0;
}

/** scheduled_jobs is itself a business table, but checking whether a specific job_key row exists is the same kind of structural presence probe as a column check — used by the workforce-lifecycle required-migration probe. Read-only, single row lookup by key, never a value/content assertion. */
export async function scheduledJobExists(client, jobKey) {
  const r = await client.query("SELECT 1 FROM scheduled_jobs WHERE job_key = $1", [jobKey]);
  return r.rowCount > 0;
}
