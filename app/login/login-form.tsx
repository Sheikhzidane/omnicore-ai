'use client'

import { useActionState } from 'react'
import { sendMagicLink, signInWithPassword, type LoginState } from './actions'

const field = 'w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none'
const button = 'w-full rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50'

export function LoginForm({ next }: { next: string }) {
  const [pwState, pwAction, pwPending] = useActionState<LoginState, FormData>(signInWithPassword, {})
  const [mlState, mlAction, mlPending] = useActionState<LoginState, FormData>(sendMagicLink, {})

  return (
    <div className="space-y-6">
      <form action={pwAction} className="space-y-3" aria-label="Sign in with password">
        <input type="hidden" name="next" value={next} />
        <label className="block space-y-1">
          <span className="text-xs text-slate-400">Email</span>
          <input name="email" type="email" autoComplete="email" required className={field} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-slate-400">Password</span>
          <input name="password" type="password" autoComplete="current-password" required minLength={8} className={field} />
        </label>
        {pwState.error && <p role="alert" className="text-xs text-red-400">{pwState.error}</p>}
        <button type="submit" disabled={pwPending} className={`${button} bg-cyan-600 text-white hover:bg-cyan-500`}>
          {pwPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-slate-500">
        <span className="h-px flex-1 bg-slate-800" />or<span className="h-px flex-1 bg-slate-800" />
      </div>

      <form action={mlAction} className="space-y-3" aria-label="Email me a sign-in link">
        <input type="hidden" name="next" value={next} />
        <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" className={field} aria-label="Email for sign-in link" />
        {mlState.error && <p role="alert" className="text-xs text-red-400">{mlState.error}</p>}
        {mlState.message && <p role="status" className="text-xs text-emerald-400">{mlState.message}</p>}
        <button type="submit" disabled={mlPending} className={`${button} border border-slate-700 text-slate-200 hover:bg-slate-800`}>
          {mlPending ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>
    </div>
  )
}
