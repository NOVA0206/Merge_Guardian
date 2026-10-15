# Production setup (Vercel + Supabase + GitHub App + Inngest)

Do these in order. Nothing here needs code changes. Never commit values; `.env.example` lists names only.

## 1. Database (Supabase)

1. Create a project (use a **separate project for Preview** if you want isolated preview data).
2. *Project Settings → Database → Connection string → Transaction pooler* (port 6543). This is `DATABASE_URL`.
3. Apply the schema (idempotent, safe to repeat):
   ```bash
   DATABASE_URL='postgresql://…' npm run db:migrate
   ```
   It applies `src/storage/migrations/*.sql`, provisions LangGraph checkpoint tables in the private `guardian_graph` schema, and enables row-level security on every table (the app uses the owner connection; Supabase's public API keys can read nothing).
4. Only the server ever holds `DATABASE_URL`. Never use the `service_role` key in this app.

## 2. GitHub App

*Settings → Developer settings → GitHub Apps → New GitHub App*

| Field | Value |
|---|---|
| Homepage URL | `https://<your-domain>` |
| Callback URL | `https://<your-domain>/api/auth/callback` |
| Setup URL | `https://<your-domain>/api/github/setup` (tick *Redirect on update*) |
| Webhook URL | `https://<your-domain>/api/github/webhook` |
| Webhook secret | `openssl rand -hex 32` → `GITHUB_WEBHOOK_SECRET` |
| Expire user tokens / request user authorization | enabled (dashboard sign-in) |

**Repository permissions (least privilege):** Metadata: read · Contents: read · Pull requests: **write** · Issues: **write** (PR comment) · Checks: **write** · Actions: read · Deployments: read. Add **Contents: write** *only* if you enable the repair engine (`GUARDIAN_REPAIR_ENABLED=true`); analysis tokens are still minted read-only for contents.

**Subscribe to events:** Pull request, Pull request review, Check run, Issue comment, Installation, Installation repositories.

Then: generate a **private key** (PEM) → `GITHUB_APP_PRIVATE_KEY`; note *App ID* → `GITHUB_APP_ID`; *Client ID* → `GITHUB_APP_CLIENT_ID`; generate a *client secret* → `GITHUB_APP_CLIENT_SECRET`; app slug → `NEXT_PUBLIC_GITHUB_APP_SLUG`.

## 3. Durable jobs (Inngest)

1. Create an Inngest Cloud app. Copy the **Event key** → `INNGEST_EVENT_KEY` and **Signing key** → `INNGEST_SIGNING_KEY`.
2. After the first deploy, *Apps → Sync new app* with `https://<your-domain>/api/inngest`. (The Vercel integration can do this automatically on each deploy.)
3. Functions registered: `analyze-pull-request` (concurrency 1 per PR, 3 attempts) and `sweep-stuck-jobs` (every 5 min; re-dispatches lost events and re-publishes failure checks that could not be delivered during a GitHub outage).

One analysis step must finish inside the Vercel function limit (`maxDuration = 300` needs a plan that allows it; on Hobby the limit is lower and large repositories may time out; they will fail visibly and can be retried).

## 4. Vercel

1. *Add New → Project →* import this repository. Framework preset: Next.js. Build command `npm run build` (default). **No secrets are needed to build.**
2. Add environment variables (below). Use **different** values for Preview vs Production where marked.
3. Domains: *Settings → Domains*, set `APP_URL` to the canonical `https://` origin.
4. Keep Production connected to `main`. Preview deployments for every other branch/PR stay enabled.
5. (Recommended) *Deployment Protection → Protection Bypass for Automation* → copy the secret to the GitHub Actions secret `GUARDIAN_PREVIEW_BYPASS_TOKEN`.

### Environment variable checklist

| Variable | Dev | Preview | Production | Notes |
|---|:-:|:-:|:-:|---|
| `APP_URL` | ✓ | ✓ (preview URL or leave unset) | ✓ | canonical origin |
| `NEXT_PUBLIC_GITHUB_APP_SLUG` | ✓ | ✓ | ✓ | only public var |
| `SESSION_SECRET` | ✓ | ✓ (different) | ✓ | ≥32 chars |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | ✓ | ✓ | ✓ | use a **separate test GitHub App** for Preview |
| `GITHUB_WEBHOOK_SECRET` | ✓ | ✓ (different) | ✓ | |
| `DATABASE_URL` | ✓ | ✓ (preview DB) | ✓ (prod DB) | pooled connection |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | – | ✓ | ✓ | Inngest *branch* env for Preview |
| `ANTHROPIC_API_KEY`, `GUARDIAN_MODEL` | opt | opt | opt | AI step is skipped without a key |
| `GUARDIAN_AI_REQUIRED`, `GUARDIAN_REPAIR_ENABLED` | opt | opt | opt | both default `false` |
| `GUARDIAN_ADMIN_LOGINS` | opt | opt | opt | comma-separated logins |
| `GITHUB_API_URL`, `GITHUB_WEB_URL` | – | – | GHES only | must be https in production |

Mark secrets **Sensitive** in Vercel. Never give Preview deployments the production database or production GitHub App.

## 5. Verify the installation

1. `curl https://<domain>/api/health` → `{"status":"ok", …}` (`503 degraded` + which check is false if misconfigured; names of missing variables are shown only to signed-in admins).
2. Open the site → *Sign in with GitHub* → dashboard.
3. *Install the GitHub App* on a **test repository** → you land on the dashboard with the repo listed.
4. In the test repo run `npm run guardian -- init` (or copy `.guardian/` from `tests/fixtures/app-base`), review it, set `reviewed: true`, merge to the default branch. Add the workflows from this repo's `.github/workflows` with job names matching `mandatoryChecks` (`lint`, `typecheck`, `unit-tests`, `build`).
5. Open a PR. Expect: check run **Guardian / architecture** *in progress* immediately, then a decision and one PR comment; the job appears in the dashboard with its head/base SHAs.
6. Send the same webhook again from *GitHub App → Advanced → Redeliver*: no second job/comment.
7. `PLAYWRIGHT_BASE_URL=https://<domain> npx playwright test` runs the deployment-safe checks against production/preview.

## 6. GitHub Actions secrets/variables (in the repo being protected)

`GUARDIAN_PREVIEW_BYPASS_TOKEN` (secret, optional) · `PRODUCTION_URL` (variable, for `release-verify.yml`). The workflows use only the built-in `GITHUB_TOKEN` otherwise.

## 7. Protect `main`

See [branching-strategy.md](branching-strategy.md). Required checks: `Guardian / architecture`, `lint`, `typecheck`, `unit-tests`, `build`, `preview-e2e`, `repair-scope`, `e2e-fullstack`.
