import { describe, expect, it } from "vitest";
import { evaluateApprovals } from "@/policy/approval-policy";
import { checkConclusionFor, evaluatePolicy, type PolicyInput } from "@/policy/decisions";
import { classifySeverity } from "@/policy/severity";
import { makeFinding, type Finding } from "@/reporting/finding-schema";
import { riskPolicySchema } from "@/config/guardian-config";
import { mapCheckRuns } from "@/github/checks";
import { buildReport, safeInline } from "@/reporting/report-builder";

const policy = riskPolicySchema.parse({ version: 1, mandatoryChecks: ["lint", "build"], approval: { architectureApprovers: ["alice"], requiredApprovals: 1 } });
const SHA = "a".repeat(40);

const finding = (over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding =>
  makeFinding({ ruleId: "arch/module-boundary", category: "architecture-drift", severity: "P1", confidence: 0.9, kind: "confirmed", title: "t", description: "d", evidence: [], affectedFiles: ["a.ts"], affectedModules: [], potentialImpact: "", recommendedFix: "", requiredTests: [], ...over });

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  findings: [],
  checks: [{ name: "lint", status: "PASS", headSha: SHA }, { name: "build", status: "PASS", headSha: SHA }],
  policy,
  headSha: SHA,
  reviews: [],
  prAuthor: "dev",
  ai: "ok",
  ...over,
});

describe("decision matrix", () => {
  it("PASS with no findings and all mandatory checks passing", () => {
    expect(evaluatePolicy(input()).decision).toBe("PASS");
  });
  it("a missing mandatory check is PENDING, and BLOCKED once the grace period expired; never PASS", () => {
    expect(evaluatePolicy(input({ checks: [] })).decision).toBe("PENDING");
    expect(evaluatePolicy(input({ checks: [], pendingExpired: true })).decision).toBe("BLOCKED");
  });
  it("a NOT_RUN check or one recorded for another SHA does not count", () => {
    expect(evaluatePolicy(input({ checks: [{ name: "lint", status: "NOT_RUN" }, { name: "build", status: "PASS", headSha: SHA }] })).decision).toBe("PENDING");
    expect(evaluatePolicy(input({ checks: [{ name: "lint", status: "PASS", headSha: "b".repeat(40) }, { name: "build", status: "PASS", headSha: SHA }] })).decision).toBe("PENDING");
  });
  it("a failed mandatory check blocks", () => {
    const d = evaluatePolicy(input({ checks: [{ name: "lint", status: "FAIL", headSha: SHA }, { name: "build", status: "PASS", headSha: SHA }] }));
    expect(d.decision).toBe("BLOCKED");
    expect(d.failedChecks).toEqual(["lint"]);
  });
  it("STALE wins over everything when the head moved", () => {
    expect(evaluatePolicy(input({ currentHeadSha: "c".repeat(40), findings: [finding()] })).decision).toBe("STALE");
  });
  it("analysis errors yield ERROR (fail closed)", () => {
    expect(evaluatePolicy(input({ errors: ["boom"] })).decision).toBe("ERROR");
  });
  it("aiRequired + unavailable AI is ERROR; otherwise advisory", () => {
    const strict = { ...policy, aiRequired: true };
    expect(evaluatePolicy(input({ policy: strict, ai: "unavailable" })).decision).toBe("ERROR");
    expect(evaluatePolicy(input({ ai: "unavailable" })).decision).toBe("PASS");
  });
  it("P2 findings pass with warnings; mediumRequiresReview escalates to approval", () => {
    const f = finding({ ruleId: "dependency/major-bump", category: "dependency", severity: "P2", kind: "potential" });
    expect(evaluatePolicy(input({ findings: [f] })).decision).toBe("PASS_WITH_WARNINGS");
    expect(evaluatePolicy(input({ findings: [f], policy: { ...policy, mediumRequiresReview: true } })).decision).toBe("REQUIRES_APPROVAL");
  });
  it("P3 informational findings do not warn", () => {
    expect(evaluatePolicy(input({ findings: [finding({ ruleId: "security/unpinned-action", category: "security", severity: "P3", kind: "informational" })] })).decision).toBe("PASS");
  });
  it("P0 is never waivable, even with a valid approval", () => {
    const f = finding({ ruleId: "security/secret-exposure", category: "security", severity: "P0", approvalRequired: true });
    const d = evaluatePolicy(input({ findings: [f], reviews: [{ user: "alice", state: "APPROVED", commitId: SHA, submittedAt: "2026-01-01T00:00:00Z" }] }));
    expect(d.decision).toBe("BLOCKED");
  });
  it("the decision is deterministic", () => {
    const i = input({ findings: [finding({ kind: "intentional", approvalRequired: true })] });
    expect(JSON.stringify(evaluatePolicy(i))).toBe(JSON.stringify(evaluatePolicy(i)));
  });
  it("approval required but no approvers configured: cannot be approved", () => {
    const noApprovers = riskPolicySchema.parse({ version: 1, mandatoryChecks: [] });
    const d = evaluatePolicy(input({ policy: noApprovers, checks: [], findings: [finding({ kind: "intentional", approvalRequired: true })] }));
    expect(d.decision).toBe("REQUIRES_APPROVAL");
    expect(d.reasons.join(" ")).toMatch(/no `approval.architectureApprovers`/);
  });
});

describe("approval evaluation", () => {
  const base = { headSha: SHA, approvers: ["Alice"], required: 1, prAuthor: "dev" };
  const rev = (over = {}) => ({ user: "alice", state: "APPROVED" as const, commitId: SHA, submittedAt: "2026-01-01T00:00:00Z", ...over });
  it("counts a native approval from a designated approver (case-insensitive)", () => {
    expect(evaluateApprovals({ ...base, reviews: [rev()] }).satisfied).toBe(true);
  });
  it("a later changes-requested review revokes the earlier approval", () => {
    const r = evaluateApprovals({ ...base, reviews: [rev(), rev({ state: "CHANGES_REQUESTED", submittedAt: "2026-01-02T00:00:00Z" })] });
    expect(r.satisfied).toBe(false);
  });
  it("a later plain comment does not revoke it", () => {
    expect(evaluateApprovals({ ...base, reviews: [rev(), rev({ state: "COMMENTED", submittedAt: "2026-01-02T00:00:00Z" })] }).satisfied).toBe(true);
  });
  it("dismissed approvals do not count", () => {
    expect(evaluateApprovals({ ...base, reviews: [rev(), rev({ state: "DISMISSED", submittedAt: "2026-01-02T00:00:00Z" })] }).satisfied).toBe(false);
  });
  it("requires N distinct approvers", () => {
    const r = evaluateApprovals({ ...base, approvers: ["alice", "bob"], required: 2, reviews: [rev(), rev({ user: "bob" })] });
    expect(r.satisfied).toBe(true);
    expect(evaluateApprovals({ ...base, approvers: ["alice", "bob"], required: 2, reviews: [rev()] }).satisfied).toBe(false);
  });
});

describe("severity classification", () => {
  it("model findings cannot claim P0 or P1 without independent evidence", () => {
    const f = finding({ origin: "model", ruleId: "ai/security", category: "security", severity: "P0", kind: "confirmed", confidence: 0.99, evidence: [{ source: "model", file: "a.ts", detail: "x" }] });
    expect(classifySeverity(f, policy).severity).toBe("P2");
  });
  it("low-confidence model findings are capped, but sensitive categories become P2 review rather than disappearing", () => {
    const sec = finding({ origin: "model", ruleId: "ai/security", category: "security", severity: "P1", kind: "probable", confidence: 0.3, evidence: [{ source: "static", file: "a.ts", detail: "x" }] });
    expect(classifySeverity(sec, policy).severity).toBe("P2");
    const arch = finding({ origin: "model", ruleId: "ai/architecture-drift", category: "architecture-drift", severity: "P1", kind: "probable", confidence: 0.3, evidence: [{ source: "static", file: "a.ts", detail: "x" }] });
    expect(classifySeverity(arch, policy).severity).toBe("P3");
  });
  it("informational and potential kinds are clamped", () => {
    const info = finding({ origin: "model", ruleId: "ai/other", category: "other", severity: "P1", kind: "informational", confidence: 0.9, evidence: [{ source: "static", file: "a.ts", detail: "x" }] });
    expect(classifySeverity(info, policy).severity).toBe("P3");
  });
  it("policy overrides can raise severity but never lower P0 or non-waivable rules", () => {
    const p = { ...policy, severityOverrides: { "security/secret-exposure": "P3", "dependency/major-bump": "P1" } as const };
    expect(classifySeverity(finding({ ruleId: "security/secret-exposure", category: "security", severity: "P0" }), p).severity).toBe("P0");
    expect(classifySeverity(finding({ ruleId: "dependency/major-bump", category: "dependency", severity: "P2" }), p).severity).toBe("P1");
  });
});

describe("check conclusions", () => {
  it("only PASS/PASS_WITH_WARNINGS produce success", () => {
    expect(checkConclusionFor("PASS").conclusion).toBe("success");
    expect(checkConclusionFor("PASS_WITH_WARNINGS").conclusion).toBe("success");
    for (const d of ["BLOCKED", "ERROR"] as const) expect(checkConclusionFor(d).conclusion).toBe("failure");
    expect(checkConclusionFor("REQUIRES_APPROVAL").conclusion).toBe("action_required");
    expect(checkConclusionFor("STALE").conclusion).toBe("cancelled");
    expect(checkConclusionFor("PENDING")).toEqual({ status: "in_progress" });
  });
  it("GitHub check runs map conservatively: skipped/neutral are NOT success", () => {
    const runs = [
      { id: 1, name: "lint", status: "completed", conclusion: "success" },
      { id: 2, name: "build", status: "completed", conclusion: "skipped" },
      { id: 3, name: "unit-tests", status: "in_progress", conclusion: null },
      { id: 4, name: "typecheck", status: "completed", conclusion: "cancelled" },
      { id: 5, name: "Guardian / architecture", status: "completed", conclusion: "failure" },
    ];
    const m = Object.fromEntries(mapCheckRuns(runs, SHA).map((r) => [r.name, r.status]));
    expect(m).toEqual({ lint: "PASS", build: "NOT_RUN", "unit-tests": "PENDING", typecheck: "FAIL" });
  });
  it("the latest run per check name wins (re-runs)", () => {
    const m = mapCheckRuns([{ id: 1, name: "lint", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z" }, { id: 2, name: "lint", status: "completed", conclusion: "success", started_at: "2026-01-01T01:00:00Z" }], SHA);
    expect(m[0]?.status).toBe("PASS");
  });
});

describe("report builder", () => {
  const decision = evaluatePolicy(input({ findings: [finding({ title: "Title with <b>html</b> and @everyone", description: "see @octocat <img src=x onerror=1>" })] }));
  const meta = { runId: "r1", repo: "a/b", prNumber: 1, baseSha: "b".repeat(40), headSha: SHA, guardianVersion: "1", policyVersion: "p", startedAt: "2026-01-01T00:00:00Z", filesChanged: 3, affectedModules: ["ui"], aiStatus: "ok" as const };
  it("renders only real data, neutralising markup and mentions", () => {
    const md = buildReport({ meta, decision, checks: [{ name: "lint", status: "PASS", headSha: SHA }], mandatoryChecks: ["lint", "build"] });
    expect(md).toContain("**Decision:**");
    expect(md).toContain("- lint: PASS");
    expect(md).toContain("- build: NOT RUN"); // absent check is never rendered as pass
    expect(md).not.toMatch(/<b>|<img|@everyone|@octocat/);
  });
  it("redacts secrets that slipped into finding text", () => {
    const leaky = evaluatePolicy(input({ findings: [finding({ description: "key ghp_" + "Q1w2E3r4T5y6U7i8O9p0".repeat(2) })] }));
    expect(buildReport({ meta, decision: leaky, checks: [], mandatoryChecks: [] })).not.toMatch(/ghp_Q1w2/);
    expect(safeInline("AKIAABCDEFGHIJKLMNOP")).toBe("[REDACTED]");
  });
  it("stays under GitHub's comment size limit", () => {
    const many = Array.from({ length: 200 }, (_, i) => finding({ affectedFiles: [`f${i}.ts`], description: "x".repeat(900) }));
    const md = buildReport({ meta, decision: evaluatePolicy(input({ findings: many })), checks: [], mandatoryChecks: [] });
    expect(md.length).toBeLessThanOrEqual(65_000);
  });
});
