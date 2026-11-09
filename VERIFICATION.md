# Verification log (2026-11-06)

Method: fetched the official provider doc for each claim area (`read`) and ran HTTP probes (`tested`). Anything from memory is marked `unverified` in the guide itself.

## Confirmed by primary docs
| Claim | Source |
|---|---|
| GitHub: 3 required fields, up to 10 callback URLs, 100 apps per owner, token expiry on by default, no review mentioned | docs.github.com creating-an-oauth-app |
| Notion: public integration needs "Any workspace" scope fixed at creation; token endpoint uses Basic auth; refresh returns a new pair; Marketplace review not required to authorize | developers.notion.com/docs/authorization |
| Slack: HTTPS redirect, no `#`, same redirect_uri in both steps when several are configured; rotation for granular-permission apps | docs.slack.dev installing-with-oauth |
| Slack Marketplace: ≥10 active workspaces and ≥20 MAU; team may deny any app; 2-business-day support reply | docs.slack.dev marketplace guidelines |
| Google: restricted scopes need annual third-party assessment (CASA), "can potentially take several weeks", reverify every 12 months from LOA date, brand verification 2-3 business days, exceptions for personal/internal use | developers.google.com restricted-scope-verification |
| LinkedIn: 30-minute code, 60-day tokens, programmatic refresh only for a limited set of partners, Community Management Dev tier limits (500/app/24h, 100/member/24h, 12 months), restricted APIs have no fixed timeline | learn.microsoft.com LinkedIn docs |

## Found by probing (not in any doc)
- **Slack's `/.well-known/openid-configuration` returns 200 but is Sign in with Slack** (scopes openid/profile/email), not the app-install flow. A naive agent would take the wrong endpoints. This is now called out in the guide and in the agent prompt.
- GitHub, Notion and LinkedIn publish no discovery metadata (404/400), so docs are the only endpoint source. Google publishes full metadata (PKCE `S256`/`plain`, device and JWT grants).
- A 200 on a console URL is not proof it is usable: GitHub and Google redirect to sign-in, which is why registration steps are marked "you".

## Corrected during the work
- I expected LinkedIn's posting products to be self-serve. The docs show Community Management and Advertising go through an application and a **second** request for Standard tier, so I raised difficulty to 4 and added the tier caps.
- I first drafted GitHub's "secret shown once" and "localhost callbacks allowed" from memory. Neither was in the fetched page, so I removed them rather than present them as sourced.
- The first LinkedIn URL I tried (`marketing/getting-access`) redirected to `increasing-access`, which I then read; the guide cites the page I actually read.

## Could not verify (shown as `unverified` or "not published" in guides)
- Google Testing mode: 100 test-user cap and 7-day refresh-token expiry (the help page I fetched was a landing page).
- Google assessor cost.
- GitHub org-level OAuth App access restrictions (cited from memory).
- Slack distribution activation steps (the OAuth page omits them), Slack Marketplace review duration, Notion Marketplace review duration and access-token lifetime.
- Real-world approval turnaround for LinkedIn and Google. The "weeks" estimates are Google's own wording or labeled as mine.

## Live-generated guides checked (Groq, `openai/gpt-oss-120b`, 2026-11-06)
| App | Result |
|---|---|
| HubSpot | First run marked Marketplace certification as *required* and gave a "1-2 weeks" total with no source. Fixed by prompt: separate "required for other accounts" from "required for listing", and unsourced durations must say "my estimate". Rerun: difficulty 1, approval not required (certification only for listing), time labeled as estimate. Not independently re-checked against HubSpot beyond the pages it read. |
| Zoom | First run claimed no review is needed for other users to authorize. I fetched Zoom's review page: it says only that private and beta apps skip review and public and unlisted apps go through review, and never says who can authorize a development app. The claim was an overreach. Added a prompt rule against asserting installability the notes don't state; rerun now lists the tiers and rates review as required for public/unlisted (difficulty 3). |
| Calendly | Generated (difficulty 1, no review). **Not independently checked.** |

Bugs found by running it for real: the model's output sometimes arrives as mojibake (repaired in code), Groq rejects incomplete tool calls with a 400 (retried), the model drops list fields (derived from step owners), and the 8k tokens-per-minute cap broke the original open-ended tool loop (replaced by the staged pipeline).

## Not tested
- Stronger models, or paid Groq tiers (the pacer budget is `LLM_TPM`).
- Any app beyond the three above on the live path.
