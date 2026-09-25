export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
      </div>
      {children}
    </header>
  )
}

export function Panel({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900/40 p-4 ${className}`}>
      {title && <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-400">{title}</h2>}
      {children}
    </section>
  )
}

export function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'off' | 'info'; children: React.ReactNode }) {
  const tones = {
    ok: 'border-emerald-800 bg-emerald-950/50 text-emerald-300',
    warn: 'border-amber-800 bg-amber-950/50 text-amber-300',
    off: 'border-slate-700 bg-slate-900 text-slate-400',
    info: 'border-cyan-800 bg-cyan-950/50 text-cyan-300',
  }
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>
}
