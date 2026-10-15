# Architecture

## Layout

| Path | Responsibility |
|---|---|
| `src/app/` | Next.js routes: dashboard, `/api/github/webhook`, `/api/inngest`, auth, jobs API, health |
| `src/jobs/` | `webhook-handler` (verify → dedupe → enqueue), `pipeline` (claim/run/fail-closed), `functions` (Inngest), `run-guardian` (graph + checkpointer) |
| `src/graph/` | LangGraph workflow: `state`, `nodes/*`, `routing`, `deps` |
| `src/repository/` | Snapshots (zipball/dir/git ref), diff, **TypeScript-compiler-API dependency graph**, route-contract & baseline discovery |
| `src/analysis/` | Deterministic analyzers (architecture, API contract, exports/imports, migrations, env, deps, secrets, workflows, auth), evidence validator, semantic (LLM) review |
| `src/policy/` | Rule catalogue, severity classification, approval evaluation, **the single decision function** |
| `src/repair/` | Virtual workspace, patch generators (deterministic first, LLM fallback), validator, controller |
| `src/github/` | Gateway interface + Octokit implementation (scoped installation tokens), check-run mapping |
| `src/storage/` | `Store` interface; PostgreSQL implementation; SQL migrations |
| `src/verification/` | Preview resolution bound to the commit; smoke tests |
| `src/cli/` | `init`, `analyze`, `verify-repair`, `ci` (Actions mode) |
| `.guardian/` | Six policy files + `smoke.yaml` |

*Deviation from the original sketch:* GitHub operations live in `octokit-gateway.ts` (one cohesive class behind an interface) instead of five thin files; verification of builds/tests is done by CI workflows rather than wrapper modules.

## Trust model for configuration

Policy (`.guardian/*.yaml`) is **always read from the base revision**. A PR that edits it cannot weaken its own review; the edit itself is an `arch/protected-path-changed` finding requiring an approver, and the PR's proposed config is used only to recognise an *intentional* architecture change (Scenario E).

## Workflow

`loadPullRequest → loadArchitectureBaseline → parseDiff → buildImpactGraph → {runStaticAnalysis ‖ analyzeContracts ‖ analyzeArchitecture ‖ analyzeSecurity ‖ semanticReview} → mergeFindings → validateEvidence → classifySeverity → collectVerification → evaluatePolicy → publishReport → (requestHumanApproval ⟲ collectVerification | prepareRepair → validateRepair → waitForUpdatedCommit → rerunAnalysis) → finalizeDecision`

* State is small and serializable (checkpointed in Postgres, schema `guardian_graph`); large objects (snapshots, graphs) are rebuilt from GitHub after a restart.
* One LangGraph thread per `(repo, PR, head SHA)`: a new commit is a fresh workflow, so approvals never carry over.
* `requestHumanApproval` uses `interrupt()`. Resumption carries **no authority**: reviews are re-read from GitHub and re-evaluated.
* Errors: transient (network/5xx/429) are re-thrown for the durable runner to retry; permanent errors are recorded and produce `ERROR` (check fails).

## Policy

`evaluatePolicy` (`src/policy/decisions.ts`) is pure and deterministic. Order: stale → analysis error → AI-required-but-unavailable → mandatory checks → approvals → blocking findings. Model-originated findings are clamped (no P0; no P1 without non-model evidence; low confidence capped; sensitive categories become P2 review rather than disappearing). Rules marked non-waivable (security, auth, secrets, migrations in use, broken imports) cannot be approved away; approval can only waive reviewable architecture findings, and never overrides a failing mandatory check.

## Data model

`webhook_deliveries`, `installations`, `repositories`, `analysis_jobs` (unique `idempotency_key`; status, attempts, decision, result JSON, check-run/comment ids), `findings`, `pr_state`, `audit_log`, `repair_sessions`; plus LangGraph checkpoint tables. RLS enabled on all.

## Repair

Requested only by a write-access user via `/guardian fix <findingId>` on the current head. Generated server-side (secrets never meet PR code), validated (scope, syntax, size, **re-running the analyzers on the patched tree**: the finding must disappear and no new P0/P1 may appear), then published as a **draft PR from `guardian/fix-PR-<n>`** into the feature branch. Isolated CI (`guardian-repair.yml` + the normal gates, no secrets) verifies it; a developer merges it; a fresh analysis then runs on the new commit.
