import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'

// Entry point: the application for signed-in users, otherwise sign-in.
export default async function Home() {
  redirect((await getSessionUser()) ? '/dashboard' : '/login')
}
