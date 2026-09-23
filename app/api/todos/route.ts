import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePlatformAdminApi } from '@/lib/auth/api'
import type { Database } from '@/types/database'

/**
 * Legacy ops task queue (todos). Creating, approving or deleting a task is a
 * privileged agent action — the ops agents execute approved tasks — so every
 * method requires an authenticated platform admin and writes an audit entry
 * before acting (requirePlatformAdminApi). The table itself is read-only to
 * clients; this route is the only write path from the UI.
 */

type TodoUpdate = Database['public']['Tables']['todos']['Update']

const Status = z.enum(['proposed', 'pending', 'in_progress', 'completed', 'failed', 'blocked', 'vetoed'])
const Priority = z.enum(['low', 'medium', 'high', 'critical'])

const CreateBody = z.object({
  title: z.string().trim().min(1).max(500),
  priority: Priority.default('medium'),
  // New tasks enter the Task Inbox; 'pending' (approved) only if the admin says so.
  status: z.enum(['proposed', 'pending']).default('proposed'),
  assigned_agent: z.string().trim().max(100).nullable().optional(),
}).strict()

const UpdateBody = z.object({
  id: z.string().uuid(),
  status: Status.optional(),
  priority: Priority.optional(),
  assigned_agent: z.string().trim().max(100).nullable().optional(),
  /** Retry a failed task: re-queue, clear the agent and bump retry_count. */
  retry: z.literal(true).optional(),
}).strict()

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 })

export async function POST(req: NextRequest) {
  const body = CreateBody.safeParse(await req.json().catch(() => null))
  if (!body.success) return badRequest('invalid body: title required; see schema')

  const auth = await requirePlatformAdminApi(req, 'ops.todo.create', { status: body.data.status, priority: body.data.priority })
  if (!auth.ok) return auth.response

  const { data, error } = await createAdminClient()
    .from('todos')
    .insert({ ...body.data, assigned_agent: body.data.assigned_agent ?? null })
    .select()
    .single()
  if (error) return badRequest(error.message)
  return NextResponse.json(data, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const body = UpdateBody.safeParse(await req.json().catch(() => null))
  if (!body.success) return badRequest('invalid body: id (uuid) required; see schema')
  const { id, retry, ...fields } = body.data

  const auth = await requirePlatformAdminApi(req, retry ? 'ops.todo.retry' : 'ops.todo.update', {
    id, status: fields.status ?? null, priority: fields.priority ?? null,
  })
  if (!auth.ok) return auth.response

  const admin = createAdminClient()
  const update: TodoUpdate = { ...fields }
  if (retry) {
    const { data: current } = await admin.from('todos').select('retry_count').eq('id', id).single()
    update.status = 'pending'
    update.assigned_agent = null
    update.retry_count = (current?.retry_count ?? 0) + 1
  }
  if (Object.keys(update).length === 0) return badRequest('no fields to update')

  const { data, error } = await admin.from('todos').update(update).eq('id', id).select().single()
  if (error) return badRequest(error.message)
  return NextResponse.json(data)
}

export async function DELETE(req: NextRequest) {
  const id = z.string().uuid().safeParse(req.nextUrl.searchParams.get('id'))
  if (!id.success) return badRequest('id query param (uuid) is required')

  const auth = await requirePlatformAdminApi(req, 'ops.todo.delete', { id: id.data })
  if (!auth.ok) return auth.response

  const { error } = await createAdminClient().from('todos').delete().eq('id', id.data)
  if (error) return badRequest(error.message)
  return new NextResponse(null, { status: 204 })
}
