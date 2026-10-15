# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/health` → `503 degraded` | `checks.configuration` false → env missing/invalid; `database: unreachable` | Sign in as an admin (`GUARDIAN_ADMIN_LOGINS`) and re-call `/api/health` to see variable *names*; check `DATABASE_URL` (pooled string) |
| Webhook deliveries show 401 in GitHub | Secret mismatch or body altered by a proxy | Make `GITHUB_WEBHOOK_SECRET` equal the App's secret; no body-rewriting middleware |
| Delivery 200 but nothing happens | Repo not installed/enabled, or installation id mismatch | Dashboard → repositories; reinstall / press *Enable* |
| Job stuck `queued` | Inngest app not synced or keys wrong; event lost | Sync `/api/inngest` in Inngest; the 5-min sweeper re-dispatches; check `INNGEST_*` |
| Check stays *in progress* / *Expected* | GitHub was unreachable; or Guardian check never created | Dashboard job page → *Retry*; the sweeper re-publishes failure checks once GitHub recovers |
| Job `failed` | Read the error on the job page. Transient failures are retried 3×; then the check fails closed | *Retry analysis* after fixing the cause |
| `ERROR: Missing Guardian config file` | `.guardian/*.yaml` absent on the **base** branch | Run `npm run guardian -- init`, review, merge to base first |
| `PENDING` for a long time | A mandatory check name in `risk-policy.yaml` doesn't match a real check-run name | Align names; after 45 min a missing check turns the result into `BLOCKED` |
| `REQUIRES_APPROVAL` but approval ignored | Approver not in `architectureApprovers`, approved an older commit, is the PR author, or only commented | Approve with a GitHub review on the current head from a listed approver |
| Preview check fails "no deployment found" | Vercel hasn't finished, or Git integration is off, or creator not `vercel[bot]` | Check Vercel build; protection bypass secret; see logs of `preview-e2e` |
| `deployment serves X, expected Y` | Alias points to an older deployment / your app lacks `/api/health` commit field | Add the health endpoint to the app (returns `commit: process.env.VERCEL_GIT_COMMIT_SHA`) |
| Analysis times out on Vercel | Large repo vs function limit | Raise plan limit / `GUARDIAN_MAX_SNAPSHOT_MB`; exclude vendored dirs |
| False positive | Heuristic mismatch | Add the field/consumer to `protected-contracts.yaml`, tune `severityOverrides`, or approve (waivable rules only) |
| Local e2e fails to start | Port in use (3100/54329/54330/8288) or no build | `npm run build`; free the ports |
