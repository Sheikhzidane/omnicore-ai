'use client'

import { useEffect } from 'react'

/**
 * Display ad slot — renders Google AdSense if NEXT_PUBLIC_ADSENSE_CLIENT_ID
 * is set, otherwise renders a placeholder so the layout stays stable.
 *
 * Used in auto-generated SEO topic pages. Works out-of-the-box with AdSense
 * Auto Ads too — the <ins> tag just gives Google a hint.
 *
 * Slot IDs: create them in AdSense dashboard → Ads → By ad unit. For Auto Ads
 * you can pass any slot ID; Google ignores it.
 */
interface Props {
  /** AdSense ad slot ID (from the AdSense dashboard) */
  slot?: string
  /** 'auto' (responsive) | 'rectangle' | 'horizontal' | 'vertical' */
  format?: 'auto' | 'rectangle' | 'horizontal' | 'vertical'
  /** Use fluid layout — lets AdSense decide the format */
  fullWidthResponsive?: boolean
  className?: string
  /** Visible label above the ad unit — honesty + AdSense policy */
  label?: string
}

export default function DisplayAd({
  slot = '',
  format = 'auto',
  fullWidthResponsive = true,
  className = '',
  label = 'ADVERTISEMENT',
}: Props) {
  const clientId = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID
  const enabled  = Boolean(clientId)

  useEffect(() => {
    if (!enabled) return
    try {
      const w = window as Window & { adsbygoogle?: unknown[] }
      const adsbygoogle = w.adsbygoogle ?? (w.adsbygoogle = [])
      adsbygoogle.push({})
    } catch {}
  }, [enabled])

  if (!enabled) {
    // Placeholder so the grid doesn't collapse + so I can visually see where
    // ads will appear once AdSense is wired. Dashed border, muted color.
    return (
      <div className={`border border-dashed border-slate-700/50 rounded px-4 py-6 text-center bg-slate-900/20 ${className}`}>
        <div className="text-[9px] font-mono tracking-widest text-slate-700 uppercase mb-1">{label}</div>
        <div className="text-[11px] font-mono text-slate-600">
          Ad slot ready. Add <code className="text-cyan-600">NEXT_PUBLIC_ADSENSE_CLIENT_ID</code> to <code className="text-cyan-600">.env.local</code> to activate.
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="text-[9px] font-mono tracking-widest text-slate-600 uppercase mb-1 text-center">{label}</div>
      <ins
        className="adsbygoogle block"
        style={{ display: 'block' }}
        data-ad-client={clientId}
        data-ad-slot={slot || ''}
        data-ad-format={format}
        data-full-width-responsive={fullWidthResponsive ? 'true' : 'false'}
      />
    </div>
  )
}
