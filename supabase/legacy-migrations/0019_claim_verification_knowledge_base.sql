-- Claim Verification System
-- Curated knowledge base for fact-checking and claim verification during conversations
-- Supports semantic matching, confidence thresholds, and human review workflows

-- Knowledge base entries
-- Stores verified facts, claims, and reference materials
CREATE TABLE IF NOT EXISTS public.knowledge_base_entries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  category        text        NOT NULL,  -- e.g., 'technical', 'process', 'business', 'policy'
  claim           text        NOT NULL,  -- the actual claim or fact
  description     text,                  -- detailed explanation
  source_url      text,                  -- reference URL if available
  source_title    text,                  -- reference title
  confidence      numeric(3,2) NOT NULL DEFAULT 1.0,  -- 0.0-1.0, verifier confidence
  verified_by     text,                  -- who verified this (user, role, system)
  verified_at     timestamptz,
  claim_vector    vector(1536),          -- pgvector embedding for semantic search
  keywords        text[],                -- searchable keywords
  related_entries uuid[],                -- IDs of related knowledge entries
  metadata        jsonb       DEFAULT '{}'::jsonb,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_kb_confidence
    CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_kb_category_active
  ON public.knowledge_base_entries (category, is_active);

CREATE INDEX IF NOT EXISTS idx_kb_keywords_gin
  ON public.knowledge_base_entries USING gin(keywords);

CREATE INDEX IF NOT EXISTS idx_kb_claim_tsvector
  ON public.knowledge_base_entries USING gin(to_tsvector('english', claim));

CREATE INDEX IF NOT EXISTS idx_kb_vector
  ON public.knowledge_base_entries USING ivfflat (claim_vector vector_cosine_ops)
  WHERE is_active = true;

COMMENT ON TABLE public.knowledge_base_entries IS
  'Curated knowledge base for fact-checking claims during conversations';

COMMENT ON COLUMN public.knowledge_base_entries.confidence IS
  'Verifier confidence in this claim (1.0 = highly confident, lower = less certain)';

COMMENT ON COLUMN public.knowledge_base_entries.claim_vector IS
  'Vector embedding for semantic similarity search';

-- Claim extraction from conversations
-- Stores claims extracted from user messages with verification status
CREATE TABLE IF NOT EXISTS public.extracted_claims (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id         uuid        NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  user_id         text        NOT NULL,
  claim_text      text        NOT NULL,
  claim_vector    vector(1536),          -- embedding of extracted claim
  extracted_at    timestamptz NOT NULL DEFAULT now(),
  verification_status text    NOT NULL DEFAULT 'unverified',  -- 'unverified', 'verified', 'disputed', 'flagged_review'
  metadata        jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_extracted_claims_session_id
    FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_extracted_claims_turn_id
    FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE,
  CONSTRAINT ck_extracted_claims_status
    CHECK (verification_status IN ('unverified', 'verified', 'disputed', 'flagged_review'))
);

CREATE INDEX IF NOT EXISTS idx_extracted_claims_session_id
  ON public.extracted_claims (session_id);

CREATE INDEX IF NOT EXISTS idx_extracted_claims_user_id
  ON public.extracted_claims (user_id, verification_status);

CREATE INDEX IF NOT EXISTS idx_extracted_claims_vector
  ON public.extracted_claims USING ivfflat (claim_vector vector_cosine_ops)
  WHERE claim_vector IS NOT NULL;

COMMENT ON TABLE public.extracted_claims IS
  'Claims extracted from user messages with verification status';

-- Verification results
-- Links extracted claims to matching knowledge base entries with scores
CREATE TABLE IF NOT EXISTS public.verification_results (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        uuid        NOT NULL REFERENCES extracted_claims(id) ON DELETE CASCADE,
  kb_entry_id     uuid        REFERENCES knowledge_base_entries(id) ON DELETE SET NULL,
  similarity_score numeric(3,2) NOT NULL,  -- 0.0-1.0 semantic match score
  match_type      text        NOT NULL,    -- 'supported', 'contradicted', 'partial', 'unrelated'
  confidence      numeric(3,2) NOT NULL DEFAULT 0.5,  -- confidence in this verification
  explanation     text,                   -- human-readable explanation
  reviewer_notes  text,                   -- notes from manual review
  reviewed_at     timestamptz,
  reviewed_by     text,                   -- user/system that reviewed
  flagged_for_review boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_verification_kb_entry
    FOREIGN KEY (kb_entry_id) REFERENCES knowledge_base_entries(id) ON DELETE SET NULL,
  CONSTRAINT ck_verification_scores
    CHECK (similarity_score >= 0.0 AND similarity_score <= 1.0 AND confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_verification_claim_id
  ON public.verification_results (claim_id);

CREATE INDEX IF NOT EXISTS idx_verification_kb_entry_id
  ON public.verification_results (kb_entry_id);

CREATE INDEX IF NOT EXISTS idx_verification_flagged
  ON public.verification_results (flagged_for_review)
  WHERE flagged_for_review = true;

CREATE INDEX IF NOT EXISTS idx_verification_match_type
  ON public.verification_results (claim_id, match_type);

COMMENT ON TABLE public.verification_results IS
  'Links extracted claims to knowledge base entries with semantic scores';

-- Verification audit log
-- Tracks all verification operations for audit and learning
CREATE TABLE IF NOT EXISTS public.verification_audit_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        uuid        NOT NULL REFERENCES extracted_claims(id) ON DELETE CASCADE,
  operation       text        NOT NULL,  -- 'extracted', 'verified', 'disputed', 'reviewed', 'updated'
  actor_type      text        NOT NULL,  -- 'system', 'user', 'human_reviewer'
  actor_id        text,
  details         jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_audit_claim_id
    FOREIGN KEY (claim_id) REFERENCES extracted_claims(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_claim_id
  ON public.verification_audit_log (claim_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_operation
  ON public.verification_audit_log (operation, created_at DESC);

COMMENT ON TABLE public.verification_audit_log IS
  'Audit trail for all verification operations';

-- Enable row-level security
ALTER TABLE public.knowledge_base_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extracted_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_audit_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "service role can manage all kb entries"
  ON public.knowledge_base_entries
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service role can manage all extracted claims"
  ON public.extracted_claims
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service role can manage all verification results"
  ON public.verification_results
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "service role can manage all audit logs"
  ON public.verification_audit_log
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Seed some initial knowledge base entries
-- Technical claims
INSERT INTO public.knowledge_base_entries (
  category, claim, description, source_title, confidence, verified_by, verified_at, keywords, is_active
) VALUES
  ('technical', 'PostgreSQL supports full-text search through the tsvector type', 'PostgreSQL has built-in full-text search capabilities using the tsvector data type and search operators like @@', 'PostgreSQL Documentation', 1.0, 'system', now(), ARRAY['postgresql', 'search', 'tsvector', 'database'], true),
  ('technical', 'Next.js 14 uses the App Router by default for file-based routing', 'Next.js 14 introduced the App Router as the recommended routing system, replacing the Pages Router', 'Next.js Official Docs', 1.0, 'system', now(), ARRAY['nextjs', 'routing', 'app-router', 'framework'], true),
  ('technical', 'React Server Components allow rendering directly on the server without sending JavaScript to the client', 'React Server Components (RSC) execute on the server and only send HTML and required data to the client', 'React Documentation', 0.95, 'system', now(), ARRAY['react', 'server-components', 'performance', 'architecture'], true),
  ('technical', 'TypeScript provides static type checking for JavaScript', 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript and provides compile-time type checking', 'TypeScript Handbook', 1.0, 'system', now(), ARRAY['typescript', 'types', 'javascript', 'tooling'], true),
  
  -- Process claims
  ('process', 'Pair programming can improve code quality by catching errors earlier', 'Research shows pair programming reduces defects and improves knowledge sharing', 'Software Engineering Research', 0.85, 'system', now(), ARRAY['process', 'code-review', 'quality', 'teamwork'], true),
  ('process', 'Test-driven development (TDD) requires writing tests before implementation', 'TDD is a methodology where developers write failing tests first, then implement code to make them pass', 'TDD Best Practices', 0.9, 'system', now(), ARRAY['testing', 'tdd', 'development', 'quality'], true),
  
  -- Business claims
  ('business', 'Supabase is an open-source Firebase alternative built on PostgreSQL', 'Supabase provides backend-as-a-service capabilities with PostgreSQL as the database', 'Supabase Official Site', 1.0, 'system', now(), ARRAY['supabase', 'firebase', 'backend', 'database'], true),
  ('business', 'Real-time subscriptions reduce latency in user interfaces', 'Real-time database subscriptions enable instant UI updates without polling', 'Database Architecture Patterns', 0.9, 'system', now(), ARRAY['realtime', 'performance', 'ux', 'database'], true),
  
  -- Policy claims
  ('policy', 'Code changes should be reviewed before merging to main branch', 'Pull request reviews are a best practice to maintain code quality and catch issues', 'Engineering Standards', 0.95, 'system', now(), ARRAY['policy', 'code-review', 'git', 'workflow'], true)
ON CONFLICT DO NOTHING;
