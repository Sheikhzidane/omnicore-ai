'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { NAV, isActive } from '@/lib/nav'
import { cn } from '@/lib/utils'

function NavLinks({ pathname, isOpsAdmin, onNavigate }: { pathname: string; isOpsAdmin: boolean; onNavigate?: () => void }) {
  const items = NAV.filter(n => !n.opsOnly || isOpsAdmin)
  return (
    <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
      {items.map(item => {
        const active = isActive(pathname, item.href)
        return (
          <div key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active && pathname === item.href ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors',
                active ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-900 hover:text-white',
                item.opsOnly && 'text-amber-300/80',
              )}
            >
              <span aria-hidden className="w-4 text-center text-slate-500">{item.icon}</span>
              {item.label}
            </Link>
            {active && item.sections && (
              <ul className="ml-4 mt-1 space-y-0.5 border-l border-slate-800 pl-3">
                {item.sections.map(s => {
                  // A section equal to its module root is only "current" on exact match.
                  const current = s.href === item.href ? pathname === s.href : isActive(pathname, s.href)
                  return (
                    <li key={s.href}>
                      <Link href={s.href} onClick={onNavigate} aria-current={current ? 'page' : undefined}
                        className={cn('block rounded px-2 py-1.5 text-xs', current ? 'text-cyan-300' : 'text-slate-400 hover:text-slate-200')}>
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
  )
}

function Footer({ email }: { email: string }) {
  return (
    <div className="border-t border-slate-800 px-5 py-3">
      <p className="truncate text-xs text-slate-500" title={email}>{email}</p>
      <form action="/logout" method="post">
        <button type="submit" className="mt-1 text-xs text-slate-400 hover:text-white">Sign out</button>
      </form>
    </div>
  )
}

export function Sidebar({ workspaceName, email, isOpsAdmin }: { workspaceName: string; email: string; isOpsAdmin: boolean }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const brand = (
    <div className="border-b border-slate-800 px-5 py-4">
      <Link href="/dashboard" className="text-sm font-semibold text-slate-100">OmniCore</Link>
      <p className="truncate text-xs text-slate-500" title={workspaceName}>{workspaceName}</p>
    </div>
  )

  return (
    <>
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/dashboard" className="text-sm font-semibold text-slate-100">OmniCore</Link>
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="mobile-nav"
          className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Menu</button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside id="mobile-nav" className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-slate-800 bg-slate-950">
            <div className="flex items-start justify-between">
              {brand}
              <button type="button" onClick={() => setOpen(false)} className="m-3 rounded px-2 py-1 text-xs text-slate-400 hover:text-white">Close</button>
            </div>
            <NavLinks pathname={pathname} isOpsAdmin={isOpsAdmin} onNavigate={() => setOpen(false)} />
            <Footer email={email} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950 lg:flex">
        {brand}
        <NavLinks pathname={pathname} isOpsAdmin={isOpsAdmin} />
        <Footer email={email} />
      </aside>
    </>
  )
}
