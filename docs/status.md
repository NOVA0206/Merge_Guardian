# Implementation status

Measured on Windows 11, Node 24, 2026-10-15.

## Verified (ran and passed)

| Check | Result |
|---|---|
| `eslint .` | clean |
| `tsc --noEmit` (strict) | clean |
| `vitest run` | **204 tests / 10 files pass** (unit, scenarios A-J at policy level, workflow graph incl. approval pause/resume with a checkpointer, repair, webhook, pipeline, verification, store contract) |
| Store contract on MemoryStore, PGlite and **real PostgreSQL 17** with a multi-connection `pg.Pool`, incl. 12-way races for enqueue/claim/delivery | pass |
| `npm run db:migrate` twice against real PostgreSQL (idempotent), LangGraph `PostgresSaver` setup, RLS | pass |
| `next build` (production, no secrets set) | success, 15 routes |
| `npm audit --omit=dev` | 0 vulnerabilities (5 high advisories remain in the dev-only `eslint-config-next` toolchain) |
| Playwright on the **production build** with real PostgreSQL + Inngest dev server + mock GitHub API | **18 / 18 pass**: signed webhook → durable job → check run + PR comment → dashboard; duplicate/redelivered webhooks; pending-CI then re-evaluation; failed CI; stale commit; GitHub outage → failed job visible → manual retry → success; OAuth sign-in; CSRF; unauthorized access |

Bugs found *by* these tests and fixed: SQL identifiers like `"public"."t"` not parsed; Next.js `[id]` paths rejected; fail-closed path throwing instead of `ERROR`; exhausted jobs leaving a check pending forever; late "retries exhausted" callback overwriting a successful check; repair validator correctly rejecting a consumer-only fix for a protected contract.

## Implemented but NOT verified against the real services (needs your credentials/admin)

* GitHub App registration, real webhook delivery, real Check Run / comment API behaviour (only a mock of the endpoints Guardian uses was exercised).
* Vercel deployment, environment variables, Deployment Checks, Instant Rollback; `preview-e2e.yml` / `release-verify.yml` were YAML-validated and their logic unit-tested, but never run on GitHub Actions.
* Supabase (the SQL is plain PostgreSQL and was verified on PostgreSQL 17; pooler specifics are not).
* Inngest **Cloud** (only the official dev server was used).
* The LLM steps (`semanticReview`, `ModelPatchGenerator`): tested with fakes for validation/clamping/fail-safe behaviour; never called a real model.
* Repair against real GitHub (branch/commit/draft PR) — tested with a fake gateway; the gateway's branch-name guard is tested directly.
* Rollback procedure (documented only).

## Not built / limits

* No Guardian-side execution of lint/tests/builds (by design: CI does that; Guardian consumes the results). Browser regression is the deployment-safe suite plus your own specs.
* Heuristic analyzers (see security.md); single root `package.json`; no ORM/Prisma schema understanding.
* No in-dashboard approval UI (approvals are native GitHub reviews by design).
* Spec file layout was adapted (GitHub gateway in one file; no empty placeholder modules).
* `guardian-repair.yml` verifies repair scope in CI; patch generation runs in the app, not in Actions.
