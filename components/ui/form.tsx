'use client'

import { useActionState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import { cn } from '@/lib/utils'
import type { ActionResult } from '@/lib/actions'

const control = 'w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none'

export function SubmitButton({ children, tone = 'primary', className }: { children: ReactNode; tone?: 'primary' | 'danger' | 'ghost'; className?: string }) {
  const { pending } = useFormStatus()
  const tones = {
    primary: 'bg-cyan-600 text-white hover:bg-cyan-500',
    danger: 'bg-red-700 text-white hover:bg-red-600',
    ghost: 'border border-slate-700 text-slate-200 hover:bg-slate-800',
  }
  return (
    <button type="submit" disabled={pending} className={cn('rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50', tones[tone], className)}>
      {pending ? 'Working…' : children}
    </button>
  )
}

/** A form bound to a server action; shows the action's result message. */
export function ActionForm({ action, children, className }: { action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>; children: ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, null)
  return (
    <form action={formAction} className={cn('space-y-3', className)}>
      {children}
      {state && (
        <p role={state.ok ? 'status' : 'alert'} className={cn('text-xs', state.ok ? 'text-emerald-300' : 'text-red-300')}>{state.message}</p>
      )}
    </form>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(control, props.className)} />
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={4} {...props} className={cn(control, props.className)} />
}
export function Select({ options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <select {...props} className={cn(control, props.className)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
export function Checkbox({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-300">
      <input type="checkbox" {...props} className="h-4 w-4 rounded border-slate-600 bg-slate-950" />
      {label}
    </label>
  )
}
