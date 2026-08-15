import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { pool } from "@/db";
import { hashPassword } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { addDateDays } from "@/lib/workforce-intelligence/calculations";
import { persistRegistrationAtomically } from "@/lib/registration-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TARGET_GIT_REF = "staging-workforce-verification";
const TARGET_NEON_BRANCH = "staging-workforce-intelligence";
const RUN_ID_RE = /^wfi-[a-z0-9-]{6,24}$/;
const TABLES = [
  "departments",
  "daily_applications",
  "worker_profiles",
  "employment_sessions",
  "workforce_movements",
  "planning_periods",
  "planning_targets",
] as const;

type JsonRecord = Record<string, unknown>;
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: JsonRecord[]; rowCount: number | null }> };

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reject(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

function databaseConfig(): { url: URL; expectedHost: string } | null {
  const rawUrl = process.env.DATABASE_URL;
  const rawExpectedHost = process.env.WORKFORCE_VERIFICATION_EXPECTED_DATABASE_HOST;
  if (!rawUrl || !rawExpectedHost) return null;
  try {
    const url = new URL(rawUrl);
    const expectedHost = rawExpectedHost.trim().toLowerCase();
    if (!expectedHost || rawExpectedHost.includes("://") || rawExpectedHost.includes("/")) return null;
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    if (url.hostname.toLowerCase() !== expectedHost) return null;
    if (!expectedHost.endsWith(".neon.tech") || !/^ep-[a-z0-9-]+\./.test(expectedHost)) return null;
    return { url, expectedHost };
  } catch {
    return null;
  }
}

function cccdFor(runId: string, index: number): string {
  const hex = createHash("sha256").update(`${runId}:${index}`).digest("hex").slice(0, 14);
  const digits = (BigInt(`0x${hex}`) % BigInt(100_000_000_000)).toString().padStart(11, "0");
  return `8${digits}`;
}

function fixtureIdentity(runId: string) {
  const marker = runId.toUpperCase();
  const usernamePrefix = runId.toLowerCase();
  return {
    marker,
    usernamePrefix,
    cccds: Array.from({ length: 12 }, (_, index) => cccdFor(runId, index)),
  };
}

async function preflightIdentity(expectedHost: string) {
  const result = await pool.query(
    `SELECT current_database() AS database_name,
            current_user AS database_user,
            current_setting('server_version_num') AS server_version_num,
            current_setting('ssl') AS ssl_enabled,
            pg_backend_pid()::int AS backend_pid`,
  );
  const row = result.rows[0] as JsonRecord | undefined;
  if (!row) throw new Error("PostgreSQL identity query returned no row.");
  const fingerprint = createHash("sha256")
    .update(`${expectedHost}|${String(row.database_name)}|${String(row.database_user)}`)
    .digest("hex");
  return {
    connected: true,
    host: expectedHost,
    neonBranchExpected: TARGET_NEON_BRANCH,
    databaseFingerprint: fingerprint,
    serverVersionNum: String(row.server_version_num),
    sslEnabled: String(row.ssl_enabled) === "on",
    backendPid: Number(row.backend_pid),
  };
}

async function findSyntheticDepartments(queryable: Queryable, marker: string): Promise<string[]> {
  const result = await queryable.query(
    `SELECT id::text AS id FROM departments
     WHERE dept_name = ANY($1::text[])`,
    [[`${marker}-A`, `${marker}-B`]],
  );
  return result.rows.map((row) => String(row.id));
}

async function fixturePresence(queryable: Queryable, runId: string) {
  const { marker, usernamePrefix, cccds } = fixtureIdentity(runId);
  const departments = await findSyntheticDepartments(queryable, marker);
  const result = await queryable.query(
    `SELECT
       (SELECT count(*)::int FROM departments WHERE dept_name = ANY($1::text[])) AS departments,
       (SELECT count(*)::int FROM users WHERE username LIKE $2) AS users,
       (SELECT count(*)::int FROM dw_data WHERE cccd = ANY($3::text[])) AS dw_matches,
       (SELECT count(*)::int FROM daily_applications WHERE cccd = ANY($3::text[])) AS applications,
       (SELECT count(*)::int FROM worker_profiles WHERE cccd = ANY($3::text[])) AS profiles,
       (SELECT count(*)::int FROM planning_periods WHERE created_by = $4) AS planning_periods,
       (SELECT count(*)::int FROM workforce_movements WHERE requested_by = $4) AS movements,
       (SELECT count(*)::int FROM employment_sessions
          WHERE dept_id = ANY($5::uuid[])
             OR daily_application_id IN (SELECT id FROM daily_applications WHERE cccd = ANY($3::text[]))
             OR worker_id IN (SELECT id FROM worker_profiles WHERE cccd = ANY($3::text[]))) AS sessions`,
    [
      [`${marker}-A`, `${marker}-B`],
      `${usernamePrefix}-%`,
      cccds,
      marker,
      departments,
    ],
  );
  const counts = result.rows[0] ?? {};
  return {
    counts,
    clean: Object.values(counts).every((value) => Number(value) === 0),
  };
}

async function cleanupFixture(queryable: Queryable, runId: string) {
  const { marker, usernamePrefix, cccds } = fixtureIdentity(runId);
  const departmentIds = await findSyntheticDepartments(queryable, marker);
  const deleted: Record<string, number> = {};
  const run = async (key: string, sql: string, values: unknown[]) => {
    const result = await queryable.query(sql, values);
    deleted[key] = result.rowCount ?? 0;
  };

  await run("auditLogs", `DELETE FROM audit_logs WHERE username LIKE $1`, [`${usernamePrefix}-%`]);
  await run("userScopes", `DELETE FROM user_department_scopes WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)`, [`${usernamePrefix}-%`]);
  await run("users", `DELETE FROM users WHERE username LIKE $1`, [`${usernamePrefix}-%`]);
  await run("movements", `DELETE FROM workforce_movements WHERE requested_by = $1`, [marker]);
  await run(
    "planningTargets",
    `DELETE FROM planning_targets WHERE planning_period_id IN (SELECT id FROM planning_periods WHERE created_by = $1)`,
    [marker],
  );
  await run("planningPeriods", `DELETE FROM planning_periods WHERE created_by = $1`, [marker]);
  await run(
    "sessions",
    `DELETE FROM employment_sessions
     WHERE dept_id = ANY($1::uuid[])
        OR daily_application_id IN (SELECT id FROM daily_applications WHERE cccd = ANY($2::text[]))
        OR worker_id IN (SELECT id FROM worker_profiles WHERE cccd = ANY($2::text[]))`,
    [departmentIds, cccds],
  );
  await run("applications", `DELETE FROM daily_applications WHERE cccd = ANY($1::text[])`, [cccds]);
  await run("profiles", `DELETE FROM worker_profiles WHERE cccd = ANY($1::text[])`, [cccds]);
  await run("departments", `DELETE FROM departments WHERE id = ANY($1::uuid[])`, [departmentIds]);
  return deleted;
}

async function insertApplication(
  queryable: Queryable,
  input: { cccd: string; fullName: string; deptId: string | null; status: string; startingDate: string | null; regDate: string },
) {
  const result = await queryable.query(
    `INSERT INTO daily_applications
       (cccd, full_name, phone, reg_date, declared_type, dw_match, dept_id, status, starting_date, referral_channel, custom_answers)
     VALUES ($1, $2, '0900000000', $3::date, 'NEW', 'NEW', $4::uuid, $5, $6::date, 'SYNTHETIC_VERIFICATION', '{}'::jsonb)
     RETURNING id::text AS id`,
    [input.cccd, input.fullName, input.regDate, input.deptId, input.status, input.startingDate],
  );
  return String(result.rows[0]?.id);
}

async function insertProfile(queryable: Queryable, cccd: string, fullName: string, deleted = false) {
  const result = await queryable.query(
    `INSERT INTO worker_profiles (cccd, full_name, phone, deleted_at, deleted_by)
     VALUES ($1, $2, '0900000000', CASE WHEN $3::boolean THEN now() ELSE NULL END, CASE WHEN $3::boolean THEN 'WORKFORCE_VERIFICATION' ELSE NULL END)
     RETURNING id::text AS id`,
    [cccd, fullName, deleted],
  );
  return String(result.rows[0]?.id);
}

async function insertSession(
  queryable: Queryable,
  input: { workerId: string; applicationId: string | null; deptId: string | null; status: string; regDate: string; startingDate: string | null },
) {
  const result = await queryable.query(
    `INSERT INTO employment_sessions (worker_id, daily_application_id, dept_id, reg_date, status, starting_date)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::date)
     RETURNING id::text AS id`,
    [input.workerId, input.applicationId, input.deptId, input.regDate, input.status, input.startingDate],
  );
  return String(result.rows[0]?.id);
}

async function setupFixture(runId: string) {
  const client = await pool.connect();
  const { marker, usernamePrefix, cccds } = fixtureIdentity(runId);
  const today = todayStr();
  const dates = {
    today,
    incoming: addDateDays(today, 2),
    exit: addDateDays(today, 3),
    transfer: addDateDays(today, 4),
    to: addDateDays(today, 6),
    past: addDateDays(today, -10),
  };
  try {
    await client.query("BEGIN");
    const existing = await fixturePresence(client as unknown as Queryable, runId);
    if (!existing.clean) throw new Error("Synthetic run id already exists; cleanup it before setup.");

    const deptResult = await client.query(
      `INSERT INTO departments (dept_name, group_name, location, division, vn_name)
       VALUES ($1, 'SYNTHETIC', 'VERIFICATION', 'VERIFICATION', $1),
              ($2, 'SYNTHETIC', 'VERIFICATION', 'VERIFICATION', $2)
       RETURNING id::text AS id, dept_name`,
      [`${marker}-A`, `${marker}-B`],
    );
    const deptA = String(deptResult.rows.find((row: JsonRecord) => row.dept_name === `${marker}-A`)?.id);
    const deptB = String(deptResult.rows.find((row: JsonRecord) => row.dept_name === `${marker}-B`)?.id);

    const password = `${runId}-Only!9`;
    const passwordHash = hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (username, password_hash, full_name, role, dept_id)
       VALUES ($1, $5, $6, 'ADMIN', NULL),
              ($2, $5, $7, 'ADMIN', NULL),
              ($3, $5, $8, 'ADMIN', NULL),
              ($4, $5, $9, 'DEPT_MANAGER', NULL)
       RETURNING id::text AS id, username`,
      [
        `${usernamePrefix}-global`,
        `${usernamePrefix}-a`,
        `${usernamePrefix}-b`,
        `${usernamePrefix}-none`,
        passwordHash,
        `${marker} Global`,
        `${marker} Scope A`,
        `${marker} Scope B`,
        `${marker} Empty Scope`,
      ],
    );
    const userId = (username: string) => String(userResult.rows.find((row: JsonRecord) => row.username === username)?.id);
    const userA = userId(`${usernamePrefix}-a`);
    const userB = userId(`${usernamePrefix}-b`);
    await client.query(
      `INSERT INTO user_department_scopes (user_id, department_id)
       VALUES ($1::uuid, $2::uuid), ($3::uuid, $4::uuid)`,
      [userA, deptA, userB, deptB],
    );

    const createWorker = async (index: number, label: string, applicationDept: string, sessionDept: string, startingDate: string) => {
      const applicationId = await insertApplication(client as unknown as Queryable, {
        cccd: cccds[index],
        fullName: `${marker} ${label}`,
        deptId: applicationDept,
        status: "APPROVED",
        startingDate,
        regDate: today,
      });
      const workerId = await insertProfile(client as unknown as Queryable, cccds[index], `${marker} ${label}`);
      const sessionId = await insertSession(client as unknown as Queryable, {
        workerId,
        applicationId,
        deptId: sessionDept,
        status: "APPROVED",
        regDate: today,
        startingDate,
      });
      return { applicationId, workerId, sessionId };
    };

    await createWorker(0, "CURRENT A", deptA, deptA, dates.past);
    const exitWorker = await createWorker(1, "EXIT A", deptA, deptA, dates.past);
    const transferWorker = await createWorker(2, "TRANSFER A B", deptA, deptB, dates.past);
    await createWorker(3, "CURRENT B", deptB, deptB, dates.past);
    await createWorker(4, "INCOMING A", deptA, deptA, dates.incoming);

    await client.query(
      `INSERT INTO workforce_movements
         (movement_type, worker_id, from_dept_id, to_dept_id, effective_date, status, requested_by, reason)
       VALUES ('RESIGNATION', $1::uuid, $2::uuid, NULL, $3::date, 'INACTIVE', $6, 'SYNTHETIC VERIFICATION'),
              ('TRANSFER', $4::uuid, $2::uuid, $5::uuid, $7::date, 'TRANSFER_COMPLETED', $6, 'SYNTHETIC VERIFICATION')`,
      [exitWorker.workerId, deptA, dates.exit, transferWorker.workerId, deptB, marker, dates.transfer],
    );

    const planResult = await client.query(
      `INSERT INTO planning_periods
         (department_id, section, group_name, location, division, start_date, end_date, status, version, request_type, supplement_index, created_by)
       VALUES ($1::uuid, 'SYNTHETIC', 'SYNTHETIC', 'VERIFICATION', 'VERIFICATION', $3::date, $4::date, 'ACTIVE', 1, 'ORIGINAL', 0, $5),
              ($1::uuid, 'SYNTHETIC', 'SYNTHETIC', 'VERIFICATION', 'VERIFICATION', $3::date, $4::date, 'ACTIVE', 2, 'ORIGINAL', 0, $5),
              ($1::uuid, 'SYNTHETIC', 'SYNTHETIC', 'VERIFICATION', 'VERIFICATION', $3::date, $4::date, 'ACTIVE', 1, 'SUPPLEMENT', 1, $5),
              ($2::uuid, 'SYNTHETIC', 'SYNTHETIC', 'VERIFICATION', 'VERIFICATION', $3::date, $4::date, 'ACTIVE', 1, 'ORIGINAL', 0, $5)
       RETURNING id::text AS id, department_id::text AS department_id, version, request_type`,
      [deptA, deptB, dates.today, dates.to, marker],
    );
    const planOld = planResult.rows.find((row: JsonRecord) => row.department_id === deptA && row.version === 1 && row.request_type === "ORIGINAL");
    const planCurrent = planResult.rows.find((row: JsonRecord) => row.department_id === deptA && row.version === 2);
    const planSupplement = planResult.rows.find((row: JsonRecord) => row.department_id === deptA && row.request_type === "SUPPLEMENT");
    const planB = planResult.rows.find((row: JsonRecord) => row.department_id === deptB);
    await client.query(`UPDATE planning_periods SET superseded_by = $1::uuid WHERE id = $2::uuid`, [planCurrent?.id, planOld?.id]);
    await client.query(`UPDATE planning_periods SET parent_period_id = $1::uuid WHERE id = $2::uuid`, [planCurrent?.id, planSupplement?.id]);
    await client.query(
      `INSERT INTO planning_targets (planning_period_id, demand_male, demand_female, target_count, note)
       VALUES ($1::uuid, 50, 50, 100, 'SUPERSEDED SYNTHETIC'),
              ($2::uuid, 65, 65, 130, 'CURRENT ORIGINAL SYNTHETIC'),
              ($3::uuid, 10, 10, 20, 'SUPPLEMENT SYNTHETIC'),
              ($4::uuid, 5, 5, 10, 'CURRENT B SYNTHETIC')`,
      [planOld?.id, planCurrent?.id, planSupplement?.id, planB?.id],
    );

    await insertApplication(client as unknown as Queryable, {
      cccd: cccds[5],
      fullName: `${marker} DIAGNOSTIC APPLICATION`,
      deptId: deptA,
      status: "PENDING",
      startingDate: null,
      regDate: today,
    });
    await insertProfile(client as unknown as Queryable, cccds[6], `${marker} DIAGNOSTIC PROFILE`);
    await insertSession(client as unknown as Queryable, {
      workerId: crypto.randomUUID(),
      applicationId: null,
      deptId: deptA,
      status: "PENDING",
      regDate: today,
      startingDate: null,
    });
    const deletedProfile = await insertProfile(client as unknown as Queryable, cccds[7], `${marker} DELETED PROFILE`, true);
    await insertSession(client as unknown as Queryable, {
      workerId: deletedProfile,
      applicationId: null,
      deptId: deptA,
      status: "PENDING",
      regDate: today,
      startingDate: null,
    });

    await client.query("COMMIT");
    return {
      runId,
      marker,
      dates,
      departments: { a: { id: deptA, name: `${marker}-A` }, b: { id: deptB, name: `${marker}-B` } },
      users: {
        global: `${usernamePrefix}-global`,
        a: `${usernamePrefix}-a`,
        b: `${usernamePrefix}-b`,
        none: `${usernamePrefix}-none`,
        password,
      },
      registration: { commitCccd: cccds[8], rollbackCccd: cccds[9] },
      expected: {
        a: { demand: 150, current: 3, incoming: 1, exit: 1, transferIn: 0, transferOut: 1, expectedSupply: 2 },
        b: { demand: 10, current: 1, incoming: 0, exit: 0, transferIn: 1, transferOut: 0, expectedSupply: 2 },
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function registrationRequirements() {
  const today = todayStr();
  const result = await pool.query(
    `SELECT field_key, field_type, options
     FROM form_questions
     WHERE is_active = true AND visible_to_applicants = true
       AND (apply_from IS NULL OR apply_from <= $1::date)
       AND coalesce(target_audience, 'ALL') IN ('ALL', 'NEW_ONLY')
       AND is_required = true
     ORDER BY sort_order, id`,
    [today],
  );
  return result.rows.map((row: JsonRecord) => ({
    fieldKey: String(row.field_key),
    fieldType: String(row.field_type),
    options: Array.isArray(row.options) ? row.options.map(String) : [],
  }));
}

async function inspectRegistration(runId: string) {
  const { cccds } = fixtureIdentity(runId);
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM daily_applications WHERE cccd = $1) AS applications,
       (SELECT count(*)::int FROM worker_profiles WHERE cccd = $1 AND deleted_at IS NULL) AS profiles,
       (SELECT count(*)::int
          FROM employment_sessions es
          JOIN daily_applications a ON a.id = es.daily_application_id
          JOIN worker_profiles wp ON wp.id = es.worker_id
          WHERE a.cccd = $1 AND wp.cccd = $1) AS linked_sessions`,
    [cccds[8]],
  );
  return result.rows[0] ?? {};
}

async function proveRegistrationRollback(runId: string) {
  const client = await pool.connect();
  const { marker, cccds } = fixtureIdentity(runId);
  const rollbackMarker = `${marker}-INTENTIONAL-ROLLBACK`;
  let observed = false;
  try {
    await client.query("BEGIN");
    await persistRegistrationAtomically(
      async (callback) => callback({
        createApplication: async (input: { cccd: string; fullName: string; regDate: string }) => {
          const result = await client.query(
            `INSERT INTO daily_applications (cccd, full_name, phone, reg_date, declared_type, dw_match, status, custom_answers)
             VALUES ($1, $2, '0900000000', $3::date, 'NEW', 'NEW', 'PENDING', '{}'::jsonb)
             RETURNING id::text AS id`,
            [input.cccd, input.fullName, input.regDate],
          );
          return { id: String(result.rows[0]?.id) };
        },
        upsertProfile: async () => {
          throw new Error(rollbackMarker);
        },
        createEmploymentSession: async () => undefined,
      }),
      {
        application: { cccd: cccds[9], fullName: `${marker} ROLLBACK`, regDate: todayStr() },
        profile: { cccd: cccds[9] },
      },
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    observed = error instanceof Error && error.message === rollbackMarker;
  } finally {
    client.release();
  }
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM daily_applications WHERE cccd = $1) AS applications,
       (SELECT count(*)::int FROM worker_profiles WHERE cccd = $1) AS profiles,
       (SELECT count(*)::int FROM employment_sessions es
          JOIN daily_applications a ON a.id = es.daily_application_id WHERE a.cccd = $1) AS sessions`,
    [cccds[9]],
  );
  const counts = result.rows[0] as JsonRecord;
  return {
    intentionalFailureObserved: observed,
    rolledBack: observed && Object.values(counts).every((value) => Number(value) === 0),
    counts,
  };
}

async function stateFingerprint(runId: string) {
  const { marker, cccds } = fixtureIdentity(runId);
  const result = await pool.query(
    `WITH fixture_rows AS (
       SELECT 'application' || id::text || cccd || status || coalesce(dept_id::text, '') || updated_at::text AS value
       FROM daily_applications WHERE cccd = ANY($1::text[])
       UNION ALL
       SELECT 'profile' || id::text || cccd || coalesce(deleted_at::text, '') || updated_at::text
       FROM worker_profiles WHERE cccd = ANY($1::text[])
       UNION ALL
       SELECT 'session' || es.id::text || es.worker_id::text || coalesce(es.daily_application_id::text, '') || coalesce(es.dept_id::text, '') || es.status
       FROM employment_sessions es
       WHERE es.daily_application_id IN (SELECT id FROM daily_applications WHERE cccd = ANY($1::text[]))
          OR es.worker_id IN (SELECT id FROM worker_profiles WHERE cccd = ANY($1::text[]))
          OR es.dept_id IN (SELECT id FROM departments WHERE dept_name = ANY($2::text[]))
       UNION ALL
       SELECT 'movement' || id::text || status || updated_at::text FROM workforce_movements WHERE requested_by = $3
       UNION ALL
       SELECT 'period' || id::text || status || coalesce(superseded_by::text, '') || updated_at::text FROM planning_periods WHERE created_by = $3
       UNION ALL
       SELECT 'target' || pt.id::text || target_count::text
       FROM planning_targets pt JOIN planning_periods pp ON pp.id = pt.planning_period_id WHERE pp.created_by = $3
     )
     SELECT count(*)::int AS row_count,
            md5(coalesce(string_agg(value, '|' ORDER BY value), '')) AS digest
     FROM fixture_rows`,
    [cccds, [`${marker}-A`, `${marker}-B`], marker],
  );
  const stats = await pool.query(
    `SELECT relname, n_tup_ins::text, n_tup_upd::text, n_tup_del::text
     FROM pg_stat_user_tables WHERE relname = ANY($1::text[]) ORDER BY relname`,
    [[...TABLES]],
  );
  return { fixture: result.rows[0], tableStats: stats.rows };
}

type ExplainPlan = {
  "Node Type"?: string;
  "Actual Rows"?: number;
  "Actual Total Time"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: ExplainPlan[];
};

function summarizePlan(raw: unknown) {
  const wrapper = Array.isArray(raw) ? raw[0] as JsonRecord : {};
  const root = (wrapper?.Plan ?? {}) as ExplainPlan;
  let nodes = 0;
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  const visit = (node: ExplainPlan) => {
    nodes += 1;
    sharedHitBlocks += Number(node["Shared Hit Blocks"] ?? 0);
    sharedReadBlocks += Number(node["Shared Read Blocks"] ?? 0);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return {
    rootNode: root["Node Type"] ?? "UNKNOWN",
    actualRows: Number(root["Actual Rows"] ?? 0),
    actualTotalTimeMs: Number(root["Actual Total Time"] ?? 0),
    planningTimeMs: Number(wrapper["Planning Time"] ?? 0),
    executionTimeMs: Number(wrapper["Execution Time"] ?? 0),
    nodes,
    sharedHitBlocks,
    sharedReadBlocks,
  };
}

async function explainPrincipalQueries(runId: string) {
  const { marker } = fixtureIdentity(runId);
  const departmentIds = await findSyntheticDepartments(pool as unknown as Queryable, marker);
  if (departmentIds.length !== 2) throw new Error("Synthetic departments are unavailable for EXPLAIN.");
  const today = todayStr();
  const to = addDateDays(today, 6);
  const queries = [
    {
      name: "effective-planning",
      text: `SELECT pp.id, pp.department_id, pt.target_count
             FROM planning_periods pp LEFT JOIN planning_targets pt ON pt.planning_period_id = pp.id
             WHERE pp.status = 'ACTIVE' AND pp.superseded_by IS NULL
               AND pp.start_date <= $2::date AND pp.end_date >= $1::date
               AND pp.department_id = ANY($3::uuid[])`,
      values: [today, to, departmentIds],
    },
    {
      name: "recorded-current-workforce",
      text: `WITH ranked AS (
               SELECT es.*, row_number() OVER (PARTITION BY es.worker_id ORDER BY es.reg_date DESC, es.created_at DESC, es.id DESC) AS rn
               FROM employment_sessions es JOIN worker_profiles wp ON wp.id = es.worker_id AND wp.deleted_at IS NULL
             )
             SELECT dept_id, count(*)::int FROM ranked
             WHERE rn = 1 AND dept_id = ANY($1::uuid[]) AND status = 'APPROVED'
               AND coalesce(starting_date, reg_date) <= $2::date AND (end_date IS NULL OR end_date > $2::date)
             GROUP BY dept_id`,
      values: [departmentIds, today],
    },
    {
      name: "confirmed-movements",
      text: `SELECT movement_type, from_dept_id, to_dept_id, effective_date, count(*)::int
             FROM workforce_movements
             WHERE effective_date > $2::date AND effective_date <= $3::date
               AND (from_dept_id = ANY($1::uuid[]) OR to_dept_id = ANY($1::uuid[]))
               AND ((movement_type = 'RESIGNATION' AND status = 'INACTIVE')
                 OR (movement_type = 'TRANSFER' AND status = 'TRANSFER_COMPLETED'))
             GROUP BY movement_type, from_dept_id, to_dept_id, effective_date`,
      values: [departmentIds, today, to],
    },
    {
      name: "orphan-diagnostics",
      text: `SELECT es.dept_id,
                    count(*) FILTER (WHERE wp.id IS NULL)::int,
                    count(*) FILTER (WHERE wp.deleted_at IS NOT NULL)::int,
                    count(*) FILTER (WHERE es.daily_application_id IS NULL OR a.id IS NULL)::int
             FROM employment_sessions es
             LEFT JOIN worker_profiles wp ON wp.id = es.worker_id
             LEFT JOIN daily_applications a ON a.id = es.daily_application_id
             WHERE es.dept_id = ANY($1::uuid[])
             GROUP BY es.dept_id`,
      values: [departmentIds],
    },
  ];
  const output = [];
  for (const query of queries) {
    const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.values);
    output.push({ name: query.name, ...summarizePlan(result.rows[0]?.["QUERY PLAN"]) });
  }
  return output;
}

export async function POST(req: Request) {
  const configuredToken = process.env.WORKFORCE_VERIFICATION_TOKEN;
  const authorization = req.headers.get("authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!configuredToken || configuredToken.length < 24 || !suppliedToken || !secureEqual(suppliedToken, configuredToken)) {
    return reject(401, "Verification authorization failed.");
  }

  const expiresAtRaw = process.env.WORKFORCE_VERIFICATION_EXPIRES_AT;
  const expiresAt = expiresAtRaw ? Date.parse(expiresAtRaw) : Number.NaN;
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return reject(410, "Verification window is closed.");
  if (process.env.VERCEL_ENV !== "preview") return reject(412, "Verification is allowed only in Vercel Preview.");
  if (process.env.VERCEL_GIT_COMMIT_REF !== TARGET_GIT_REF) return reject(412, "Unexpected Vercel Git branch.");

  const config = databaseConfig();
  if (!config) return reject(412, "Database host identity did not match the configured Neon staging endpoint.");

  try {
    const identity = await preflightIdentity(config.expectedHost);
    const body = await req.json().catch(() => ({})) as JsonRecord;
    const action = String(body.action ?? "");
    const runId = String(body.runId ?? "");
    if (action !== "preflight" && !RUN_ID_RE.test(runId)) return reject(400, "Invalid synthetic run id.");

    let result: unknown;
    switch (action) {
      case "preflight":
        result = { identity };
        break;
      case "presence":
        result = await fixturePresence(pool as unknown as Queryable, runId);
        break;
      case "setup":
        result = await setupFixture(runId);
        break;
      case "registration-requirements":
        result = { questions: await registrationRequirements() };
        break;
      case "registration-inspect":
        result = await inspectRegistration(runId);
        break;
      case "registration-rollback":
        result = await proveRegistrationRollback(runId);
        break;
      case "fingerprint":
        result = await stateFingerprint(runId);
        break;
      case "explain":
        result = { plans: await explainPrincipalQueries(runId) };
        break;
      case "cleanup": {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const deleted = await cleanupFixture(client as unknown as Queryable, runId);
          await client.query("COMMIT");
          result = { deleted, presence: await fixturePresence(pool as unknown as Queryable, runId) };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        break;
      }
      default:
        return reject(400, "Unknown verification action.");
    }

    return NextResponse.json({
      ok: true,
      runtime: {
        vercelEnvironment: process.env.VERCEL_ENV,
        gitRef: process.env.VERCEL_GIT_COMMIT_REF,
        gitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      },
      identity,
      result,
    });
  } catch (error) {
    console.error("[workforce-verification]", error instanceof Error ? error.message : "unknown error");
    return reject(500, "Verification action failed; inspect protected deployment logs.");
  }
}
