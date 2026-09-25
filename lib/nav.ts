/**
 * Application navigation — the single source for the sidebar (desktop and
 * mobile). Every section links to a real page; tests/ui/nav.test.ts checks a
 * page file exists for each href.
 */

export interface NavSection { href: string; label: string }
export interface NavModule {
  href: string
  label: string
  icon: string
  description: string
  sections?: NavSection[]
  opsOnly?: boolean
}

export const NAV: NavModule[] = [
  { href: '/dashboard', label: 'Dashboard', icon: '◧', description: 'Workspace overview' },
  {
    href: '/characters', label: 'Characters', icon: '◎', description: 'AI characters and their identity',
    sections: [
      { href: '/characters', label: 'Library' },
      { href: '/characters/new', label: 'Create' },
    ],
  },
  {
    href: '/content', label: 'Content Studio', icon: '✎', description: 'Ideas, generation, approval and publishing',
    sections: [
      { href: '/content/ideas', label: 'Ideas' },
      { href: '/content/generator', label: 'Generator' },
      { href: '/content/assets', label: 'Generated Assets' },
      { href: '/content/calendar', label: 'Calendar' },
      { href: '/content/approvals', label: 'Approval Queue' },
      { href: '/content/publishing', label: 'Publishing Queue' },
      { href: '/content/history', label: 'History' },
    ],
  },
  { href: '/social', label: 'Social Accounts', icon: '⌁', description: 'Connect Instagram, TikTok, YouTube and X' },
  {
    href: '/agents', label: 'AI Agents', icon: '⚙', description: 'Agent control centre',
    sections: [
      { href: '/agents', label: 'Control Centre' },
      { href: '/agents/tasks', label: 'Tasks' },
      { href: '/agents/runs', label: 'Runs' },
      { href: '/agents/events', label: 'Event Logs' },
      { href: '/agents/approvals', label: 'Approval Requests' },
      { href: '/agents/failures', label: 'Failures' },
    ],
  },
  {
    href: '/growth', label: 'Growth', icon: '↗', description: 'Analytics from connected platforms',
    sections: [
      { href: '/growth', label: 'Analytics' },
      { href: '/growth/platforms', label: 'Platform Performance' },
      { href: '/growth/content', label: 'Content Performance' },
      { href: '/growth/audience', label: 'Audience Growth' },
      { href: '/growth/trends', label: 'Trend Intelligence' },
      { href: '/growth/recommendations', label: 'Recommendations' },
    ],
  },
  {
    href: '/engagement', label: 'Engagement', icon: '✉', description: 'Comments, mentions and replies',
    sections: [
      { href: '/engagement/comments', label: 'Comments' },
      { href: '/engagement/mentions', label: 'Mentions' },
      { href: '/engagement/inbox', label: 'Inbox' },
      { href: '/engagement/suggested', label: 'Suggested Replies' },
      { href: '/engagement/moderation', label: 'Moderation' },
    ],
  },
  {
    href: '/monetisation', label: 'Monetisation', icon: '£', description: 'Revenue, deals and costs',
    sections: [
      { href: '/monetisation/affiliate', label: 'Affiliate Links' },
      { href: '/monetisation/sponsorships', label: 'Sponsorships' },
      { href: '/monetisation/deals', label: 'Brand Deals' },
      { href: '/monetisation/products', label: 'Products' },
      { href: '/monetisation/subscriptions', label: 'Subscriptions' },
      { href: '/monetisation/revenue', label: 'Revenue' },
      { href: '/monetisation/expenses', label: 'Expenses' },
      { href: '/monetisation/roi', label: 'Profit / ROI' },
    ],
  },
  {
    href: '/settings', label: 'Settings', icon: '⚒', description: 'Workspace, providers, policies and audit',
    sections: [
      { href: '/settings', label: 'Workspace' },
      { href: '/settings/users', label: 'Users' },
      { href: '/settings/ai-providers', label: 'AI Providers' },
      { href: '/settings/integrations', label: 'Integrations' },
      { href: '/settings/publishing-policies', label: 'Publishing Policies' },
      { href: '/settings/safety', label: 'Safety' },
      { href: '/settings/audit', label: 'Audit Log' },
    ],
  },
  { href: '/ops', label: 'Ops', icon: '⌬', description: 'Legacy Pantheon operations (platform admins)', opsOnly: true },
]

export function findModule(href: string): NavModule {
  const m = NAV.find(n => n.href === href)
  if (!m) throw new Error(`unknown module ${href}`)
  return m
}

export function isActive(pathname: string, href: string, exactForModuleRoot = false): boolean {
  if (exactForModuleRoot) return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}
