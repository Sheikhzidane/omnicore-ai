import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'

export const metadata: Metadata = {
  title: 'OmniCore — AI Influencer OS',
  description: 'Operating system for AI influencer characters',
}

// Analytics scripts are rendered only if their respective env vars are set.
// Privacy-friendly: Umami self-hosted or Plausible, no cookies, no PII.
// Set one (not both) in .env.local + Vercel:
//   NEXT_PUBLIC_UMAMI_WEBSITE_ID + NEXT_PUBLIC_UMAMI_SRC   (https://umami.is/docs)
//   NEXT_PUBLIC_PLAUSIBLE_DOMAIN                           (https://plausible.io/docs)
function Analytics() {
  const umamiId  = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID
  const umamiSrc = process.env.NEXT_PUBLIC_UMAMI_SRC ?? 'https://cloud.umami.is/script.js'
  const plausibleDomain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN

  return (
    <>
      {umamiId && (
        <Script
          src={umamiSrc}
          data-website-id={umamiId}
          strategy="afterInteractive"
          defer
        />
      )}
      {plausibleDomain && (
        <Script
          src="https://plausible.io/js/script.js"
          data-domain={plausibleDomain}
          strategy="afterInteractive"
          defer
        />
      )}
    </>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const adSenseClient = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID
  return (
    <html lang="en">
      <head>
        {/* Account-ownership verification meta tag is OK on every page —
            it doesn't load ads. The actual adsbygoogle.js loader has been
            scoped to app/topics/layout.tsx so AdSense only runs on pages
            with substantial article content (per Google's policy on
            "ads on navigation/behavioral screens"). */}
        {adSenseClient && (
          <meta name="google-adsense-account" content={adSenseClient} />
        )}
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  )
}
