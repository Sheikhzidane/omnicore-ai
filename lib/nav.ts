/**
 * Application navigation — the single source for the sidebar and for the
 * module section routes (app/(os)/<module>/[section]). A section's `phase`
 * says when it is scheduled to be built (see MERGE_PLAN.md).
 */

export interface NavSection { slug: string; label: string; phase: number; description: string }
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
      { slug: 'library', label: 'Character Library', phase: 2, description: 'All characters in this workspace.' },
      { slug: 'new', label: 'Create Character', phase: 2, description: 'Create a new fictional AI character.' },
    ],
  },
  {
    href: '/content', label: 'Content Studio', icon: '✎', description: 'Ideas, generation and approvals',
    sections: [
      { slug: 'ideas', label: 'Ideas', phase: 4, description: 'Content ideas from you and the Content agent.' },
      { slug: 'calendar', label: 'Content Calendar', phase: 4, description: 'Scheduled posts across platforms.' },
      { slug: 'generated', label: 'Generated Content', phase: 4, description: 'Drafts produced by agents, with safety results.' },
      { slug: 'approvals', label: 'Approval Queue', phase: 4, description: 'Everything waiting for a human decision.' },
    ],
  },
  { href: '/social', label: 'Social Accounts', icon: '⌁', description: 'Instagram, TikTok, YouTube, X' },
  {
    href: '/agents', label: 'AI Agents', icon: '⚙', description: 'Agent control centre',
    sections: [
      { slug: 'tasks', label: 'Tasks', phase: 5, description: 'Agent task queue and approvals.' },
      { slug: 'logs', label: 'Activity Logs', phase: 5, description: 'Agent runs, tool calls and decisions.' },
    ],
  },
  {
    href: '/growth', label: 'Growth', icon: '↗', description: 'Analytics and optimisation',
    sections: [
      { slug: 'analytics', label: 'Analytics', phase: 6, description: 'Audience and account metrics from connected platforms.' },
      { slug: 'performance', label: 'Content Performance', phase: 6, description: 'How each post performed.' },
      { slug: 'experiments', label: 'Experiments', phase: 6, description: 'Structured tests proposed by the Growth agent.' },
      { slug: 'strategy', label: 'Strategy', phase: 6, description: 'Goals and plans per character.' },
    ],
  },
  {
    href: '/crm', label: 'CRM', icon: '☷', description: 'Brands, outreach and deals',
    sections: [
      { slug: 'prospects', label: 'Prospects', phase: 3, description: 'Brand prospects with AI fit scores.' },
      { slug: 'brands', label: 'Brands', phase: 3, description: 'Brands and their contacts.' },
      { slug: 'outreach', label: 'Outreach', phase: 3, description: 'Approved, rate-limited, one-to-one outreach.' },
      { slug: 'pipeline', label: 'Pipeline', phase: 3, description: 'Deal stages from prospect to paid.' },
      { slug: 'deals', label: 'Deals', phase: 3, description: 'Sponsorship deals and deliverables.' },
    ],
  },
  {
    href: '/monetisation', label: 'Monetisation', icon: '£', description: 'Revenue by source',
    sections: [
      { slug: 'affiliate', label: 'Affiliate Revenue', phase: 6, description: 'Disclosed affiliate income.' },
      { slug: 'sponsorships', label: 'Sponsorships', phase: 6, description: 'Income from sponsorship deals.' },
      { slug: 'subscriptions', label: 'Subscriptions', phase: 6, description: 'Fan subscriptions and memberships.' },
      { slug: 'other', label: 'Other Revenue', phase: 6, description: 'Licensing, tips and other income.' },
    ],
  },
  { href: '/settings', label: 'Settings', icon: '⚒', description: 'Workspace, integrations, safety' },
  { href: '/ops', label: 'Ops', icon: '⌬', description: 'Legacy Pantheon operations (platform admins)', opsOnly: true },
]

export function findModule(href: string): NavModule {
  const m = NAV.find(n => n.href === href)
  if (!m) throw new Error(`unknown module ${href}`)
  return m
}

export function findSection(href: string, slug: string): NavSection | undefined {
  return findModule(href).sections?.find(s => s.slug === slug)
}
