/**
 * AI COPILOT — pure gender classification. No "server-only", no DB —
 * directly unit-testable (node:test), mirroring time-resolver.ts/
 * risk-rules.ts's own pure/no-DB convention.
 *
 * Wraps the EXACT SAME isMale/isFemale predicates already used everywhere
 * else in the codebase (recruitment-kpi.ts, ai-copilot/tools/organization.ts,
 * ai-copilot/tools/analytics.ts) — this is deliberately NOT a second
 * definition of male/female, just a shared tri-state view of them.
 *
 * worker_profiles.gender is a free-text varchar with no DB enum, and no
 * other legitimate third gender category exists anywhere in the system
 * (the applicant intake form itself only ever writes "Nam" or "Nữ" —
 * see applicant-portal.tsx). UNKNOWN therefore means exactly "NULL, empty,
 * or an unrecognized value" — never a real third classification, and never
 * inferred from a name or any other heuristic.
 */
import { isFemale, isMale } from "../helpers.ts";

export type GenderClassification = "MALE" | "FEMALE" | "UNKNOWN";

export function classifyGender(gender: string | null | undefined): GenderClassification {
  if (isMale(gender)) return "MALE";
  if (isFemale(gender)) return "FEMALE";
  return "UNKNOWN";
}

export type GenderTally = { male: number; female: number; unknownGender: number; total: number };

/** Tally a list of gender strings into the 3-way split. male + female + unknownGender === total always, by construction. */
export function tallyGender(genders: (string | null | undefined)[]): GenderTally {
  let male = 0;
  let female = 0;
  let unknownGender = 0;
  for (const g of genders) {
    const cls = classifyGender(g);
    if (cls === "MALE") male += 1;
    else if (cls === "FEMALE") female += 1;
    else unknownGender += 1;
  }
  return { male, female, unknownGender, total: genders.length };
}
