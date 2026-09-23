#!/usr/bin/env node
// Long-running daemon that ramps SEO topic generation up to a higher cadence.
// One topic every CADENCE_MS (default 5 hours) ≈ 5 pages/day, ~$0.10/day extra
// LLM spend, well under the daily cost cap.
//
// Each generated page auto-pings IndexNow (handled inside seo-topic-generator)
// so Bing/Google index it in hours rather than days.
//
// Cooldown is enforced by the timer here PLUS the generator's own dedupe — it
// won't write a page that already exists.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('seo-content-loop')

const __dirname = dirname(fileURLToPath(import.meta.url))
const GEN       = join(__dirname, 'seo-topic-generator.mjs')

const CADENCE_MS    = Number(process.env.SEO_CADENCE_MS    ?? 5  * 60 * 60 * 1000)  // 5 hours
const BATCH_SIZE    = Number(process.env.SEO_BATCH_SIZE    ?? 1)                     // pages per tick
const FIRST_DELAY_MS = Number(process.env.SEO_FIRST_DELAY_MS ?? 5 * 60 * 1000)        // 5 min after boot

console.log(`[SEO-LOOP] starting — every ${Math.round(CADENCE_MS / 60_000)} min, ${BATCH_SIZE} page${BATCH_SIZE === 1 ? '' : 's'} per tick`)

function runOnce() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [GEN, '--batch', String(BATCH_SIZE)], {
      stdio: 'inherit',
      env:   process.env,
    })
    child.on('exit', code => {
      if (code !== 0) console.log(`[SEO-LOOP] generator exited code=${code}`)
      resolve()
    })
  })
}

setTimeout(async function tick() {
  await runOnce()
  setTimeout(tick, CADENCE_MS)
}, FIRST_DELAY_MS)

// Keep the process alive even if all timers somehow drain.
setInterval(() => {}, 1 << 30)
