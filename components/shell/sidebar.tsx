'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV } from '@/lib/nav'
import { cn } from '@/lib/utils'

export function Sidebar({ workspaceName, email, isOpsAdmin }: { workspaceName: string; email: string; isOpsAdmin: boolean }) {
  const pathname = usePathname()
  const items = NAV.filter(n => !n.opsOnly || isOpsAdmin)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950">
      <div className="border-b border-slate-800 px-5 py-4">
        <Link href="/dashboard" className="text-sm font-semibold text-slate-100">OmniCore</Link>
        <p className="truncate text-xs text-slate-500" title={workspaceName}>{workspaceName}</p>
      </div>
      <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {items.map(item => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <div key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                  active ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-900 hover:text-white',
                  item.opsOnly && 'text-amber-300/80',
                )}
              >
                <span aria-hidden className="w-4 text-center text-slate-500">{item.icon}</span>
                {item.label}
              </Link>
              {active && item.sections && (
                <ul className="mt-1 space-y-0.5 border-l border-slate-800 pl-3 ml-4">
                  {item.sections.map(s => {
                    const href = `${item.href}/${s.slug}`
                    return (
                      <li key={s.slug}>
                        <Link
                          href={href}
                          aria-current={pathname === href ? 'page' : undefined}
                          className={cn('block rounded px-2 py-1 text-xs', pathname === href ? 'text-cyan-300' : 'text-slate-400 hover:text-slate-200')}
                        >
                          {s.label}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </nav>
      <div className="border-t border-slate-800 px-5 py-3">
        <p className="truncate text-xs text-slate-500" title={email}>{email}</p>
        <form action="/logout" method="post">
          <button type="submit" className="mt-1 text-xs text-slate-400 hover:text-white">Sign out</button>
        </form>
      </div>
    </aside>
  )
}
