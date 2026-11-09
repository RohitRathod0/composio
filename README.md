# OAuth Pathfinder

Look up an app, get a shareable guide to setting up and getting approved for its OAuth app, and see which steps an agent can do and which need you.

## Run it

```bash
node server.js                       # Node 22+, zero dependencies; http://localhost:3000
GROQ_API_KEY=... node server.js      # enables live agent generation (free Groq key)
node test/agent.test.mjs             # agent loop + evidence audit against a fake API
```

Env: `GROQ_MODEL` (default `openai/gpt-oss-120b`), `LLM_BASE_URL` (any OpenAI-compatible endpoint), `GEN_PER_HOUR` (per-IP generation limit, default 10), `PORT`.
Without a key the server still runs, and unknown apps get a clearly labeled **probe-only** result (see Limitations).

## The problem, as I understood it

A provider OAuth app is the registration (client ID/secret, redirect URIs, scopes, branding) that *your product* holds with a provider. Your users' connections are tokens issued through it. Whether you can ship depends on what the provider wants before it lets *other people's* accounts authorize your app: nothing (GitHub, Notion), verification (Google), or a partnership-style application (LinkedIn). That gap is invisible until a developer hits it, so the guide leads with **difficulty, time split into hands-on vs. waiting, and whether approval is required**, then steps labeled by who does them.

## What's here

- `guides/` – 5 curated guides picked for different shapes of difficulty: GitHub and Notion (self-serve), Slack (self-serve, optional gated listing), Google Gmail (security assessment), LinkedIn (product-level approval and tiers).
- `lib/tools.js` – agent tools: `fetch_url`, `search_web`, `probe_oauth` (well-known discovery), `check_urls`. SSRF-guarded.
- `lib/agent.js` – tool-use loop ending in a `submit_guide` call with a strict schema.
- `server.js`, `public/index.html` – streaming progress UI; every guide has a permalink (`/g/<slug>`).
- `VERIFICATION.md` – what I checked, corrected, and couldn't verify.

## Key decisions

1. **Evidence labels are built by code, not requested from the model.** Each source is `tested` (a request I made), `read` (page actually fetched, HTTP 2xx), or `unverified`. The model can only cite source ids that exist (`test/agent.test.mjs`). It can still misread or over-generalize a page it read.
2. **Hands-on time and waiting are separate.** Developers underestimate waiting, not typing.
3. **"Agent can / you do" per step.** Console sign-ins, payment, demo videos, and provider emails sit behind the developer's identity. Probes confirmed that GitHub, Google and Notion consoles need a login, so I did not pretend to automate registration.
4. **Unknown stays unknown.** Guides say "not published" where no source gave a timeline, and label any estimate as mine.

## Limitations (read these)

- **The live path is tested on three apps (HubSpot, Zoom, Calendly) with `openai/gpt-oss-120b` on Groq's free tier, not on a stronger model.** Groq caps requests and tokens-per-minute at 8,000, so the agent is a staged pipeline (search, model picks pages, model condenses each, model writes the guide) with a built-in pacer, not an open-ended tool loop. A run takes about 70-90 seconds. The model can still overstate: the first Zoom guide claimed other accounts could authorize without review, which Zoom's docs do not say (see `VERIFICATION.md`). A prompt rule fixed that case; I can't promise it holds for every app.
- **Probe-only mode is minimal:** reachability and discovery metadata. Search is a scrape of DuckDuckGo Lite, which can break or rate-limit; probe-only mode falls back to guessing common docs URLs.
- Agents do not create OAuth apps; those consoles need a human login and often legal identity. "Attempt as much setup as practical" is covered by generating the config (redirect URIs, scopes, manifests, justification text), not by driving the console.
- Only 5 of 100 guides exist. Curated guides are dated 2026-11-06 and will drift; there is no refresh job.
- Discovery metadata can mislead (Slack's is sign-in only). The agent prompt warns about this, but a model could still be fooled.
- Generated guides are saved to `data/generated/` unreviewed and public by link. Add review before real use.
- Time estimates not stated by a provider are my estimates and are labeled.
