# AI providers

AI access goes through provider-neutral interfaces in `lib/ai/types.ts`:

| Capability | Interface | Built-in adapters |
|---|---|---|
| Text / structured output | `TextProvider` | Anthropic (`lib/ai/anthropic.ts`), OpenAI (`lib/ai/openai.ts`) |
| Image generation | `ImageProvider` | OpenAI Images |
| Video generation | `VideoProvider` | OpenAI Videos (asynchronous) |
| Moderation | `ModerationProvider` | OpenAI moderation; Anthropic classifier as a fallback |
| Embeddings | `EmbeddingProvider` | OpenAI |

`lib/ai/registry.ts` picks the provider from environment variables. The defaults are:

- **Text:** Anthropic if `ANTHROPIC_API_KEY` is set, otherwise OpenAI (with `OPENAI_TEXT_MODEL`).
  - Anthropic models: `claude-opus-5` for capable tasks and `claude-haiku-4-5` for fast ones. Override them with `ANTHROPIC_MODEL` and `ANTHROPIC_FAST_MODEL`.
  - Requests use structured JSON output validated with zod, a cached system prompt (the character identity), and the refusal check.
- **Images:** OpenAI `gpt-image-1` when `OPENAI_API_KEY` is set.
- **Video:** off unless `AI_VIDEO_PROVIDER=openai`.
- **Moderation:** OpenAI if configured, else the Anthropic classifier, else **none**. With none, every piece of content is *flagged* for a human to review. It is never silently passed.
- **Embeddings:** OpenAI if configured.

Missing configuration raises `ProviderNotConfiguredError`. The UI then shows **NOT CONFIGURED** instead of pretending the feature works.

## Costs and budgets

- Every agent run records input/output tokens and the cost in `agent_runs`. Costs use the pricing table in `lib/ai/pricing.ts`; update it when prices change.
- Each run with a non-zero cost adds an `ai_compute` expense, so Profit/ROI includes AI spend.
- Each agent has a daily budget (USD) and a maximum number of runs per day. The executor checks both **before** calling the model.

## Mock mode (local development only)

`AI_PROVIDER_MODE=mock` swaps in labelled fakes:
- text starts with `[MOCK]`
- images are a 1×1 PNG
- moderation flags the word "forbidden"

**The registry throws if mock mode is used in production** (`NODE_ENV=production`), and mock output is never presented as real.

## Adding a provider

1. Implement the relevant interface in `lib/ai/<provider>.ts`. Report `usage` and `costUsd`. Throw `ProviderError(message, retryable, status)` for API errors, and `ProviderRefusalError` for safety refusals.
2. Add a branch in `lib/ai/registry.ts` and its variables to `lib/config/integrations.ts`, `.env.example` and `docs/ENVIRONMENT.md`. `tests/ui/env-docs.test.ts` enforces the last two.
3. Add tests with a recorded or mocked HTTP layer. Never call a live API in CI.

## Status

- **Anthropic and OpenAI text adapters:** COMPLETE — REQUIRES CREDENTIALS. Implemented with the official SDK or HTTP API and unit-tested through the executor with mock providers. No live calls have been made from this repository.
- **Image, video, moderation and embedding adapters:** IMPLEMENTED — EXTERNAL VERIFICATION REQUIRED.
