import type { ReactNode } from 'react'

export interface Column<T> { key: string; label: string; render: (row: T) => ReactNode; className?: string }

/** Responsive table: a real table on sm+ and stacked cards on phones. */
export function DataTable<T extends { id: string }>({ rows, columns, empty }: { rows: T[]; columns: Column<T>[]; empty: ReactNode }) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-slate-800 sm:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-400">
            <tr>{columns.map(c => <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${c.className ?? ''}`}>{c.label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map(r => (
              <tr key={r.id} className="align-top hover:bg-slate-900/40">
                {columns.map(c => <td key={c.key} className={`px-3 py-2 text-slate-300 ${c.className ?? ''}`}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 sm:hidden">
        {rows.map(r => (
          <li key={r.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm">
            <dl className="space-y-1">
              {columns.map(c => (
                <div key={c.key} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-xs text-slate-500">{c.label}</dt>
                  <dd className="min-w-0 text-right text-slate-300">{c.render(r)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-400">{children}</div>
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-100">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

export function NotConfigured({ what, missing, children }: { what: string; missing?: string[]; children?: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-4 text-sm text-amber-200">
      <p className="font-medium">{what} is not configured.</p>
      {missing && missing.length > 0 && <p className="mt-1 text-xs text-amber-300/80">Missing server environment variables: {missing.map(m => <code key={m} className="mr-1">{m}</code>)}</p>}
      {children && <div className="mt-2 text-xs text-amber-200/80">{children}</div>}
    </div>
  )
}

export const fmtDate = (iso: string | null | undefined, withTime = true) =>
  iso ? new Date(iso).toLocaleString('en-GB', withTime ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' } : { dateStyle: 'medium', timeZone: 'UTC' }) + (withTime ? ' UTC' : '') : '—'
