import type { CheckResult } from "@/reporting/finding-schema";

export const GUARDIAN_CHECK_NAME = "Guardian / architecture";

export interface RawCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  completed_at?: string | null;
  started_at?: string | null;
  head_sha?: string;
}

/**
 * Fold GitHub check runs into one result per name. Only `success` is PASS; neutral/skipped are NOT_RUN so
 * a skipped job can never satisfy a mandatory check.
 */
export function mapCheckRuns(runs: readonly RawCheckRun[], headSha: string, excludeName = GUARDIAN_CHECK_NAME): CheckResult[] {
  const latest = new Map<string, RawCheckRun>();
  for (const r of runs) {
    if (r.name === excludeName) continue;
    const prev = latest.get(r.name);
    if (!prev || (r.started_at ?? "") > (prev.started_at ?? "") || (r.started_at === prev.started_at && r.id > prev.id)) latest.set(r.name, r);
  }
  return [...latest.values()].map((r) => {
    let status: CheckResult["status"];
    if (r.status !== "completed") status = "PENDING";
    else if (r.conclusion === "success") status = "PASS";
    else if (r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled" || r.conclusion === "action_required" || r.conclusion === "startup_failure") status = "FAIL";
    else status = "NOT_RUN"; // neutral, skipped, stale
    return { name: r.name, status, detailsUrl: r.html_url ?? undefined, headSha: r.head_sha ?? headSha };
  });
}
