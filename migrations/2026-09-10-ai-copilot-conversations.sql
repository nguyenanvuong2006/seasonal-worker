-- AI Copilot conversation persistence (2026-09-10).
-- ADDITIVE ONLY: two brand-new tables, real FKs to existing users(id) with
-- ON DELETE CASCADE (a deleted user's conversations/messages are removed
-- with them — never orphaned, never resurrected against a new user).
-- Does NOT modify, backfill, or touch any existing table/row.
-- Idempotent: every statement is CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title varchar(200),
  status varchar(16) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_conversation_status_chk CHECK (status IN ('ACTIVE', 'DELETED'))
);

CREATE INDEX IF NOT EXISTS ai_conversation_user_idx ON ai_conversations (user_id);
CREATE INDEX IF NOT EXISTS ai_conversation_user_last_message_idx ON ai_conversations (user_id, last_message_at);

CREATE TABLE IF NOT EXISTS ai_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  role varchar(16) NOT NULL,
  content text NOT NULL,
  tool_call_log jsonb,
  analysis_cards jsonb,
  proposal_refs jsonb,
  client_message_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_conversation_message_role_chk CHECK (role IN ('USER', 'ASSISTANT'))
);

CREATE INDEX IF NOT EXISTS ai_conversation_message_conversation_idx ON ai_conversation_messages (conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_conversation_message_client_id_uq ON ai_conversation_messages (conversation_id, client_message_id);

-- Real FKs (added separately, matching this repo's convention of declaring
-- FKs in migration SQL rather than inline Drizzle .references() — see
-- organization_units/employment_sessions self-references for precedent).
-- Guarded so re-running this file is a no-op if the constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_conversations_user_id_fk'
  ) THEN
    ALTER TABLE ai_conversations
      ADD CONSTRAINT ai_conversations_user_id_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_conversation_messages_conversation_id_fk'
  ) THEN
    ALTER TABLE ai_conversation_messages
      ADD CONSTRAINT ai_conversation_messages_conversation_id_fk
      FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE;
  END IF;
END $$;
