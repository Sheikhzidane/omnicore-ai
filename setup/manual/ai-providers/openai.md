# OpenAI

**Used for:** Image generation, moderation, embeddings, optional video (set AI_VIDEO_PROVIDER=openai), and optional text.

**You will set:** `OPENAI_API_KEY`

1. Go to <https://platform.openai.com> and sign in.
2. Open **Settings → Billing** and add credit. Set usage limits under **Limits**.
3. Image and video models can require **organization verification** (Settings → Organization → General). Complete it if generation reports an access error.
4. Open **API keys → Create new secret key**, restricted to this project.
5. Paste it into Vercel as `OPENAI_API_KEY` (Sensitive).
6. Redeploy. **Settings → AI Providers** should show Image and Moderation as `openai`.

Each agent has a daily budget; see AI Agents → Control Centre. Actual spend per run is under AI Agents → Runs. More detail: docs/AI_PROVIDERS.md
