-- Conversation-to-Summary System
-- Stores multi-turn dialogues, extracted facts/preferences, and user profiles
-- Supports cross-session retrieval and preference reconciliation

-- User conversation profiles
-- Tracks user metadata and dialogue context
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        UNIQUE NOT NULL,
  display_name    text,
  metadata        jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id
  ON public.user_profiles (user_id);

COMMENT ON TABLE public.user_profiles IS
  'User metadata for conversation context and preference tracking';

-- Multi-turn conversation sessions
-- Each session represents a distinct dialogue
CREATE TABLE IF NOT EXISTS public.conversation_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  session_title   text,
  topic           text,
  summary         text,
  turn_count      integer     DEFAULT 0,
  metadata        jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT fk_conversation_sessions_user_id
    FOREIGN KEY (user_id) REFERENCES user_profiles(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user_id
  ON public.conversation_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_created_at
  ON public.conversation_sessions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_topic
  ON public.conversation_sessions USING gin(to_tsvector('english', topic));

COMMENT ON TABLE public.conversation_sessions IS
  'Multi-turn dialogue sessions with topics and summaries';

-- Individual messages in a conversation
-- Lightweight storage of turn-by-turn exchange
CREATE TABLE IF NOT EXISTS public.conversation_turns (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_index      integer     NOT NULL,
  speaker         text        NOT NULL,  -- 'user' or 'assistant'
  content         text        NOT NULL,
  extracted_facts jsonb       DEFAULT '{}'::jsonb,
  metadata        jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_conversation_turns_session_id
    FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  CONSTRAINT ck_conversation_turns_speaker
    CHECK (speaker IN ('user', 'assistant'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_id
  ON public.conversation_turns (session_id, turn_index);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_extracted_facts
  ON public.conversation_turns USING gin(extracted_facts);

COMMENT ON TABLE public.conversation_turns IS
  'Individual turns in a conversation with extracted facts';

-- Extracted facts and preferences
-- Lightweight key-value facts with recency, confidence, and context
CREATE TABLE IF NOT EXISTS public.user_facts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  topic           text        NOT NULL,  -- e.g., 'work_style', 'preferences', 'constraints'
  fact_key        text        NOT NULL,  -- e.g., 'timezone', 'task_batch_size'
  fact_value      jsonb       NOT NULL,
  confidence      numeric(3,2) DEFAULT 1.0,  -- 0.0 to 1.0
  source_session_id uuid,
  source_turn_id  uuid,
  extracted_at    timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_user_facts_session_id
    FOREIGN KEY (source_session_id) REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_user_facts_turn_id
    FOREIGN KEY (source_turn_id) REFERENCES conversation_turns(id) ON DELETE SET NULL,
  CONSTRAINT ck_user_facts_confidence
    CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_user_facts_user_id_topic
  ON public.user_facts (user_id, topic);

CREATE INDEX IF NOT EXISTS idx_user_facts_user_id_key
  ON public.user_facts (user_id, fact_key);

CREATE INDEX IF NOT EXISTS idx_user_facts_last_seen
  ON public.user_facts (user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_facts_confidence
  ON public.user_facts (user_id, confidence DESC)
  WHERE confidence > 0.5;

COMMENT ON TABLE public.user_facts IS
  'Extracted facts and preferences with confidence scores and recency tracking';

-- Fact conflicts and reconciliation log
-- Tracks conflicting facts across sessions for conflict resolution
CREATE TABLE IF NOT EXISTS public.fact_conflicts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  topic           text        NOT NULL,
  fact_key        text        NOT NULL,
  conflicting_values jsonb     NOT NULL,  -- array of {value, confidence, source_session_id}
  resolved_value  jsonb,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fact_conflicts_user_id
  ON public.fact_conflicts (user_id, resolved_at)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.fact_conflicts IS
  'Tracks conflicting facts and their resolution for cross-session reconciliation';

-- Enable row-level security
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_conflicts ENABLE ROW LEVEL SECURITY;

-- RLS Policies: service role has full access, others can see their own data
CREATE POLICY "service role can manage all profiles"
  ON public.user_profiles
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service role can manage all conversations"
  ON public.conversation_sessions
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service role can manage all turns"
  ON public.conversation_turns
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service role can manage all facts"
  ON public.user_facts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service role can manage all conflicts"
  ON public.fact_conflicts
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
