'use client'

import { useEffect, useRef, useState } from 'react'
import type { Todo } from '@/types/todos'

interface Props { todos: Todo[] }

export default function VictoryFlash({ todos }: Props) {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const prevRef = useRef<Map<string, string>>(new Map())
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const prev = prevRef.current
    for (const t of todos) {
      const wasStatus = prev.get(t.id)
      if (wasStatus && wasStatus !== 'completed' && t.status === 'completed') {
        if (t.is_boss) {
          setMessage(`★ BOSS SLAIN: ${t.title} ★`)
        } else {
          setMessage(`✓ MISSION COMPLETE: ${t.title}`)
        }
        setVisible(true)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setVisible(false), t.is_boss ? 4000 : 2500)
      }
      prev.set(t.id, t.status)
    }
  }, [todos])

  if (!visible) return null

  const isBoss = message.startsWith('★')

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center"
      style={{ animation: 'fadeInOut 0.3s ease-out' }}
    >
      {/* Full screen flash */}
      <div
        className="absolute inset-0"
        style={{
          background: isBoss
            ? 'radial-gradient(ellipse at center, rgba(255,215,0,0.12) 0%, transparent 70%)'
            : 'radial-gradient(ellipse at center, rgba(0,255,136,0.08) 0%, transparent 70%)',
          animation: 'pulse 0.5s ease-out',
        }}
      />

      {/* Message banner */}
      <div
        className={`relative px-8 py-4 rounded border font-mono text-center ${
          isBoss
            ? 'border-yellow-400/60 bg-black/90 text-yellow-300'
            : 'border-green-500/60 bg-black/90 text-green-300'
        }`}
        style={{
          fontFamily: 'Orbitron, monospace',
          fontSize: isBoss ? '1.1rem' : '0.85rem',
          letterSpacing: '0.15em',
          boxShadow: isBoss
            ? '0 0 40px rgba(255,215,0,0.4), 0 0 80px rgba(255,215,0,0.1)'
            : '0 0 20px rgba(0,255,136,0.3)',
        }}
      >
        {message}
      </div>
    </div>
  )
}
