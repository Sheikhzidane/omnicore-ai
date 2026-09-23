/**
 * Route access policy — the single source of truth for who may reach what.
 * Pure (no I/O) so it can be unit-tested exhaustively; enforced by proxy.ts
 * and re-checked inside privileged route handlers (defence in depth).
 *
 *   public  — anyone (marketing pages, login, signed webhooks, newsletter signup)
 *   user    — any signed-in, allow-listed user (the OS application)
 *   ops     — platform admins only (legacy Pantheon /ops dashboard + its APIs)
 *
 * Default-deny: an /api path not listed here is `ops`; any other page is `user`.
 */

export type Access = 'public' | 'user' | 'ops'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

interface Rule {
  /** Exact path, or a prefix when it ends with '/'. */
  path: string
  access: Access
  /** Limit the rule to these methods; others fall through to later rules. */
  methods?: Method[]
  /** Why this is not default-protected (public rules must justify themselves). */
  reason?: string
}

const RULES: Rule[] = [
  // ── Auth flow ──────────────────────────────────────────────────────────────
  { path: '/login', access: 'public', reason: 'sign-in page' },
  { path: '/auth/', access: 'public', reason: 'Supabase auth callback (code exchange)' },
  { path: '/logout', access: 'public', reason: 'POST-only sign-out; harmless without a session' },
  { path: '/', access: 'public', reason: 'redirects to /dashboard or /login based on session' },

  // ── Public marketing pages (legacy Pantheon content) ───────────────────────
  { path: '/about', access: 'public', reason: 'marketing' },
  { path: '/contact', access: 'public', reason: 'marketing' },
  { path: '/privacy', access: 'public', reason: 'privacy policy' },
  { path: '/subscribe', access: 'public', reason: 'newsletter signup page' },
  { path: '/topics', access: 'public', reason: 'legacy SEO articles' },
  { path: '/topics/', access: 'public', reason: 'legacy SEO articles' },
  { path: '/de/topics/', access: 'public', reason: 'legacy SEO articles' },
  { path: '/es/topics/', access: 'public', reason: 'legacy SEO articles' },
  { path: '/fr/topics/', access: 'public', reason: 'legacy SEO articles' },
  { path: '/robots.txt', access: 'public', reason: 'crawler metadata' },
  { path: '/sitemap.xml', access: 'public', reason: 'crawler metadata' },
  { path: '/ads.txt', access: 'public', reason: 'ad network metadata' },

  // ── Public APIs (each handler performs its own verification) ───────────────
  { path: '/api/subscribe', access: 'public', methods: ['POST'], reason: 'newsletter signup; validated + rate-limited' },
  { path: '/api/og', access: 'public', methods: ['GET'], reason: 'Open Graph image rendering' },
  { path: '/api/webhooks/', access: 'public', methods: ['POST'], reason: 'signature/token verified in handler; fails closed' },

  // ── Product APIs (workspace-scoped; handlers call requireWorkspaceApi) ─────
  { path: '/api/v1/', access: 'user' },

  // ── Ops ───────────────────────────────────────────────────────────────────
  { path: '/ops', access: 'ops' },
  { path: '/ops/', access: 'ops' },
  { path: '/api/', access: 'ops' }, // default-deny for every other API route
]

function matches(rule: Rule, pathname: string, method: string): boolean {
  if (rule.methods && !rule.methods.includes(method.toUpperCase() as Method)) return false
  return rule.path.endsWith('/') && rule.path !== '/'
    ? pathname.startsWith(rule.path)
    : pathname === rule.path
}

export function classifyRoute(pathname: string, method = 'GET'): Access {
  // Normalise: strip trailing slash (except root) so /about/ === /about.
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  for (const rule of RULES) {
    if (matches(rule, path, method)) return rule.access
  }
  return 'user'
}

/** Public rules, exported for the coverage test that audits every route file. */
export const PUBLIC_RULES: ReadonlyArray<Readonly<Rule>> = RULES.filter(r => r.access === 'public')

/**
 * Sanitises a post-login redirect target. Only same-origin relative paths are
 * allowed — blocks open redirects like `//evil.com`, `https://evil.com`,
 * `/\evil.com` and `javascript:` URLs.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || typeof next !== 'string') return fallback
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (/[\u0000-\u001f]/.test(next)) return fallback
  try {
    const u = new URL(next, 'http://local.invalid')
    if (u.origin !== 'http://local.invalid') return fallback
    if (u.pathname.startsWith('/login') || u.pathname.startsWith('/auth/') || u.pathname === '/logout') return fallback
    return u.pathname + u.search + u.hash
  } catch {
    return fallback
  }
}

/** Parses a comma-separated email allow-list env var (case-insensitive). */
export function parseEmailList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(e => e.includes('@')),
  )
}

/**
 * V1 single-owner gate. When AUTH_ALLOWED_EMAILS is set, only those emails may
 * use the app. When unset, any authenticated user may (each is isolated in
 * their own workspace by RLS).
 */
export function isEmailAllowed(email: string | null | undefined, allowList: Set<string>): boolean {
  if (allowList.size === 0) return true
  return !!email && allowList.has(email.toLowerCase())
}
