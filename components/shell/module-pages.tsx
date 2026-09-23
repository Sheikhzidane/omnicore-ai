import Link from 'next/link'
import { notFound } from 'next/navigation'
import { findModule, findSection } from '@/lib/nav'
import { NotBuiltYet, PageHeader, Panel, StatusPill } from './page-header'

/** Index page for a module: lists its sections and their build phase. */
export function ModuleIndex({ href, children }: { href: string; children?: React.ReactNode }) {
  const mod = findModule(href)
  return (
    <>
      <PageHeader title={mod.label} description={mod.description} />
      {children}
      {mod.sections && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {mod.sections.map(s => (
            <Link key={s.slug} href={`${href}/${s.slug}`} className="block rounded-lg border border-slate-800 bg-slate-900/40 p-4 hover:border-slate-600">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-100">{s.label}</span>
                <StatusPill tone="off">Phase {s.phase}</StatusPill>
              </div>
              <p className="mt-1 text-xs text-slate-400">{s.description}</p>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

/** A module section that is not built yet. Unknown slugs 404. */
export function SectionPlaceholder({ href, slug }: { href: string; slug: string }) {
  const mod = findModule(href)
  const section = findSection(href, slug)
  if (!section) notFound()
  return (
    <>
      <PageHeader title={section.label} description={`${mod.label} · ${section.description}`} />
      <NotBuiltYet phase={section.phase} description={section.description} />
    </>
  )
}

export { Panel }
