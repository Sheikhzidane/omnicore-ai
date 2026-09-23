import { requirePlatformAdmin } from '@/lib/auth/session'

// Legacy Pantheon operations — platform admins only.
export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin()
  return (
    <div>
      <div className="mb-4 rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/80">
        Legacy Pantheon operations. Ops agents are disabled unless OPS_AGENTS_ENABLED=true, and their write access
        is restricted (docs/AGENT_PERMISSIONS.md).
      </div>
      {children}
    </div>
  )
}
