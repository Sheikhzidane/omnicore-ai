import { Sidebar } from '@/components/shell/sidebar'
import { requireWorkspace, isPlatformAdmin } from '@/lib/auth/session'

// Every page in the application shell requires a verified session. This is
// re-checked here (not only in proxy.ts) so a proxy bypass can't expose data.
export const dynamic = 'force-dynamic'

export default async function OsLayout({ children }: { children: React.ReactNode }) {
  const { user, workspace } = await requireWorkspace('viewer')
  const opsAdmin = await isPlatformAdmin()
  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-200">
      <Sidebar workspaceName={workspace.name} email={user.email ?? ''} isOpsAdmin={opsAdmin} />
      <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
    </div>
  )
}
