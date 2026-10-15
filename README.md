# GitHub Merge Guardian

An architecture-aware merge control system for GitHub pull requests, deployed on Vercel.

Guardian checks every PR (the **merge candidate**, not just the branch) against a reviewed architecture baseline, API/database/environment contracts and security rules, then publishes **one deterministic, auditable decision** as a required GitHub check. AI adds findings; it never decides, approves or merges.

```
GitHub ──webhook──▶ Vercel (Next.js route, verifies HMAC on raw body, writes a job row, returns fast)
                        │ event
                        ▼
                 Inngest (durable, retried, 1 run per PR)
                        │
                        ▼  LangGraph.js workflow
   load PR → baseline (from BASE branch) → diff → impact graph (TypeScript compiler API)
     → [static | contracts | architecture | security | semantic review (LLM)]  (parallel)
     → merge → validate evidence → classify severity → collect checks & reviews → deterministic policy
     → publish PR report + required check → (pause for approval | repair | finalize)
                        │
                        ▼
              Supabase/Postgres (jobs, findings, audit log, LangGraph checkpoints)
```

## Decisions

`PASS` · `PASS_WITH_WARNINGS` · `REQUIRES_APPROVAL` · `BLOCKED` · `PENDING` · `STALE` · `ERROR`.
Only the first two make the check green. A missing/skipped mandatory check is never success; a stale commit, an unavailable GitHub API, or an invalid config **fails closed**.

## Quick start

```bash
npm ci
npm test                 # 200+ unit/integration tests (incl. real PostgreSQL)
npm run build            # production build
npx playwright install chromium
npm run test:e2e         # full stack on the production build (real Postgres + Inngest dev server + mock GitHub)
npm run guardian -- analyze --base <ref|dir> --head <ref|dir> --skip-checks   # local analysis, no network
npm run guardian -- init # draft .guardian/*.yaml for an existing repo (reviewed: false until you approve)
```

## Documentation

| Doc | Purpose |
|---|---|
| [docs/setup.md](docs/setup.md) | **Production deployment**: Supabase, GitHub App, Inngest, Vercel, env checklist, verification |
| [docs/architecture.md](docs/architecture.md) | Components, workflow graph, policy, data model |
| [docs/security.md](docs/security.md) | Threat model, permissions, what is and isn't protected |
| [docs/branching-strategy.md](docs/branching-strategy.md) | Migrating from direct pushes to PRs; protecting `main` |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms → causes → fixes |
| [docs/rollback.md](docs/rollback.md) | Production rollback procedure |

## What is verified (and what is not)

See the implementation report in [docs/status.md](docs/status.md): it separates what ran green locally from the steps that need your credentials (GitHub App, Vercel, Supabase, Inngest Cloud).
