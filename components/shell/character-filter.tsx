import Link from 'next/link'
import { cn } from '@/lib/utils'

/** Character switcher rendered as links (?character=<id>), preserving the current path. */
export function CharacterFilter({ path, characters, current }: { path: string; characters: { id: string; name: string }[]; current: string | null }) {
  if (characters.length <= 1) return null
  return (
    <nav aria-label="Character" className="mb-4 flex flex-wrap gap-2">
      {characters.map(c => (
        <Link key={c.id} href={`${path}?character=${c.id}`} aria-current={c.id === current ? 'true' : undefined}
          className={cn('rounded-full border px-3 py-1 text-xs', c.id === current ? 'border-cyan-600 bg-cyan-950/40 text-cyan-200' : 'border-slate-700 text-slate-400 hover:text-slate-200')}>
          {c.name}
        </Link>
      ))}
    </nav>
  )
}

export function NoCharacters() {
  return (
    <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-400">
      No characters yet. <Link href="/characters/new" className="text-cyan-300 hover:underline">Create your first character</Link> to start.
    </div>
  )
}
