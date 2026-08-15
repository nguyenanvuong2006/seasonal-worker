import "server-only";
import type { Session } from "@/lib/auth";
import { getWorkforceIntelligence } from "./service.ts";
import type { OutlookFilters } from "./types.ts";

/**
 * Controlled backend tools available to the AI orchestration layer. They accept a
 * Session, never a caller-provided scope, and only return aggregate/no-PII data.
 */
export async function get_workforce_outlook(session: Session, args: OutlookFilters) {
  return getWorkforceIntelligence(session, args);
}

export async function get_department_risk(session: Session, args: OutlookFilters & { departmentId: string }) {
  const data = await getWorkforceIntelligence(session, args);
  return data.departments[0]?.risk ?? null;
}

export async function get_demand_supply_gap(session: Session, args: OutlookFilters) {
  const data = await getWorkforceIntelligence(session, args);
  return { period: data.period, scope: data.scope, demand: data.demand, supply: data.supply, gap: data.gap };
}

export async function get_recruitment_velocity(session: Session, args: OutlookFilters) {
  const data = await getWorkforceIntelligence(session, args);
  return { period: data.period, scope: data.scope, conversion: data.conversion, velocity: data.velocity, requiredApplications: data.requiredApplications };
}

export async function get_pipeline_forecast(session: Session, args: OutlookFilters) {
  const data = await getWorkforceIntelligence(session, args);
  return { period: data.period, scope: data.scope, pipeline: data.pipeline };
}

export async function get_referral_performance(session: Session, args: OutlookFilters) {
  const data = await getWorkforceIntelligence(session, args);
  return { period: data.period, scope: data.scope, referralPerformance: data.referralPerformance };
}

export async function get_returning_worker_pool(session: Session, args: OutlookFilters) {
  const data = await getWorkforceIntelligence(session, args);
  return { period: data.period, scope: data.scope, returningWorkerOpportunity: data.returningWorkerOpportunity };
}

export async function get_expected_exits(session: Session, args: OutlookFilters) {
  const data = await getWorkforceIntelligence(session, args);
  return { period: data.period, scope: data.scope, expectedExits: data.expectedExits };
}

export async function get_action_recommendations(session: Session, args: OutlookFilters) {
  const data = await getWorkforceIntelligence(session, args);
  return { period: data.period, scope: data.scope, recommendedActions: data.recommendedActions };
}
