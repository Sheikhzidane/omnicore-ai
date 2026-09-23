import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'

/**
 * Reports the state of each passive-income stream — what's earning, what's
 * pending setup, what's not wired. Dashboard polls this to show a status
 * grid so the user knows exactly what ONE THING they need to do next.
 */
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const env = process.env

  // Count auto-generated topic pages (the traffic substrate for all streams)
  const topicsDir = join(process.cwd(), 'app', 'topics')
  let topicCount = 0, newestPageIso = null
  try {
    if (existsSync(topicsDir)) {
      const entries = readdirSync(topicsDir, { withFileTypes: true }).filter(d => d.isDirectory())
      topicCount = entries.length
      for (const e of entries) {
        const p = join(topicsDir, e.name, 'page.tsx')
        if (!existsSync(p)) continue
        const mtime = statSync(p).mtime.toISOString()
        if (!newestPageIso || mtime > newestPageIso) newestPageIso = mtime
      }
    }
  } catch {}

  const adSenseConfigured  = Boolean(env.NEXT_PUBLIC_ADSENSE_CLIENT_ID)
  const ezoicConfigured    = Boolean(env.NEXT_PUBLIC_EZOIC_SITE_ID)
  const amazonConfigured   = Boolean(env.AMAZON_ASSOCIATE_TAG)
  const amazonUkConfigured = Boolean(env.AMAZON_UK_TAG)
  const gumroadConfigured  = Boolean(env.GUMROAD_PRODUCT_URL || env.GUMROAD_ACCESS_TOKEN)
  const stripeConfigured   = Boolean(env.STRIPE_SECRET_KEY)

  const streams = [
    {
      id:          'adsense',
      name:        'Google AdSense',
      category:    'display-ads',
      handsOff:    10, // most hands-off once set up
      status:      adSenseConfigured ? 'active' : 'pending-setup',
      blocker:     adSenseConfigured ? null : 'Apply at google.com/adsense — set NEXT_PUBLIC_ADSENSE_CLIENT_ID',
      description: 'Ads auto-serve on every topic page. Revenue compounds with traffic.',
      expected:    '$30–$500/mo at 10–100k monthly pageviews',
      nextStep:    adSenseConfigured ? 'Wait for approval (2-4 weeks) then traffic (3-6 mo)' : 'Apply for AdSense and add publisher ID',
    },
    {
      id:          'ezoic',
      name:        'Ezoic (alt to AdSense)',
      category:    'display-ads',
      handsOff:    10,
      status:      ezoicConfigured ? 'active' : 'pending-setup',
      blocker:     ezoicConfigured ? null : 'ezoic.com — 10k monthly pageviews minimum. Or skip and use AdSense.',
      description: 'Higher RPM than AdSense at mid traffic, but has a threshold',
      expected:    '$50–$700/mo at 10–100k monthly pageviews',
      nextStep:    ezoicConfigured ? 'Monitor Ezoic dashboard' : 'Skip until you have 10k monthly pageviews',
    },
    {
      id:          'amazon',
      name:        'Amazon Associates (US)',
      category:    'affiliate',
      handsOff:    9,
      status:      amazonConfigured ? 'active' : 'pending-setup',
      blocker:     amazonConfigured ? null : 'affiliate-program.amazon.com — self-service sign-up. Set AMAZON_ASSOCIATE_TAG.',
      description: 'Auto-injected links in topic pages; US visitors go to amazon.com',
      expected:    '$10–$200/mo at similar traffic — lower than ads but additive',
      nextStep:    amazonConfigured ? 'Agents auto-link on next page generation' : 'Sign up for Amazon Associates',
    },
    {
      id:          'amazon-uk',
      name:        'Amazon Associates (UK)',
      category:    'affiliate',
      handsOff:    9,
      status:      amazonUkConfigured ? 'active' : 'pending-setup',
      blocker:     amazonUkConfigured ? null : 'affiliate-program.amazon.co.uk — separate UK program. Set AMAZON_UK_TAG.',
      description: 'Client-side geo-swap: UK visitors auto-routed to amazon.co.uk with UK tag',
      expected:    '£10–£180/mo at similar traffic — additive to US',
      nextStep:    amazonUkConfigured ? 'UK visitors auto-routed' : 'Apply at affiliate-program.amazon.co.uk',
    },
    {
      id:          'gumroad',
      name:        'Gumroad (boilerplate sales)',
      category:    'product',
      handsOff:    7,
      status:      gumroadConfigured ? 'configured' : 'pending-setup',
      blocker:     gumroadConfigured ? null : 'Requires uploading a product + manual listing updates. You have abandoned this.',
      description: 'One-time sales of pantheon-starter-kit. Higher $ per conversion, needs product page work.',
      expected:    '$0–$500/mo depending on promotion',
      nextStep:    gumroadConfigured ? 'Monitor Market Intel panel' : 'Build pantheon-starter-kit repo + demo video first',
    },
    {
      id:          'stripe-subs',
      name:        'Dashboard paywall (Stripe)',
      category:    'saas',
      handsOff:    6,
      status:      stripeConfigured ? 'configured' : 'not-wired',
      blocker:     stripeConfigured ? null : 'No Stripe integration yet. Would unlock "watch my AI" public dashboard with paid tier.',
      description: 'Public-view pantheon with $5/mo unlock for full feed',
      expected:    '$0–$500/mo — depends entirely on promotion',
      nextStep:    'Deferred — SEO/ads first since zero promotion is needed',
    },
  ]

  const active  = streams.filter(s => s.status === 'active').length
  const pending = streams.filter(s => s.status === 'pending-setup').length
  const notWired = streams.filter(s => s.status === 'not-wired').length

  return NextResponse.json({
    summary: {
      topicCount,
      newestPageIso,
      activeStreams:  active,
      pendingSetup:   pending,
      notWired,
    },
    streams,
    recommendedNextStep: streams.find(s => s.status === 'pending-setup' && s.handsOff >= 9)?.blocker
      ?? 'All hands-off streams configured. Focus on traffic — agents already generate pages daily.',
    at: new Date().toISOString(),
  })
}
