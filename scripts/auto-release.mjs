#!/usr/bin/env node
/**
 * auto-release.mjs — creates a GitHub Release every time it's run.
 * Designed to be invoked by god-agent every 50 cycles (or manually).
 *
 * Steps:
 *   1. Inspect git log since last tag to build a changelog
 *   2. Bump a semver patch (v1.0.0 → v1.0.1)
 *   3. Create annotated git tag + push
 *   4. Open a GitHub Release via REST API with the changelog as body
 *
 * Requires: GITHUB_REPO, GITHUB_TOKEN in env.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'


// Permanently disabled (Phase 1 security lockdown): tagging, pushing and publishing releases is a forbidden agent operation (git.release).
// Code kept for reference only. See docs/AGENT_PERMISSIONS.md.
console.log('[auto-release] disabled: tagging, pushing and publishing releases is a forbidden agent operation (git.release).')
process.exit(0)

const __dirname    = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// Load .env.local
for (const line of readFileSync(join(PROJECT_ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const REPO  = process.env.GITHUB_REPO
const TOKEN = process.env.GITHUB_TOKEN

if (!REPO || !TOKEN) {
  console.error('✗ GITHUB_REPO and GITHUB_TOKEN must be set in .env.local')
  process.exit(1)
}

const git = (cmd) => execSync(cmd, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

// 1. Find the last tag (or start at v0.0.0 if none)
let lastTag
try { lastTag = git('git describe --tags --abbrev=0') }
catch { lastTag = 'v0.0.0' }
console.log(`▸ Last tag: ${lastTag}`)

// 2. Bump patch
const m = lastTag.match(/^v?(\d+)\.(\d+)\.(\d+)/)
if (!m) { console.error(`✗ Can't parse last tag "${lastTag}"`); process.exit(1) }
const [maj, min, patch] = m.slice(1).map(Number)
const nextTag = `v${maj}.${min}.${patch + 1}`

// 3. Build changelog: commits since last tag, grouped by prefix
const range = lastTag === 'v0.0.0' ? '' : `${lastTag}..HEAD`
const log = range
  ? git(`git log ${range} --format="%s|||%h|||%an"`)
  : git('git log --format="%s|||%h|||%an"')

const commits = log.split('\n').filter(Boolean).map(line => {
  const [subject, sha, author] = line.split('|||')
  return { subject, sha, author, isGod: /\[god-(edit|agent)\]|^god/i.test(subject) }
})

if (commits.length === 0) {
  console.log(`▸ No commits since ${lastTag} — nothing to release`)
  process.exit(0)
}

const byCategory = { feat: [], fix: [], chore: [], docs: [], refactor: [], god: [], other: [] }
for (const c of commits) {
  if (c.isGod) { byCategory.god.push(c); continue }
  const prefix = c.subject.match(/^(\w+)(\(.+?\))?:/)?.[1]?.toLowerCase()
  const bucket = ['feat', 'fix', 'chore', 'docs', 'refactor'].includes(prefix) ? prefix : 'other'
  byCategory[bucket].push(c)
}

const section = (title, emoji, list) => list.length === 0 ? '' : `### ${emoji} ${title}\n${list.map(c => `- ${c.subject} (\`${c.sha}\`)`).join('\n')}\n`

const body = [
  `## ${nextTag} — ${new Date().toISOString().slice(0, 10)}`,
  '',
  `_${commits.length} commits since ${lastTag}._`,
  '',
  section('Features',    '✨', byCategory.feat),
  section('Fixes',       '🐛', byCategory.fix),
  section('God edits',   '👁', byCategory.god),
  section('Refactor',    '♻️', byCategory.refactor),
  section('Docs',        '📝', byCategory.docs),
  section('Chores',      '🔧', byCategory.chore),
  section('Other',       '📦', byCategory.other),
  '',
  '---',
  '[Full Changelog](https://github.com/' + REPO + `/compare/${lastTag}...${nextTag})`,
].join('\n')

console.log(`▸ ${commits.length} commits · creating tag ${nextTag}`)

// 4. Tag + push
git(`git tag -a ${nextTag} -m "Release ${nextTag}"`)
try {
  git(`git push origin ${nextTag}`)
} catch (e) {
  console.log(`  ⚠ git push failed (remote may not be configured): ${e.message?.slice(0, 120)}`)
}

// 5. Open GitHub Release
const r = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept':        'application/vnd.github+json',
    'User-Agent':    'god-agent',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body: JSON.stringify({
    tag_name:       nextTag,
    name:           `${nextTag}`,
    body,
    draft:          false,
    prerelease:     false,
    generate_release_notes: false,
  }),
})

if (!r.ok) {
  console.error(`✗ GitHub API ${r.status}: ${await r.text()}`)
  process.exit(1)
}

const release = await r.json()
console.log(`✓ Release published: ${release.html_url}`)
