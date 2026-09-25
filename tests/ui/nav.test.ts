import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NAV } from '@/lib/nav'

const pageFor = (href: string) => (href === '/ops' ? 'app/(os)/ops/page.tsx' : `app/(os)${href}/page.tsx`)

test('every navigation entry links to a real page', () => {
  const hrefs = NAV.flatMap(m => [m.href, ...(m.sections ?? []).map(s => s.href)])
  const missing = hrefs.filter(h => !existsSync(pageFor(h)))
  assert.deepEqual(missing, [])
})

test('the navigation covers the specified modules and sections', () => {
  const labels = NAV.map(m => m.label)
  for (const l of ['Dashboard', 'Characters', 'Content Studio', 'Social Accounts', 'AI Agents', 'Growth', 'Engagement', 'Monetisation', 'Settings']) assert.ok(labels.includes(l), l)
  const sections = (label: string) => NAV.find(m => m.label === label)!.sections!.map(s => s.label)
  assert.deepEqual(sections('Content Studio'), ['Ideas', 'Generator', 'Generated Assets', 'Calendar', 'Approval Queue', 'Publishing Queue', 'History'])
  assert.deepEqual(sections('AI Agents'), ['Control Centre', 'Tasks', 'Runs', 'Event Logs', 'Approval Requests', 'Failures'])
  assert.deepEqual(sections('Monetisation'), ['Affiliate Links', 'Sponsorships', 'Brand Deals', 'Products', 'Subscriptions', 'Revenue', 'Expenses', 'Profit / ROI'])
  assert.deepEqual(sections('Settings'), ['Workspace', 'Users', 'AI Providers', 'Integrations', 'Publishing Policies', 'Safety', 'Audit Log'])
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [] })
}

test('no placeholder UI or fake numbers in the product pages', () => {
  const offenders: string[] = []
  for (const f of files('app/(os)').filter(f => !f.includes('/ops/'))) {
    const src = readFileSync(f, 'utf8')
    if (/lorem ipsum|coming soon|not built yet|Math\.random\(/i.test(src)) offenders.push(f)
  }
  assert.deepEqual(offenders, [])
})

test('every server action file authorises through runAction', () => {
  const bad: string[] = []
  for (const f of files('app/(os)').filter(f => f.endsWith('actions.ts'))) {
    const src = readFileSync(f, 'utf8')
    const exported = [...src.matchAll(/^export async function (\w+)/gm)].map(m => m[1])
    for (const name of exported) {
      const body = src.slice(src.indexOf(`export async function ${name}`)).split(/\nexport /)[0]
      if (!/runAction\(/.test(body)) bad.push(`${f}:${name}`)
    }
  }
  assert.deepEqual(bad, [])
})
