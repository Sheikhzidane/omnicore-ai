-- Email subscribers for the dashboard product.
-- Stores people who sign up via /subscribe, embedded forms on articles, etc.

CREATE TABLE IF NOT EXISTS public.subscribers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext      UNIQUE NOT NULL,
  source      text        NOT NULL DEFAULT 'unknown',
  referrer    text,
  confirmed   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_subscribers_created_at
  ON public.subscribers (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscribers_source
  ON public.subscribers (source);

-- Enable citext for case-insensitive email dedup (first migration that needs it)
CREATE EXTENSION IF NOT EXISTS citext;

-- Row-level security: lock down by default
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;

-- Anyone can INSERT a new signup (public form)
CREATE POLICY "anyone can subscribe"
  ON public.subscribers
  FOR INSERT
  WITH CHECK (true);

-- Only service role reads the list (dashboard owner uses service-role key)
CREATE POLICY "service role can read all"
  ON public.subscribers
  FOR SELECT
  USING (auth.role() = 'service_role');

COMMENT ON TABLE public.subscribers IS
  'Email signups from /subscribe page, embedded forms on articles, etc.';
