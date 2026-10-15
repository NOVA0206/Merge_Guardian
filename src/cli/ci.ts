import { appendFileSync, readFileSync } from "node:fs";
import { Octokit } from "octokit";
import { OctokitGateway } from "@/github/octokit-gateway";
import type { GitHubGateway } from "@/github/gateway";
import type { GuardianDeps } from "@/graph/deps";
import { runGuardian } from "@/jobs/run-guardian";
import { buildReport } from "@/reporting/report-builder";
import { safeErrorMessage } from "@/security/secret-redaction";
import { MemoryStore } from "@/storage/memory";

/**
 * GitHub Actions mode: no database, no web app. The workflow job itself is the required check, so the
 * process exit code is the gate. State lives in GitHub (check runs, reviews); the in-memory store is per-run only.
 * Guardian only READS the PR through the API; it never executes pull-request code.
 */
export async function runCi(opts: { publish: boolean; waitSeconds?: number }): Promise<number> {
  const token = process.env.GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !eventPath || !repo) throw new Error("ci mode requires GITHUB_TOKEN, GITHUB_EVENT_PATH and GITHUB_REPOSITORY");

  const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number: number; head: { sha: string }; base: { sha: string } }; inputs?: { pr_number?: string } };
  let number = event.pull_request?.number;
  const octokit = new Octokit({ auth: token, baseUrl: process.env.GITHUB_API_URL, userAgent: "github-merge-guardian-ci" });
  let headSha = event.pull_request?.head.sha;
  let baseSha = event.pull_request?.base.sha;
  if (!number && event.inputs?.pr_number) {
    number = Number(event.inputs.pr_number);
    const [owner, name] = repo.split("/") as [string, string];
    const pr = (await octokit.rest.pulls.get({ owner, repo: name, pull_number: number })).data;
    headSha = pr.head.sha;
    baseSha = pr.base.sha;
  }
  if (!number || !headSha || !baseSha) throw new Error("This workflow must run on pull_request or workflow_dispatch with pr_number");

  let github: GitHubGateway = new OctokitGateway(octokit);
  if (!opts.publish) {
    const real = github;
    github = Object.assign(Object.create(real) as GitHubGateway, {
      upsertCheckRun: async () => 0,
      upsertReportComment: async () => 0,
    });
  }
  const store = new MemoryStore();
  const deps: GuardianDeps = { github, store, guardianVersion: process.env.npm_package_version ?? "ci", now: () => new Date() };
  const { job } = await store.enqueueJob({ idempotencyKey: `ci-${repo}#${number}@${headSha}`, repoFullName: repo, installationId: 1, prNumber: number, baseSha, headSha, trigger: "pull_request" });
  await store.claimJob(job.id);

  // Other required jobs may still be running: poll (bounded) until no mandatory check is pending.
  const deadline = Date.now() + (opts.waitSeconds ?? 0) * 1000;
  let attempt = 0;
  let out = await runGuardian({ repoFullName: repo, installationId: 1, prNumber: number, jobId: job.id, runId: `${job.id}:${attempt}`, trigger: "pull_request", expectedHeadSha: headSha }, deps);
  while (out.state.decision?.decision === "PENDING" && Date.now() < deadline) {
    console.log(`Waiting for mandatory checks: ${out.state.decision.pendingChecks.join(", ")}`);
    await new Promise((r) => setTimeout(r, 20_000));
    attempt++;
    out = await runGuardian({ repoFullName: repo, installationId: 1, prNumber: number, jobId: job.id, runId: `${job.id}:${attempt}`, trigger: "evaluate", expectedHeadSha: headSha }, deps);
  }
  const d = out.state.decision;
  if (!d) {
    console.error(`::error::Guardian produced no decision: ${out.state.errors.join("; ")}`);
    return 4;
  }
  for (const e of out.state.errors) console.error(`::warning::${safeErrorMessage(e)}`);

  const markdown = buildReport({
    meta: {
      runId: job.id,
      repo,
      prNumber: number,
      baseBranch: out.state.pr?.baseRef,
      baseSha: out.state.baseSha ?? baseSha,
      headSha,
      candidateSha: out.state.candidateSha,
      guardianVersion: deps.guardianVersion,
      policyVersion: out.state.policyVersion,
      startedAt: out.state.startedAt,
      completedAt: new Date().toISOString(),
      filesChanged: out.state.filesChanged,
      affectedModules: out.state.impact?.affectedModules ?? [],
      aiStatus: out.state.aiStatus,
    },
    decision: d,
    checks: out.state.checks,
    mandatoryChecks: d.pendingChecks.concat(d.failedChecks),
    selectedTests: out.state.impact ? Object.values(out.state.impact.selectedTests).flat() : [],
    newEnvVars: out.state.impact?.newEnvVars,
  });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  console.log(`Guardian decision: ${d.decision}`);
  for (const r of d.reasons) console.log(` - ${r}`);

  // PENDING means CI results are missing: in Actions mode the job gates the merge, so this must not pass.
  return d.decision === "PASS" || d.decision === "PASS_WITH_WARNINGS" ? 0 : d.decision === "REQUIRES_APPROVAL" ? 2 : 1;
}
