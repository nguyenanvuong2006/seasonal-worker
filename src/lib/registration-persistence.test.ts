import test from "node:test";
import assert from "node:assert/strict";
import {
  persistRegistrationAtomically,
  type RegistrationTransactionRunner,
} from "./registration-persistence.ts";

type AppInput = { cccd: string; date: string };
type App = AppInput & { id: string };
type ProfileInput = { cccd: string; name: string };
type Profile = ProfileInput & { id: string };
type State = { applications: App[]; profiles: Profile[]; sessions: { applicationId: string; workerId: string }[] };

function fixture(failAt?: "application" | "profile" | "session") {
  const state: State = { applications: [], profiles: [], sessions: [] };
  const run: RegistrationTransactionRunner<AppInput, App, ProfileInput, Profile> = async (callback) => {
    const draft = structuredClone(state);
    try {
      const result = await callback({
        createApplication: async (input) => {
          if (failAt === "application") throw new Error("duplicate registration");
          if (draft.applications.some((a) => a.cccd === input.cccd && a.date === input.date)) throw new Error("duplicate registration");
          const row = { ...input, id: `a${draft.applications.length + 1}` };
          draft.applications.push(row);
          return row;
        },
        upsertProfile: async (input) => {
          if (failAt === "profile") throw new Error("profile failed");
          const existing = draft.profiles.find((p) => p.cccd === input.cccd);
          if (existing) {
            existing.name = input.name;
            return existing;
          }
          const row = { ...input, id: `p${draft.profiles.length + 1}` };
          draft.profiles.push(row);
          return row;
        },
        createEmploymentSession: async ({ application, profile }) => {
          if (failAt === "session") throw new Error("session failed");
          draft.sessions.push({ applicationId: application.id, workerId: profile.id });
        },
      });
      state.applications = draft.applications;
      state.profiles = draft.profiles;
      state.sessions = draft.sessions;
      return result;
    } catch (error) {
      // draft is discarded: synthetic equivalent of PostgreSQL rollback.
      throw error;
    }
  };
  const persist = (name = "Synthetic Worker") => persistRegistrationAtomically(run, {
    application: { cccd: "000000000001", date: "2026-08-15" },
    profile: { cccd: "000000000001", name },
  });
  return { state, persist };
}

test("registration transaction: all writes commit together", async () => {
  const { state, persist } = fixture();
  await persist();
  assert.deepEqual(state.applications.map((r) => r.id), ["a1"]);
  assert.deepEqual(state.profiles.map((r) => r.id), ["p1"]);
  assert.deepEqual(state.sessions, [{ applicationId: "a1", workerId: "p1" }]);
});

test("registration transaction: profile error rolls application back", async () => {
  const { state, persist } = fixture("profile");
  await assert.rejects(persist(), /profile failed/);
  assert.deepEqual(state, { applications: [], profiles: [], sessions: [] });
});

test("registration transaction: employment session error rolls application/profile back", async () => {
  const { state, persist } = fixture("session");
  await assert.rejects(persist(), /session failed/);
  assert.deepEqual(state, { applications: [], profiles: [], sessions: [] });
});

test("registration transaction: duplicate registration does not add partial rows", async () => {
  const { state, persist } = fixture();
  await persist();
  const before = structuredClone(state);
  await assert.rejects(persist(), /duplicate registration/);
  assert.deepEqual(state, before);
});

test("registration transaction: returning worker upsert reuses one profile", async () => {
  const { state, persist } = fixture();
  await persist("First Name");
  // A different date represents the next registration while preserving identity.
  state.applications[0].date = "2026-08-14";
  await persist("Updated Name");
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].name, "Updated Name");
  assert.equal(state.sessions.length, 2);
});

test("registration route uses a real Drizzle transaction boundary", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../app/api/registrations/route.ts", import.meta.url), "utf8"));
  assert.match(source, /db\.transaction\(async \(tx\)/);
  assert.match(source, /persistRegistrationAtomically/);
});
