'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

export function Tabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Sections" className="-mx-4 mb-5 overflow-x-auto border-b border-slate-800 px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1">
        {tabs.map(t => {
          const active = pathname === t.href
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? 'page' : undefined}
                className={cn('block whitespace-nowrap border-b-2 px-3 py-2 text-sm', active ? 'border-cyan-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200')}>
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
