import { getCharacter } from '@/lib/data/characters'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { Tabs } from '@/components/shell/tabs'

export default async function CharacterLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params
  const c = await getCharacter(id)
  const base = `/characters/${id}`
  return (
    <>
      <PageHeader title={c.name} description={`/${c.slug} · ${c.disclosure_text}`}>
        <StatusPill tone={c.status === 'active' ? 'ok' : c.status === 'paused' ? 'warn' : 'off'}>{c.status}</StatusPill>
      </PageHeader>
      <Tabs tabs={[
        { href: base, label: 'Profile' }, { href: `${base}/personality`, label: 'Personality' }, { href: `${base}/visual`, label: 'Visual Identity' },
        { href: `${base}/brand-rules`, label: 'Brand Rules' }, { href: `${base}/content-policy`, label: 'Content Policy' },
        { href: `${base}/assets`, label: 'Assets' }, { href: `${base}/memory`, label: 'Memory' },
      ]} />
      {children}
    </>
  )
}
