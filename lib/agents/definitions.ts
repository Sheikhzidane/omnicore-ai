import { z } from 'zod'
import type { AgentRole } from '@/types/database'
import type { AgentCapability } from './permissions'
import type { AgentStore, EffectContext } from './store'

/**
 * The 15 character agents. Each task type declares:
 *   - input / output schemas (zod; output is requested as structured JSON
 *     and re-validated before use)
 *   - the capabilities it needs (checked by authorizeAgentAction)
 *   - `apply`: a FIXED handler that turns validated output into store writes.
 *
 * Agents have no tools. They cannot touch files, SQL, shell, git, env or
 * credentials because no such operation exists in AgentStore. Anything with
 * real-world effect (publish, send, outreach) can only become an approval
 * request via store.requestApproval — a human decides.
 */

const str = (max: number) => z.string().trim().min(1).max(max)
const strList = (max: number, n: number) => z.array(str(max)).max(n)
const platform = z.enum(['instagram', 'tiktok', 'youtube', 'x'])
const format = z.enum(['post', 'carousel', 'reel', 'short', 'story', 'thread', 'video', 'live_script'])

export interface TaskTypeDef<I = unknown, O = unknown> {
  description: string
  capabilities: AgentCapability[]
  tier: 'capable' | 'fast'
  input: z.ZodType<I>
  output: z.ZodType<O>
  instructions: string
  apply: (output: O, input: I, ctx: EffectContext, store: AgentStore) => Promise<Record<string, unknown>>
}

export interface AgentDefinition {
  role: AgentRole
  name: string
  responsibilities: string[]
  maxAttempts: number
  tasks: Record<string, TaskTypeDef>
}

// Generic helper so each task keeps its I/O types inside `apply`.
function task<I, O>(def: TaskTypeDef<I, O>): TaskTypeDef {
  return def as unknown as TaskTypeDef
}

const IdeaOut = z.object({ title: str(300), summary: str(2000), angle: str(500), platforms: z.array(platform).max(4), score: z.number().min(0).max(100) })

export const AGENT_DEFINITIONS: Record<AgentRole, AgentDefinition> = {
  ceo: {
    role: 'ceo', name: 'CEO / Strategy Agent', maxAttempts: 2,
    responsibilities: ['Set weekly goals for the character', 'Delegate work to the other agents as internal tasks', 'Review KPIs and revenue'],
    tasks: {
      weekly_strategy: task({
        description: 'Plan the week and delegate internal tasks',
        capabilities: ['strategy.recommend', 'tasks.create_internal'], tier: 'capable',
        input: z.object({ focus: str(1000).optional(), kpiSummary: str(4000).optional() }),
        output: z.object({
          summary: str(2000), goals: strList(300, 8),
          delegate: z.array(z.object({ role: z.enum(['trend_research', 'content_planner', 'copywriter', 'growth_analyst', 'sales', 'finance_analyst']), type: str(60), title: str(300), input: z.record(z.string(), z.unknown()) })).max(10),
        }),
        instructions: 'Propose 3-8 concrete goals for the next 7 days and delegate work to other agents. Delegated tasks are proposals a human must approve.',
        apply: async (o, _i, ctx, store) => ({ goals: o.goals, delegated: await store.createInternalTasks(ctx, o.delegate) }),
      }),
    },
  },
  character: {
    role: 'character', name: 'Character Agent', maxAttempts: 2,
    responsibilities: ['Guard personality/voice consistency', 'Propose new memories (non-canon until a human confirms)'],
    tasks: {
      consistency_review: task({
        description: 'Check a draft against the character identity',
        capabilities: ['content.review', 'character.propose_memory'], tier: 'capable',
        input: z.object({ contentItemId: z.string().uuid(), text: str(20000) }),
        output: z.object({ consistent: z.boolean(), issues: strList(500, 20), proposedMemories: z.array(z.object({ kind: z.enum(['fact', 'preference', 'event', 'relationship', 'catchphrase', 'continuity']), content: str(2000) })).max(5) }),
        instructions: 'Judge whether the draft is consistent with the character. Propose memories only for new durable facts the draft establishes.',
        apply: async (o, i, ctx, store) => {
          const proposed = await store.proposeMemories(ctx, o.proposedMemories)
          return { consistent: o.consistent, issues: o.issues, contentItemId: i.contentItemId, proposedMemories: proposed }
        },
      }),
    },
  },
  trend_research: {
    role: 'trend_research', name: 'Trend Research Agent', maxAttempts: 2,
    responsibilities: ['Analyse trend signals the owner supplies and the character\'s own analytics', 'Turn relevant trends into ideas'],
    tasks: {
      trend_analysis: task({
        description: 'Find relevant trends and ideas from supplied signals (no scraping)',
        capabilities: ['trends.research', 'content.ideate'], tier: 'capable',
        input: z.object({ signals: strList(500, 50).min(1), platforms: z.array(platform).max(4).default([]) }),
        output: z.object({ trends: z.array(z.object({ name: str(200), relevance: z.number().min(0).max(1), rationale: str(500) })).max(10), ideas: z.array(IdeaOut).max(10) }),
        instructions: 'Only use the signals provided. Skip trends that conflict with brand rules or boundaries. Never invent statistics.',
        apply: async (o, _i, ctx, store) => ({ trends: o.trends, ideaIds: await store.createIdeas(ctx, o.ideas) }),
      }),
    },
  },
  creative_director: {
    role: 'creative_director', name: 'Creative Director', maxAttempts: 2,
    responsibilities: ['Keep visual identity and brand consistent', 'Review drafts and propose revisions'],
    tasks: {
      creative_review: task({
        description: 'Review a draft for brand/visual consistency',
        capabilities: ['content.review'], tier: 'capable',
        input: z.object({ contentItemId: z.string().uuid(), text: str(20000) }),
        output: z.object({ verdict: z.enum(['approve', 'revise', 'reject']), notes: strList(500, 20), revisedCaption: z.string().max(10000).optional() }),
        instructions: 'Review against the brand rules and visual identity. Suggest a revised caption only when the verdict is revise.',
        apply: async (o, i, ctx, store) => {
          if (o.verdict === 'revise' && o.revisedCaption) await store.addContentVersion(ctx, i.contentItemId, { caption: o.revisedCaption, metadata: { source: 'creative_director', notes: o.notes } })
          return { verdict: o.verdict, notes: o.notes }
        },
      }),
    },
  },
  content_planner: {
    role: 'content_planner', name: 'Content Planner', maxAttempts: 2,
    responsibilities: ['Generate ideas', 'Plan the content calendar'],
    tasks: {
      generate_ideas: task({
        description: 'Generate content ideas',
        capabilities: ['content.ideate'], tier: 'capable',
        input: z.object({ count: z.number().int().min(1).max(10).default(5), theme: str(500).optional(), platforms: z.array(platform).max(4).default([]) }),
        output: z.object({ ideas: z.array(IdeaOut).min(1).max(10) }),
        instructions: 'Generate distinct, on-brand ideas. Each needs a clear angle and target platforms.',
        apply: async (o, _i, ctx, store) => ({ ideaIds: await store.createIdeas(ctx, o.ideas) }),
      }),
      plan_calendar: task({
        description: 'Propose calendar slots',
        capabilities: ['content.plan'], tier: 'capable',
        input: z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.number().int().min(1).max(31), platforms: z.array(platform).min(1).max(4), timezone: str(64).default('UTC') }),
        output: z.object({ slots: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/).optional(), platform, note: str(500) })).max(120) }),
        instructions: 'Plan a sustainable cadence that respects the platform strategy. Do not exceed a few posts per day per platform.',
        apply: async (o, i, ctx, store) => ({ slotIds: await store.createCalendarSlots(ctx, o.slots, i.timezone) }),
      }),
    },
  },
  copywriter: {
    role: 'copywriter', name: 'Copywriter', maxAttempts: 3,
    responsibilities: ['Write captions, threads and hooks in the character\'s voice', 'Add hashtags and CTAs'],
    tasks: {
      write_caption: task({
        description: 'Write a new version of a content item',
        capabilities: ['content.draft'], tier: 'capable',
        input: z.object({ contentItemId: z.string().uuid(), brief: str(4000), platform, format }),
        output: z.object({ caption: str(10000), hashtags: z.array(z.string().regex(/^#?[\p{L}\p{N}_]{1,100}$/u)).max(30), cta: z.string().max(300).optional() }),
        instructions: 'Write in the character\'s voice for the platform. Do not add disclosure lines — the system applies them.',
        apply: async (o, i, ctx, store) => ({ version: await store.addContentVersion(ctx, i.contentItemId, { caption: o.cta ? `${o.caption}\n\n${o.cta}` : o.caption, hashtags: o.hashtags.map(h => h.replace(/^#/, '')) }) }),
      }),
    },
  },
  image_prompt: {
    role: 'image_prompt', name: 'Image Prompt Agent', maxAttempts: 2,
    responsibilities: ['Write image-generation prompts consistent with the visual identity'],
    tasks: {
      image_prompt: task({
        description: 'Write an image prompt for a content item',
        capabilities: ['content.generate_media_prompt'], tier: 'capable',
        input: z.object({ contentItemId: z.string().uuid(), brief: str(4000) }),
        output: z.object({ prompt: str(4000), negativePrompt: z.string().max(2000), aspectRatio: z.enum(['1:1', '4:5', '9:16', '16:9']) }),
        instructions: 'Describe the scene with the character\'s appearance and style. Never depict real identifiable people.',
        apply: async (o, i, ctx, store) => ({ version: await store.addContentVersion(ctx, i.contentItemId, { imagePrompt: o.prompt, metadata: { negativePrompt: o.negativePrompt, aspectRatio: o.aspectRatio } }) }),
      }),
    },
  },
  video_script: {
    role: 'video_script', name: 'Video Script Agent', maxAttempts: 2,
    responsibilities: ['Write short-form video scripts, shot lists and video prompts'],
    tasks: {
      video_script: task({
        description: 'Write a video script for a content item',
        capabilities: ['content.draft', 'content.generate_media_prompt'], tier: 'capable',
        input: z.object({ contentItemId: z.string().uuid(), brief: str(4000), seconds: z.number().int().min(5).max(600).default(30) }),
        output: z.object({ hook: str(300), script: str(20000), shots: strList(500, 30), videoPrompt: str(4000) }),
        instructions: 'Open with a strong hook in the first 2 seconds. Keep it within the requested length.',
        apply: async (o, i, ctx, store) => ({ version: await store.addContentVersion(ctx, i.contentItemId, { script: `${o.hook}\n\n${o.script}`, videoPrompt: o.videoPrompt, metadata: { shots: o.shots } }) }),
      }),
    },
  },
  quality: {
    role: 'quality', name: 'Quality Agent', maxAttempts: 2,
    responsibilities: ['Score drafts for clarity, hook strength and platform fit'],
    tasks: {
      quality_review: task({
        description: 'Score a draft',
        capabilities: ['content.review'], tier: 'fast',
        input: z.object({ contentItemId: z.string().uuid(), text: str(20000), platform }),
        output: z.object({ score: z.number().min(0).max(100), pass: z.boolean(), issues: strList(500, 20) }),
        instructions: 'Be strict. pass=true only when the draft is ready for human review.',
        apply: async (o, i) => ({ contentItemId: i.contentItemId, score: o.score, pass: o.pass, issues: o.issues }),
      }),
    },
  },
  safety: {
    role: 'safety', name: 'Safety Agent', maxAttempts: 2,
    responsibilities: ['Assess drafts against the content policy and platform rules', 'Never approves anything — only passes, flags or blocks'],
    tasks: {
      safety_review: task({
        description: 'Assess a draft for policy compliance',
        capabilities: ['safety.assess'], tier: 'fast',
        input: z.object({ contentItemId: z.string().uuid(), text: str(20000), isSponsored: z.boolean().default(false) }),
        output: z.object({ status: z.enum(['passed', 'flagged', 'blocked']), reasons: strList(500, 20), categories: strList(60, 20) }),
        instructions: 'Block anything that breaks a non-negotiable rule. Flag anything uncertain for human review. Only pass clearly compliant content.',
        apply: async (o, i, ctx, store) => {
          // The agent may only tighten; a model "passed" still needs the
          // deterministic checks in lib/content/safety.ts before release.
          await store.recordSafetyAssessment(ctx, i.contentItemId, o)
          return { status: o.status, reasons: o.reasons }
        },
      }),
    },
  },
  publishing: {
    role: 'publishing', name: 'Publishing Agent', maxAttempts: 3,
    responsibilities: ['Prepare publish requests for approved, safe content', 'Never publishes without an approved approval'],
    tasks: {
      prepare_publish: task({
        description: 'Request approval to publish a content item',
        capabilities: ['content.publish', 'approvals.request'], tier: 'fast',
        input: z.object({ contentItemId: z.string().uuid(), socialAccountId: z.string().uuid(), scheduledFor: z.string().datetime({ offset: true }) }),
        output: z.object({ rationale: str(1000), bestTimeNote: z.string().max(500).optional() }),
        instructions: 'Explain briefly why this item is ready and why this time suits the audience.',
        apply: async (o, i, ctx, store) => ({
          approvalId: await store.requestApproval(ctx, {
            actionType: 'publish_content', entityType: 'content_item', entityId: i.contentItemId,
            title: 'Publish content', summary: o.rationale, riskLevel: 'medium',
            payload: { contentItemId: i.contentItemId, socialAccountId: i.socialAccountId, scheduledFor: i.scheduledFor },
          }),
        }),
      }),
    },
  },
  community: {
    role: 'community', name: 'Community Agent', maxAttempts: 2,
    responsibilities: ['Draft in-character replies to comments/mentions on the character\'s own content', 'Replies are sent only after human approval; no unsolicited DMs'],
    tasks: {
      suggest_replies: task({
        description: 'Suggest replies to inbound engagement',
        capabilities: ['community.draft_reply'], tier: 'fast',
        input: z.object({ items: z.array(z.object({ engagementItemId: z.string().uuid(), body: str(2000), author: z.string().max(200).optional() })).min(1).max(20) }),
        output: z.object({ replies: z.array(z.object({ engagementItemId: z.string().uuid(), body: z.string().max(2200), skip: z.boolean() })).max(20) }),
        instructions: 'Reply warmly and in character. Skip spam, abuse, or anything needing a human. Never claim to be a human personally replying; never solicit DMs.',
        apply: async (o, _i, ctx, store) => ({ replyIds: await store.createReplySuggestions(ctx, o.replies.filter(r => !r.skip && r.body.trim())) }),
      }),
    },
  },
  growth_analyst: {
    role: 'growth_analyst', name: 'Growth Analyst', maxAttempts: 2,
    responsibilities: ['Turn real analytics into insights and recommendations', 'Never fabricate numbers'],
    tasks: {
      growth_report: task({
        description: 'Analyse supplied metrics',
        capabilities: ['analytics.read', 'analytics.summarize', 'strategy.recommend'], tier: 'capable',
        input: z.object({ metrics: z.record(z.string(), z.unknown()), periodDays: z.number().int().min(1).max(365) }),
        output: z.object({ summary: str(3000), insights: strList(500, 15), recommendations: z.array(z.object({ title: str(200), rationale: str(1000), expectedImpact: z.enum(['low', 'medium', 'high']) })).max(10), dataSufficient: z.boolean() }),
        instructions: 'Use only the metrics provided. If data is insufficient, say so (dataSufficient=false) and recommend what to measure — do not guess.',
        apply: async o => ({ summary: o.summary, insights: o.insights, recommendations: o.recommendations, dataSufficient: o.dataSufficient }),
      }),
    },
  },
  sales: {
    role: 'sales', name: 'Sales Agent', maxAttempts: 2,
    responsibilities: ['Score brand fit for leads', 'Draft outreach (sending requires approval)'],
    tasks: {
      score_lead: task({
        description: 'Score brand/character fit for a lead',
        capabilities: ['crm.score_fit'], tier: 'fast',
        input: z.object({ leadId: z.string().uuid(), brandName: str(200), notes: z.string().max(4000).optional() }),
        output: z.object({ fitScore: z.number().min(0).max(10), reasoning: str(2000), redFlags: strList(300, 10), angle: z.string().max(500) }),
        instructions: 'Score how well the brand fits the character\'s niche, audience and rules. Flag conflicts with brand rules or no-go categories.',
        apply: async (o, i, ctx, store) => { await store.updateLeadFit(ctx, i.leadId, o); return { fitScore: o.fitScore } },
      }),
      draft_outreach: task({
        description: 'Draft outreach to a brand contact (approval required to send)',
        capabilities: ['crm.draft_outreach', 'approvals.request'], tier: 'capable',
        input: z.object({ leadId: z.string().uuid(), contactId: z.string().uuid(), context: z.string().max(4000).optional() }),
        output: z.object({ subject: str(150), body: str(4000) }),
        instructions: 'Write a short, honest pitch from the character\'s management. State plainly that the talent is an AI virtual character. No false claims or pressure tactics.',
        apply: async (o, i, ctx, store) => ({
          approvalId: await store.requestApproval(ctx, {
            actionType: 'brand_outreach', entityType: 'lead', entityId: i.leadId, title: `Outreach: ${o.subject}`,
            summary: o.body.slice(0, 500), riskLevel: 'medium', payload: { leadId: i.leadId, contactId: i.contactId, subject: o.subject, body: o.body },
          }),
        }),
      }),
    },
  },
  finance_analyst: {
    role: 'finance_analyst', name: 'Finance Analyst', maxAttempts: 2,
    responsibilities: ['Summarise revenue, expenses, profit and ROI from the ledger', 'Draft invoice reminders'],
    tasks: {
      finance_report: task({
        description: 'Summarise the ledger',
        capabilities: ['finance.read_revenue', 'finance.summarize'], tier: 'fast',
        input: z.object({ ledger: z.record(z.string(), z.unknown()), periodDays: z.number().int().min(1).max(366) }),
        output: z.object({ summary: str(2000), notes: strList(500, 10) }),
        instructions: 'Report only what the ledger shows. Do not project revenue.',
        apply: async o => ({ summary: o.summary, notes: o.notes }),
      }),
    },
  },
}

export function taskDefinition(role: AgentRole, type: string): TaskTypeDef | undefined {
  return AGENT_DEFINITIONS[role]?.tasks[type]
}
