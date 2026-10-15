#!/usr/bin/env tsx
/**
 * guardian CLI
 *   guardian init     [--dir .]                              draft the six .guardian files + baseline report
 *   guardian analyze  --base <ref|dir> --head <ref|dir> ...  deterministic analysis of a change (no network)
 *   guardian verify-repair --base <ref> --head <ref>         scope check for guardian/fix-* branches
 *   guardian ci                                              GitHub Actions mode: analyse the PR in $GITHUB_EVENT_PATH
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { buildContext } from "@/analysis/context";
import { runStaticAnalysis } from "@/analysis/static-analysis";
import { evaluatePolicy } from "@/policy/decisions";
import { buildReport } from "@/reporting/report-builder";
import { discoverBaseline } from "@/repository/architecture-discovery";
import { snapshotFromDirectory, snapshotFromGitRef, type RepoSnapshot } from "@/repository/snapshot";
import { verifyRepairScope } from "@/repair/test-runner";
import type { CheckResult } from "@/reporting/finding-schema";
import { safeErrorMessage } from "@/security/secret-redaction";

const EXIT_BY_DECISION: Record<string, number> = { PASS: 0, PASS_WITH_WARNINGS: 0, PENDING: 0, REQUIRES_APPROVAL: 2, BLOCKED: 1, STALE: 3, ERROR: 4 };

function load(spec: string): RepoSnapshot {
  const dir = resolve(spec);
  if (existsSync(dir) && !existsSync(join(dir, ".git", "HEAD")) && !/^[0-9a-f]{7,40}$/.test(spec)) return snapshotFromDirectory("0".repeat(40), dir);
  return snapshotFromGitRef(spec);
}

function parseChecks(spec: string | undefined, sha: string): CheckResult[] {
  if (!spec) return [];
  return spec.split(",").filter(Boolean).map((p) => {
    const [name, status] = p.split("=");
    return { name: name!.trim(), status: (status ?? "PASS").trim().toUpperCase() as CheckResult["status"], headSha: sha };
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: "string", default: "." },
      base: { type: "string" },
      head: { type: "string" },
      checks: { type: "string" },
      "skip-checks": { type: "boolean", default: false },
      format: { type: "string", default: "text" },
      force: { type: "boolean", default: false },
      author: { type: "string", default: "unknown" },
      "no-publish": { type: "boolean", default: false },
      wait: { type: "string", default: "0" },
    },
    allowPositionals: true,
  });

  switch (cmd) {
    case "init": {
      const root = resolve(values.dir!);
      const draft = discoverBaseline(snapshotFromDirectory("0".repeat(40), root));
      for (const [rel, text] of Object.entries(draft.files)) {
        const target = join(root, rel);
        if (existsSync(target) && !values.force) {
          console.log(`exists  ${rel} (use --force to overwrite)`);
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
        console.log(`wrote   ${rel}`);
      }
      writeFileSync(join(root, ".guardian", "BASELINE_REPORT.md"), draft.report);
      console.log("\n" + draft.report);
      return 0;
    }

    case "analyze": {
      if (!values.base || !values.head) throw new Error("--base and --head are required");
      const base = load(values.base);
      const head = load(values.head);
      const ctx = buildContext(base, head);
      const policy = values["skip-checks"] ? { ...ctx.config.policy, mandatoryChecks: [] } : ctx.config.policy;
      const { findings, impact } = runStaticAnalysis(ctx);
      const decision = evaluatePolicy({ findings, checks: parseChecks(values.checks, head.sha), policy, headSha: head.sha, reviews: [], prAuthor: values.author!, ai: "skipped" });
      if (values.format === "json") console.log(JSON.stringify({ decision: decision.decision, reasons: decision.reasons, findings: decision.findings, impact }, null, 2));
      else {
        console.log(
          buildReport({
            meta: { runId: "local", repo: "local", prNumber: 0, baseSha: base.sha, headSha: head.sha, guardianVersion: "cli", policyVersion: ctx.config.version, startedAt: new Date().toISOString(), filesChanged: ctx.changes.files.length, affectedModules: impact.affectedModules, aiStatus: "skipped" },
            decision,
            checks: parseChecks(values.checks, head.sha),
            mandatoryChecks: policy.mandatoryChecks,
            selectedTests: Object.values(impact.selectedTests).flat(),
            newEnvVars: impact.newEnvVars,
          }),
        );
      }
      return EXIT_BY_DECISION[decision.decision] ?? 4;
    }

    case "verify-repair": {
      if (!values.base || !values.head) throw new Error("--base and --head are required");
      const out = execFileSync("git", ["diff", "--name-only", `${values.base}...${values.head}`], { encoding: "utf8" });
      const result = verifyRepairScope(out.split("\n").filter(Boolean));
      for (const v of result.violations) console.error(`::error::${v}`);
      console.log(result.ok ? "Repair scope OK" : "Repair scope violations found");
      return result.ok ? 0 : 1;
    }

    case "ci": {
      const { runCi } = await import("./ci");
      return runCi({ publish: !values["no-publish"], waitSeconds: Number(values.wait) || 0 });
    }

    default:
      console.error("Usage: guardian <init|analyze|verify-repair|ci> [options]");
      return 64;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`guardian: ${safeErrorMessage(e)}`);
    process.exit(4);
  },
);
