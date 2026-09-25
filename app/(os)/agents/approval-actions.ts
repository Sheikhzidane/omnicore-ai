'use server'

import { z } from 'zod'
import { runAction, type ActionResult } from '@/lib/actions'
import { decideApproval, retryApproval } from '@/lib/approvals/service'

const PATHS = ['/content/approvals', '/agents/approvals', '/content/publishing', '/engagement/suggested', '/dashboard']

/** Human decision on an approval request. Role/risk rules and the DB state machine apply. */
export async function decide(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user, role }) => {
    const id = z.uuid().parse(fd.get('approvalId'))
    const decision = z.enum(['APPROVED', 'REJECTED']).parse(fd.get('decision'))
    const note = String(fd.get('note') ?? '').trim() || null
    if (decision === 'REJECTED' && !note) throw new Error('add a short reason when rejecting')
    const r = await decideApproval(db, { workspaceId: workspace.id, userId: user.id, role }, id, decision, note, { env: process.env, fetch })
    if (r.status === 'FAILED') throw new Error(`Approved, but execution failed: ${'error' in r ? r.error : ''}`)
    if (r.status === 'EXECUTING') return 'Approved. The publishing job is queued.'
    if (r.status === 'APPROVED') return 'Approved. This action is carried out manually.'
    return r.status === 'REJECTED' ? 'Rejected.' : 'Approved and completed.'
  }, PATHS)
}

export async function retry(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user, role }) => {
    await retryApproval(db, { workspaceId: workspace.id, userId: user.id, role }, z.uuid().parse(fd.get('approvalId')))
    return 'Back in the queue for a fresh decision.'
  }, PATHS)
}
