# Anthropic (Claude)

**Used for:** Text: every agent, caption drafting, analysis. Also moderation when OpenAI is not configured.

**You will set:** `ANTHROPIC_API_KEY`

1. Go to <https://console.anthropic.com> and sign in or create an account.
2. Open **Settings → Billing** and add credit or a payment method.
3. Open **Settings → Limits** and set a monthly spend limit you are comfortable with.
4. Open **API Keys → Create Key**. Name it "omnicore-production".
5. Copy the key **once**, straight into Vercel as `ANTHROPIC_API_KEY` (Sensitive). Do not store it anywhere else.
6. Redeploy. **Settings → AI Providers** in Omnicore should show Text as `anthropic`.

Each agent has a daily budget; see AI Agents → Control Centre. Actual spend per run is under AI Agents → Runs. More detail: docs/AI_PROVIDERS.md
