# Security

## Controls implemented (and tested)

| Threat | Control |
|---|---|
| Forged webhook | HMAC-SHA256 over the **raw body**, constant-time compare; nothing recorded before verification |
| Duplicate/replayed delivery | `webhook_deliveries` dedupe + unique job `idempotency_key`; failed processing un-records the delivery so GitHub's retry works |
| Stale results satisfying checks | Head SHA bound at every step; mismatch → `STALE`, check `cancelled`; old jobs superseded on `synchronize` |
| PR weakening its own policy | Config read from the base revision only; edits to `.guardian/**` and workflows require an approver |
| AI as authority / prompt injection | Model output is schema-validated, evidence-checked, severity-clamped; repository text is fenced as `<untrusted>`; the model has no tools |
| Fake approval | Only native GitHub `APPROVED` reviews, from configured approvers, not the author, on the **current head SHA**, not superseded |
| Secrets in reports/logs | Secret patterns and configured values redacted from reports, errors and prompts; secret findings never echo the value |
| Untrusted code with secrets | Guardian never executes PR code. Tests run in GitHub Actions on `pull_request` (no secrets for forks). Fork PRs fail the preview check rather than being skipped |
| Over-privileged tokens | Installation tokens minted per use with only needed permissions (analysis: contents **read**); repair token is a separate scope |
| Repair abuse | Write-access requester re-verified at execution; only `guardian/*` branches (also enforced in the gateway); draft PR only; forbidden paths; max files/lines; never fork PRs |
| Unauthorized dashboard access | Signed, httpOnly, SameSite=Lax session (4h); installation-scoped authorization on every job; same-origin check on state changes; DB-backed rate limit on retry |
| Database exposure | RLS on all tables, no policies; checkpoint tables in a private schema; server-only connection string |
| Config mistakes | Zod-validated env; health never reveals values; production rejects non-https GitHub URLs |

## Known limitations

* Heuristic analyzers (regex SQL parsing, string-literal API consumer matching, auth-identifier counting) can miss or over-report. Findings carry confidence and *probable/potential* kinds; they are not proofs. Dynamic route construction and ORMs are not understood.
* Monorepos with several `package.json` files are checked against the root manifest only.
* The in-process rate limit uses audit-log counts (best effort across instances, not a hard guarantee).
* `fork` PRs: analysis works (read-only), but Actions-mode check publication and preview tests are intentionally unavailable.
* Rollback to a previous Vercel deployment is documented, not automated.
* Guardian cannot enforce branch protection; an admin must configure it (see branching-strategy.md).
* The GitHub App private key is a high-value secret: restrict who can read Vercel environment variables and rotate on staff changes.
