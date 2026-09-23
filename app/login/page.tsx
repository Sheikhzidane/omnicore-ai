import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { safeNextPath } from '@/lib/auth/routes'
import { supabasePublicEnv } from '@/lib/supabase/env'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Sign in · OmniCore' }

const ERRORS: Record<string, string> = {
  auth_callback: 'That sign-in link is invalid or has expired. Request a new one.',
  not_allowed: 'This account is not permitted to use this workspace.',
  no_workspace: 'Your account has no workspace yet. Contact the owner.',
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams
  const next = safeNextPath(params.next)
  if (await getSessionUser()) redirect(next)
  const configured = !!supabasePublicEnv()

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-slate-800 bg-slate-900/60 p-8">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">OmniCore</h1>
          <p className="text-sm text-slate-400">AI Influencer Operating System</p>
        </div>
        {params.error && ERRORS[params.error] && (
          <p role="alert" className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{ERRORS[params.error]}</p>
        )}
        {configured ? (
          <LoginForm next={next} />
        ) : (
          <p className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            Authentication is <strong>not configured</strong>. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
          </p>
        )}
      </div>
    </main>
  )
}
