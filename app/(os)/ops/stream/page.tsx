import type { Metadata } from 'next'
import StreamView from './StreamView'

export const metadata: Metadata = {
  title:       'Watch my AI work · pantheon',
  description: '24/7 live stream of an autonomous AI agent system shipping code + content. No edits, no takes.',
  openGraph: {
    title:       'Watch my AI work · pantheon',
    description: 'Autonomous agents shipping code and SEO content, narrated live by Jarvis.',
    type:        'website',
    url:         (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://task-dashboard-sigma-three.vercel.app') + '/ops/stream',
  },
  twitter: { card: 'summary_large_image', title: 'Watch my AI work · pantheon', description: 'Autonomous agents, narrated live.' },
}

export default function StreamPage() {
  return <StreamView />
}
