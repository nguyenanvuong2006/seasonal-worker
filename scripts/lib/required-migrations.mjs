/**
 * REQUIRED-MIGRATION CONTRACT (Mission B section 17/18).
 * ------------------------------------------------------------
 * Machine-readable registry of migrations the CURRENT app code absolutely
 * depends on, each paired with a deterministic structural evidence probe
 * built from the shared primitives in scripts/lib/schema-probes.mjs (no
 * duplicated SQL — section 18).
 *
 * This registry does NOT apply migrations. It only answers, read-only:
 * "does the schema this migration is supposed to have created actually
 * exist right now?" A probe passing does NOT prove the migration ran
 * (another migration/hotfix could have created the same objects — section
 * 6's explicit warning); it only proves the app's hard runtime dependency
 * is currently satisfied structurally. Combine with the ledger (when
 * bootstrapped) for provenance.
 *
 * Covers the five migrations Mission B section 17 explicitly calls out as
 * minimum required coverage: ai_action_proposals, ai_conversations,
 * Electronic Confirmation deadline/engagement columns, workforce
 * lifecycle_applied_at, recruitment snapshot columns.
 */
import {
  tableExists,
  columnExists,
  indexExists,
  constraintExists,
  scheduledJobExists,
} from "./schema-probes.mjs";

/** @typedef {{label: string, ok: boolean}} ProbeCheck */
/**
 * @typedef {Object} RequiredMigration
 * @property {string} migrationId
 * @property {string} description
 * @property {(client: unknown) => Promise<ProbeCheck[]>} probe
 */

/** @type {RequiredMigration[]} */
export const REQUIRED_MIGRATIONS = [
  {
    migrationId: "2026-09-09-ai-action-proposals.sql",
    description: "ai_action_proposals table (AI Copilot tamper-proof proposal store)",
    probe: async (client) => [
      { label: "table:ai_action_proposals", ok: await tableExists(client, "ai_action_proposals") },
      { label: "index:ai_action_proposal_idempotency_uq", ok: await indexExists(client, "ai_action_proposal_idempotency_uq") },
      { label: "constraint:ai_action_proposal_status_chk", ok: await constraintExists(client, "ai_action_proposal_status_chk") },
    ],
  },
  {
    migrationId: "2026-09-10-ai-copilot-conversations.sql",
    description: "ai_conversations / ai_conversation_messages tables (AI Copilot chat persistence)",
    probe: async (client) => [
      { label: "table:ai_conversations", ok: await tableExists(client, "ai_conversations") },
      { label: "table:ai_conversation_messages", ok: await tableExists(client, "ai_conversation_messages") },
      { label: "index:ai_conversation_message_conversation_idx", ok: await indexExists(client, "ai_conversation_message_conversation_idx") },
    ],
  },
  {
    migrationId: "2026-09-10-electronic-confirmation-deadline-engagement.sql",
    description: "candidate_documents.employment_session_id / confirmation_deadline_at (Electronic Confirmation deadline + engagement model)",
    probe: async (client) => [
      { label: "column:candidate_documents.employment_session_id", ok: await columnExists(client, "candidate_documents", "employment_session_id") },
      { label: "column:candidate_documents.confirmation_deadline_at", ok: await columnExists(client, "candidate_documents", "confirmation_deadline_at") },
      { label: "index:candidate_document_status_deadline_idx", ok: await indexExists(client, "candidate_document_status_deadline_idx") },
    ],
  },
  {
    migrationId: "2026-09-10-workforce-movement-effective-lifecycle.sql",
    description: "workforce_movements.lifecycle_applied_at + apply_effective_workforce_movements scheduled job",
    probe: async (client) => [
      { label: "column:workforce_movements.lifecycle_applied_at", ok: await columnExists(client, "workforce_movements", "lifecycle_applied_at") },
      { label: "index:workforce_movement_pending_effect_idx", ok: await indexExists(client, "workforce_movement_pending_effect_idx") },
      { label: "scheduled_job:apply_effective_workforce_movements", ok: await scheduledJobExists(client, "apply_effective_workforce_movements") },
    ],
  },
  {
    migrationId: "2026-09-09-recruitment-requests-snapshot-columns-only.sql",
    description: "recruitment_requests snapshot columns (male/female/total_current_at_start, snapshot_at) — the columns app queries SELECT * on",
    probe: async (client) => [
      { label: "column:recruitment_requests.male_current_at_start", ok: await columnExists(client, "recruitment_requests", "male_current_at_start") },
      { label: "column:recruitment_requests.female_current_at_start", ok: await columnExists(client, "recruitment_requests", "female_current_at_start") },
      { label: "column:recruitment_requests.total_current_at_start", ok: await columnExists(client, "recruitment_requests", "total_current_at_start") },
      { label: "column:recruitment_requests.snapshot_at", ok: await columnExists(client, "recruitment_requests", "snapshot_at") },
    ],
  },
];

/**
 * Runs every registered probe against `client` and returns per-migration
 * results: { migrationId, description, checks, allPresent }.
 * Read-only. Never throws for a missing object — a failed probe is just
 * `ok: false` in `checks`; only a genuine DB/query error propagates.
 */
export async function checkRequiredMigrationEvidence(client) {
  const results = [];
  for (const rm of REQUIRED_MIGRATIONS) {
    const checks = await rm.probe(client);
    results.push({
      migrationId: rm.migrationId,
      description: rm.description,
      checks,
      allPresent: checks.every((c) => c.ok),
    });
  }
  return results;
}
