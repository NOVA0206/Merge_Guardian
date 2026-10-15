# Production rollback

**Status: documented, not executed against a real Vercel project.** Verify it once in a staging project before you need it.

1. Detect: `release-verify.yml` fails and opens an `incident` issue with the run link.
2. Decide: a human confirms impact (rollback is deliberately not automatic).
3. Roll back the *serving* version (seconds): Vercel → Project → Deployments → last known good Production deployment → **Instant Rollback**, or `vercel rollback <deployment-url>`. This does not change git.
4. Database: migrations are expand/contract; if the bad release shipped a migration, do **not** drop columns to "undo". Ship a forward fix. Guardian blocks destructive migrations in use for this reason.
5. Repair git: revert the offending merge on `main` through a PR (`git revert -m 1 <merge-sha>`); the usual gates and Guardian apply. Vercel's rollback pins production until you promote a new deployment, so re-promote afterwards.
6. Re-run `release-verify` (workflow_dispatch) against the production URL and close the incident.
