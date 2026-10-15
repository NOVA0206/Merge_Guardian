/**
 * Used by preview-e2e.yml and release-verify.yml.
 *   tsx scripts/verify-deployment.ts preview  --repo owner/name --sha <sha> --smoke .guardian/smoke.yaml
 *   tsx scripts/verify-deployment.ts url      --url https://prod.example.com --smoke .guardian/smoke.yaml [--sha <sha>]
 * Reads GITHUB_TOKEN (preview) and GUARDIAN_PREVIEW_BYPASS_TOKEN (optional). Writes the URL to $GITHUB_OUTPUT.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolvePreviewDeployment, verifyDeployedCommit } from "../src/verification/preview";
import { parseSmokeConfig, runSmoke, summarizeSmoke } from "../src/verification/production-smoke";

async function main(): Promise<number> {
  const [mode, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, sha: { type: "string" }, url: { type: "string" }, smoke: { type: "string" }, timeout: { type: "string", default: "600" } } });
  const bypass = process.env.GUARDIAN_PREVIEW_BYPASS_TOKEN;
  let url = values.url;

  if (mode === "preview") {
    if (!values.repo || !values.sha || !process.env.GITHUB_TOKEN) throw new Error("preview mode needs --repo, --sha and GITHUB_TOKEN");
    const r = await resolvePreviewDeployment({ repo: values.repo, sha: values.sha, token: process.env.GITHUB_TOKEN, timeoutMs: Number(values.timeout) * 1000 });
    if (!r.ok || !r.url) {
      console.error(`::error::${r.reason}`);
      return 1; // missing/stale/failed preview => the required check FAILS; never success
    }
    url = r.url;
  }
  if (!url) throw new Error("--url is required");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
  console.log(`Verifying ${url}`);

  if (values.sha) {
    const c = await verifyDeployedCommit({ url, expectedSha: values.sha, bypassToken: bypass });
    if (!c.ok) {
      console.error(`::error::${c.reason}`);
      return 1;
    }
    console.log(`Deployment serves the expected commit ${values.sha.slice(0, 7)}`);
  }
  if (values.smoke) {
    const results = await runSmoke(url, parseSmokeConfig(readFileSync(values.smoke, "utf8")), { headers: bypass ? { "x-vercel-protection-bypass": bypass } : undefined });
    const { ok, markdown } = summarizeSmoke(results);
    console.log(markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Smoke tests\n\n${markdown}\n`);
    if (!ok) return 1;
  }
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`::error::${(e as Error).message}`);
    process.exit(2);
  },
);
