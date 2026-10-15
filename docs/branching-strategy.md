# Branching strategy and protecting `main`

Never reset `main` and never force-push shared history. Migrate by *adding* protections.

## Workflow

1. Each developer branches from current `main`: `feature/<developer>-<feature>`.
2. Open a PR → Guardian analyses the **merge candidate** (PR + latest `main`) and reports `Guardian / architecture`.
3. Optional integration branch `develop`: merge compatible PRs there, let the combined result pass all checks, then open a release PR `develop → main`. If you go straight to `main`, enable the **merge queue** so each PR is re-validated on top of the PRs ahead of it (two individually green PRs can conflict; Scenario D).
4. `main` deploys to Vercel Production; `release-verify.yml` smoke-tests it.
5. Guardian repair branches are `guardian/fix-PR-<n>`; they target the feature branch, never `main`.

## Required settings (an administrator does these; Guardian never changes repository settings)

*Settings → Rules → Rulesets (or Branches → Protection) for `main`:*

- Require a pull request; **≥1 approving review**; **dismiss stale approvals on new commits**; require review from Code Owners.
- Require status checks (must be the **latest** commit and up to date with `main`): `Guardian / architecture`, `lint`, `typecheck`, `unit-tests`, `build`, `preview-e2e`, `repair-scope`, `e2e-fullstack`.
- Require merge queue (recommended). Block force pushes and deletions. Restrict bypass to a small admin group.
- Add `.github/CODEOWNERS` entries for `.guardian/`, `.github/`, migrations.
- Vercel: *Settings → Git → Deployment Checks* → select the required checks so production promotes only when they pass.

Note: a **skipped** job satisfies a required check. All workflows here are written to run and pass/fail rather than skip.

## Safe migration from direct pushes

1. Merge Guardian + workflows + `.guardian/` via a normal PR (baseline `reviewed: false` → advisory structural rules).
2. Review the baseline report; tighten `module-map.yaml`; set `reviewed: true`.
3. Add the required checks one at a time once they are green on `main`.
4. Finally require PRs and remove direct-push rights.
