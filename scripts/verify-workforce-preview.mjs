#!/usr/bin/env node

import { randomBytes } from "node:crypto";

const TARGET_REF = "staging-workforce-verification";
const baseUrl = String(process.env.VERIFY_BASE_URL ?? "").replace(/\/$/, "");
const verificationToken = process.env.WORKFORCE_VERIFICATION_TOKEN ?? "";
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
const expectedSha = process.env.EXPECTED_GIT_SHA ?? "";
const runId = process.env.VERIFY_RUN_ID ?? `wfi-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

if (!/^https:\/\//.test(baseUrl)) throw new Error("VERIFY_BASE_URL must be an exact HTTPS Vercel Preview deployment URL.");
if (verificationToken.length < 24) throw new Error("WORKFORCE_VERIFICATION_TOKEN is required (minimum 24 characters).");
if (!bypassSecret) throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is required.");
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("EXPECTED_GIT_SHA must be the 40-character SHA currently at the target branch.");
if (!/^wfi-[a-z0-9-]{6,24}$/.test(runId)) throw new Error("VERIFY_RUN_ID is invalid.");

const evidence = {
  runId,
  previewUrl: baseUrl,
  startedAt: new Date().toISOString(),
  checks: {},
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, details) {
  evidence.checks[name] = { pass: true, ...details };
  console.log(`PASS ${name}`);
}

function bypassHeaders(extra = {}) {
  return {
    "x-vercel-protection-bypass": bypassSecret,
    "x-vercel-set-bypass-cookie": "true",
    ...extra,
  };
}

async function readJson(response, label) {
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}): ${String(json.error ?? "unknown error")}`);
  return json;
}

async function verification(action, body = {}) {
  const response = await fetch(`${baseUrl}/api/internal/workforce-verification`, {
    method: "POST",
    headers: bypassHeaders({
      authorization: `Bearer ${verificationToken}`,
      "content-type": "application/json",
    }),
    body: JSON.stringify({ action, runId, ...body }),
    redirect: "manual",
  });
  const json = await readJson(response, `verification:${action}`);
  assert(json.ok === true, `verification:${action} did not return ok.`);
  assert(json.runtime?.vercelEnvironment === "preview", "Runtime is not Vercel Preview.");
  assert(json.runtime?.gitRef === TARGET_REF, "Runtime Git ref does not match target branch.");
  assert(json.runtime?.gitSha === expectedSha, "Runtime Git SHA does not match target branch SHA.");
  assert(json.identity?.connected === true, "PostgreSQL connectivity was not proven.");
  assert(json.identity?.sslEnabled === true, "PostgreSQL SSL is not enabled.");
  assert(String(json.identity?.host ?? "").endsWith(".neon.tech"), "Database host is not Neon.");
  return json;
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/(?:^|,\s*)(hasfarm_session=[^;]+)/);
  if (!match) throw new Error("Login did not set the application session cookie.");
  return match[1];
}

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: bypassHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ username, password }),
  });
  await readJson(response, `login:${username}`);
  return cookieFrom(response);
}

async function api(path, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: bypassHeaders({
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await readJson(response, `${method} ${path}`) };
}

function department(overview, id) {
  const row = overview.departments?.find((candidate) => candidate.departmentId === id);
  assert(row, `Department ${id} is absent from API response.`);
  return row;
}

function assertSupply(actual, expected, label) {
  assert(actual.demand.total === expected.demand, `${label}: demand mismatch.`);
  assert(actual.supply.recordedCurrentWorkforce === expected.current, `${label}: recorded current mismatch.`);
  assert(actual.supply.confirmedIncoming === expected.incoming, `${label}: confirmed incoming mismatch.`);
  assert(actual.supply.expectedExits === expected.exit, `${label}: expected exits mismatch.`);
  assert(actual.supply.transferIn === expected.transferIn, `${label}: transfer in mismatch.`);
  assert(actual.supply.transferOut === expected.transferOut, `${label}: transfer out mismatch.`);
  assert(actual.supply.expectedSupply === expected.expectedSupply, `${label}: expected supply mismatch.`);
  assert(actual.gap.expectedSupply === expected.expectedSupply, `${label}: gap expected supply mismatch.`);
  assert(actual.gap.gap === expected.expectedSupply - expected.demand, `${label}: canonical gap mismatch.`);
  assert(actual.gap.shortage === expected.demand - expected.expectedSupply, `${label}: shortage mismatch.`);
}

function answerFor(question, today) {
  switch (question.fieldType) {
    case "SELECT":
      assert(question.options.length > 0, `Required SELECT ${question.fieldKey} has no options.`);
      return String(question.options[0]);
    case "NUMBER":
      return "1";
    case "BOOLEAN":
      return "true";
    case "DATE":
      return today;
    default:
      return "Synthetic verification";
  }
}

function normalizeStats(rows) {
  return Object.fromEntries(rows.map((row) => [row.relname, [row.n_tup_ins, row.n_tup_upd, row.n_tup_del].join(":")]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let setupComplete = false;
let verificationError = null;

try {
  const preflight = await verification("preflight");
  assert(preflight.identity.neonBranchExpected === "staging-workforce-intelligence", "Expected Neon branch label mismatch.");
  check("preview-and-database-identity", {
    gitRef: preflight.runtime.gitRef,
    gitSha: preflight.runtime.gitSha,
    vercelEnvironment: preflight.runtime.vercelEnvironment,
    neonHost: preflight.identity.host,
    expectedNeonBranch: preflight.identity.neonBranchExpected,
    databaseFingerprint: preflight.identity.databaseFingerprint,
    postgresServerVersion: preflight.identity.serverVersionNum,
    ssl: preflight.identity.sslEnabled,
  });

  const initialPresence = await verification("presence");
  assert(initialPresence.result.clean === true, "Synthetic run id collides with existing data.");
  const setup = (await verification("setup")).result;
  setupComplete = true;
  check("synthetic-fixture-setup", {
    departmentIds: [setup.departments.a.id, setup.departments.b.id],
    from: setup.dates.today,
    to: setup.dates.to,
  });

  const cookies = {
    global: await login(setup.users.global, setup.users.password),
    a: await login(setup.users.a, setup.users.password),
    b: await login(setup.users.b, setup.users.password),
    none: await login(setup.users.none, setup.users.password),
  };

  const query = `from=${setup.dates.today}&to=${setup.dates.to}`;
  const unauthenticated = await fetch(`${baseUrl}/api/workforce-intelligence/overview?${query}`, {
    headers: bypassHeaders(),
  });
  assert(unauthenticated.status === 401, "Overview API did not reject an unauthenticated request.");

  const globalOverview = (await api(`/api/workforce-intelligence/overview?${query}`, { cookie: cookies.global })).json;
  const aOverview = (await api(`/api/workforce-intelligence/overview?${query}`, { cookie: cookies.a })).json;
  const bOverview = (await api(`/api/workforce-intelligence/overview?${query}`, { cookie: cookies.b })).json;
  const noneOverview = (await api(`/api/workforce-intelligence/overview?${query}`, { cookie: cookies.none })).json;
  const outOfScope = (await api(
    `/api/workforce-intelligence/overview?${query}&departmentId=${setup.departments.b.id}`,
    { cookie: cookies.a },
  )).json;

  assert(globalOverview.departments.some((row) => row.departmentId === setup.departments.a.id), "Global scope cannot see fixture A.");
  assert(globalOverview.departments.some((row) => row.departmentId === setup.departments.b.id), "Global scope cannot see fixture B.");
  assert(aOverview.scope.restricted === true && aOverview.departments.length === 1, "Scope A was not restricted to one department.");
  assert(aOverview.departments[0].departmentId === setup.departments.a.id, "Scope A returned a foreign department.");
  assert(bOverview.scope.restricted === true && bOverview.departments.length === 1, "Scope B was not restricted to one department.");
  assert(bOverview.departments[0].departmentId === setup.departments.b.id, "Scope B returned a foreign department.");
  assert(noneOverview.scope.restricted === true && noneOverview.departments.length === 0, "Empty scope did not fail closed.");
  assert(outOfScope.outOfScope === true && outOfScope.departments.length === 0, "Explicit out-of-scope filter did not fail closed.");
  check("http-data-scope", {
    unauthenticatedStatus: unauthenticated.status,
    globalSawFixtureDepartments: 2,
    scopeADepartments: aOverview.departments.length,
    scopeBDepartments: bOverview.departments.length,
    emptyScopeDepartments: noneOverview.departments.length,
    explicitOutOfScope: outOfScope.outOfScope,
  });

  const a = department(aOverview, setup.departments.a.id);
  const b = department(bOverview, setup.departments.b.id);
  assertSupply(a, setup.expected.a, "Department A");
  assertSupply(b, setup.expected.b, "Department B");
  assert(a.gap.coverageRate === 1.3, "Department A coverage rate mismatch.");
  assert(b.gap.coverageRate === 20, "Department B coverage rate mismatch.");
  check("planning-demand-supply-gap", {
    a: { demand: a.demand.total, supply: a.supply, gap: a.gap },
    b: { demand: b.demand.total, supply: b.supply, gap: b.gap },
    supersededOriginalExcluded: a.demand.total === 150,
  });

  const point = (date) => a.forecast.points.find((candidate) => candidate.date === date);
  assert(a.forecast.points.length === 7, "Daily forecast did not contain seven dates.");
  assert(point(setup.dates.today)?.expectedSupply === 3, "Today supply mismatch.");
  assert(point(setup.dates.incoming)?.expectedSupply === 4, "Incoming event was not applied.");
  assert(point(setup.dates.exit)?.expectedSupply === 3, "Exit event was not applied.");
  assert(point(setup.dates.transfer)?.expectedSupply === 2, "Transfer event was not applied.");
  assert(point(setup.dates.transfer)?.gap === -148, "Daily gap after transfer mismatch.");
  check("daily-forecast", {
    points: a.forecast.points.map((row) => ({
      date: row.date,
      demand: row.demand,
      expectedSupply: row.expectedSupply,
      gap: row.gap,
      coverageRate: row.coverageRate,
    })),
  });

  assert(a.diagnostics.applicationsWithoutSession === 1, "Missing-session diagnostic mismatch.");
  assert(a.diagnostics.sessionsWithoutWorker === 1, "Orphan-session diagnostic mismatch.");
  assert(a.diagnostics.sessionsWithDeletedWorker === 1, "Deleted-worker diagnostic mismatch.");
  assert(a.diagnostics.sessionsWithoutApplication === 2, "Missing-application diagnostic mismatch.");
  assert(globalOverview.diagnostics.workersWithoutSession >= 1, "Global worker-without-session diagnostic did not run.");
  check("orphan-and-missing-session-diagnostics", {
    fixtureDepartment: a.diagnostics,
    globalWorkersWithoutSession: globalOverview.diagnostics.workersWithoutSession,
  });

  await sleep(2_000);
  await verification("fingerprint");
  await sleep(2_000);
  const fingerprintBefore = (await verification("fingerprint")).result;
  const scenario = (await api(
    `/api/workforce-intelligence/scenario?${query}&departmentId=${setup.departments.a.id}`,
    {
      method: "POST",
      cookie: cookies.a,
      body: {
        targetDepartmentId: setup.departments.a.id,
        additionalIncoming: 5,
        retainedExpectedExits: 1,
        returningWorkersActivated: 0,
        recruitmentVelocityMultiplier: 1,
      },
    },
  )).json;
  await sleep(2_000);
  const fingerprintAfter = (await verification("fingerprint")).result;
  const scenarioA = department(scenario, setup.departments.a.id);
  assert(scenario.scenario.applied === true && scenario.scenario.mode === "SIMULATION", "Scenario metadata mismatch.");
  assert(scenario.scenario.classification === "ESTIMATED", "Scenario classification mismatch.");
  assert(scenarioA.supply.expectedSupply === 8, "Scenario supply mismatch.");
  assert(scenarioA.gap.gap === -142, "Scenario gap mismatch.");
  assert(fingerprintBefore.fixture.digest === fingerprintAfter.fixture.digest, "Scenario changed fixture rows.");
  assert(fingerprintBefore.fixture.row_count === fingerprintAfter.fixture.row_count, "Scenario changed fixture row count.");
  assert(
    JSON.stringify(normalizeStats(fingerprintBefore.tableStats)) === JSON.stringify(normalizeStats(fingerprintAfter.tableStats)),
    "Scenario caused tuple writes in a Workforce Intelligence table (or staging had concurrent writes).",
  );
  check("scenario-read-only", {
    mode: scenario.scenario.mode,
    classification: scenario.scenario.classification,
    baselineExpectedSupply: a.supply.expectedSupply,
    scenarioExpectedSupply: scenarioA.supply.expectedSupply,
    fixtureDigestUnchanged: true,
    postgresTupleWriteCountersUnchanged: true,
  });

  const requirements = (await verification("registration-requirements")).result.questions;
  const customAnswers = Object.fromEntries(requirements.map((question) => [question.fieldKey, answerFor(question, setup.dates.today)]));
  const registrationResponse = await fetch(`${baseUrl}/api/registrations`, {
    method: "POST",
    headers: bypassHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      cccd: setup.registration.commitCccd,
      fullName: `${setup.marker} REGISTRATION COMMIT`,
      phone: "0900000000",
      gender: "Nam",
      dob: "01/01/1990",
      ethnicity: "Synthetic",
      permanentAddress: "Synthetic verification only",
      residentialAddress: "Synthetic verification only",
      workDuration: "Synthetic",
      referralChannel: "SYNTHETIC_VERIFICATION",
      customAnswers,
    }),
  });
  const registrationJson = await readJson(registrationResponse, "POST /api/registrations");
  assert(registrationResponse.status === 201 && registrationJson.success === true, "Registration commit HTTP response mismatch.");
  const committed = (await verification("registration-inspect")).result;
  assert(committed.applications === 1 && committed.profiles === 1 && committed.linked_sessions === 1, "Committed registration is incomplete.");
  const rollback = (await verification("registration-rollback")).result;
  assert(rollback.intentionalFailureObserved === true && rollback.rolledBack === true, "Registration rollback proof failed.");
  check("registration-transaction-commit-and-rollback", {
    commitHttpStatus: registrationResponse.status,
    committedCounts: committed,
    rollbackCounts: rollback.counts,
    intentionalFailureObserved: rollback.intentionalFailureObserved,
  });

  const explained = (await verification("explain")).result.plans;
  assert(explained.length === 4, "Not all principal queries were explained.");
  assert(explained.every((plan) => Number.isFinite(plan.executionTimeMs)), "EXPLAIN output is incomplete.");
  check("safe-explain-analyze-buffers", { plans: explained });
} catch (error) {
  verificationError = error;
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (setupComplete) {
    try {
      const cleanup = (await verification("cleanup")).result;
      assert(cleanup.presence.clean === true, "Synthetic cleanup left fixture rows behind.");
      check("synthetic-fixture-cleanup", { deleted: cleanup.deleted, clean: cleanup.presence.clean });
    } catch (cleanupError) {
      console.error(`FAIL cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      verificationError ??= cleanupError;
    }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.pass = verificationError === null;
  console.log(`WORKFORCE_VERIFICATION_RESULT=${JSON.stringify(evidence)}`);
}

if (verificationError) process.exitCode = 1;
