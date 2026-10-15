import { describe, expect, it } from "vitest";
import { buildContext } from "@/analysis/context";
import { runStaticAnalysis } from "@/analysis/static-analysis";
import { OctokitGateway } from "@/github/octokit-gateway";
import { classifySeverity } from "@/policy/severity";
import { createRepairHook } from "@/repair/repair-controller";
import { validatePatch } from "@/repair/patch-validator";
import { verifyRepairScope } from "@/repair/test-runner";
import { MemoryStore } from "@/storage/memory";
import { baseApp, overlay, HEAD_SHA } from "../helpers/fixture";
import { FakeGitHub, makePr } from "../helpers/fake-github";

const route = "src/app/api/proposals/route.ts";
const list = "src/components/proposals/ProposalList.tsx";
const broken = () => overlay(baseApp(), { [route]: (baseApp().files.get(route) as string).replace("{ proposals, total", "{ items: proposals, total") });

function scenario(opts: { permission?: "write" | "read"; pr?: Partial<ReturnType<typeof makePr>> } = {}) {
  const head = broken();
  const ctx = buildContext(baseApp(), head);
  const findings = runStaticAnalysis(ctx).findings.map((f) => classifySeverity(f, ctx.config.policy));
  const finding = findings.find((f) => f.ruleId === "contract/api-field-removed")!;
  const github = new FakeGitHub({ pr: makePr(HEAD_SHA, opts.pr), base: baseApp(), head, reviews: [], checks: [], permissions: { "dev-one": opts.permission ?? "write" } });
  const store = new MemoryStore();
  const hook = createRepairHook({ store, gatewayFor: () => github });
  const request = async (over: Partial<Parameters<typeof hook>[0]> = {}) => {
    await store.createRepairSession({ repoFullName: "acme/app", prNumber: 7, findingId: finding.id, sourceHeadSha: HEAD_SHA, branch: "guardian/fix-PR-7", status: "requested", requestedBy: "dev-one" });
    return hook({ repoFullName: "acme/app", prNumber: 7, installationId: 99, findingId: finding.id, sourceHeadSha: HEAD_SHA, requestedBy: "dev-one", ctx, findings, ...over });
  };
  return { ctx, finding, github, store, request };
}

describe("Scenario F: repair agent", () => {
  it("the finding is marked repairable with machine-readable rename data", () => {
    const { finding } = scenario();
    expect(finding.repairable).toBe(true);
    expect(finding.data).toMatchObject({ kind: "field-rename", from: "proposals", to: "items" });
  });

  it("proposes a minimal patch on a guardian/ branch via a DRAFT PR; never touches the feature branch or main", async () => {
    const s = scenario();
    const res = await s.request();
    expect(res.status).toBe("proposed");
    expect(s.github.branches).toEqual([{ branch: "guardian/fix-PR-7", sha: HEAD_SHA }]);
    expect(s.github.commits).toHaveLength(1);
    expect(s.github.commits[0]!.files.map((f) => f.path)).toEqual([route]);
    expect(s.github.commits[0]!.files[0]!.content).toContain("items: proposals, proposals");
    expect(s.github.pullRequests[0]).toMatchObject({ head: "guardian/fix-PR-7", base: "feature/dev-one-rename", draft: true });
    expect(s.github.pullRequests.every((p) => p.base !== "main")).toBe(true);
    const sessions = await s.store.listRepairSessions({ repoFullName: "acme/app" });
    expect(sessions[0]).toMatchObject({ status: "proposed", repairPrNumber: 901 });
    expect((await s.store.listAudit({ repoFullName: "acme/app" })).some((a) => a.action === "repair.proposed")).toBe(true);
  });

  it("patch validation re-runs the analyzers: restoring the protected field clears the finding", () => {
    const s = scenario();
    const patched = (s.ctx.head.files.get(route) as string).replace("{ items: proposals, total", "{ items: proposals, proposals, total");
    const v = validatePatch({ findingId: s.finding.id, summary: "x", files: [{ path: route, content: patched }], tests: [] }, s.ctx, s.finding);
    expect(v.ok).toBe(true);
    expect(v.residual.some((r) => r.ruleId === "contract/api-field-removed")).toBe(false);
  });

  it("validation is not fooled: renaming only the consumer leaves the protected contract broken", () => {
    const s = scenario();
    const patched = (s.ctx.head.files.get(list) as string).replaceAll("data.proposals", "data.items");
    const v = validatePatch({ findingId: s.finding.id, summary: "x", files: [{ path: list, content: patched }], tests: [] }, s.ctx, s.finding);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/new P1 finding: contract\/api-field-removed/);
  });

  it("rejects a patch that does not actually fix the finding (honest failure)", () => {
    const s = scenario();
    const v = validatePatch({ findingId: s.finding.id, summary: "noop", files: [{ path: list, content: (s.ctx.head.files.get(list) as string) + "\n// touched\n" }], tests: [] }, s.ctx, s.finding);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/still reported/);
  });

  it.each([
    [".github/workflows/ci.yml", "name: x\n"],
    [".guardian/risk-policy.yaml", "version: 1\n"],
    [".env.local", "A=1\n"],
    ["src/policy/decisions.ts", "export {}\n"],
  ])("rejects patches that modify protected path %s", (path, content) => {
    const s = scenario();
    const v = validatePatch({ findingId: s.finding.id, summary: "x", files: [{ path, content }], tests: [] }, s.ctx, s.finding);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/protected path|not implicated/);
  });

  it("rejects weakening existing tests, deleting files, unrelated files and syntax errors", () => {
    const s = scenario();
    const mk = (files: Array<{ path: string; content: string | null }>) => validatePatch({ findingId: s.finding.id, summary: "x", files, tests: [] }, s.ctx, s.finding);
    expect(mk([{ path: "tests/proposals.test.ts", content: "// gutted\n" }]).reasons.join()).toMatch(/never modify existing/);
    expect(mk([{ path: list, content: null }]).reasons.join()).toMatch(/may not delete/);
    expect(mk([{ path: "src/lib/session.ts", content: "export const x = 1;\n" }]).reasons.join()).toMatch(/unrelated/);
    expect(mk([{ path: list, content: "export const = ;" }]).reasons.join()).toMatch(/Syntax error/);
  });

  it("denies a requester without write access: no branch, no commit, no PR", async () => {
    const s = scenario({ permission: "read" });
    const res = await s.request();
    expect(res.status).toBe("failed");
    expect(res.detail).toMatch(/Not authorized/);
    expect(s.github.branches).toHaveLength(0);
    expect(s.github.commits).toHaveLength(0);
    expect(s.github.pullRequests).toHaveLength(0);
    expect((await s.store.listAudit({ repoFullName: "acme/app" })).some((a) => a.action === "repair.denied")).toBe(true);
  });

  it("refuses fork PRs and moved heads", async () => {
    const fork = scenario({ pr: { isFork: true } });
    expect((await fork.request()).status).toBe("failed");
    expect(fork.github.branches).toHaveLength(0);

    const moved = scenario({ pr: { headSha: "9".repeat(40) } });
    expect((await moved.request()).detail).toMatch(/moved/);
    expect(moved.github.branches).toHaveLength(0);
  });

  it("refuses to target protected branches", async () => {
    const s = scenario({ pr: { headRef: "main" } });
    expect((await s.request()).detail).toMatch(/protected branch/);
    expect(s.github.pullRequests).toHaveLength(0);
  });

  it("the real GitHub gateway itself refuses to create/write non-guardian branches", async () => {
    const gw = new OctokitGateway({} as never);
    await expect(gw.createBranchFromSha("acme/app", "main", HEAD_SHA)).rejects.toThrow(/guardian\//);
    await expect(gw.createBranchFromSha("acme/app", "feature/x", HEAD_SHA)).rejects.toThrow(/guardian\//);
    await expect(gw.commitFiles("acme/app", "main", "m", [])).rejects.toThrow(/guardian\//);
  });

  it("CI-side scope verification flags forbidden paths", () => {
    expect(verifyRepairScope(["src/a.ts"]).ok).toBe(true);
    expect(verifyRepairScope(["src/a.ts", ".github/workflows/x.yml"]).violations[0]).toMatch(/forbidden/);
  });
});
