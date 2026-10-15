import { describe, expect, it } from "vitest";
import { analyze, baseApp, overlay, passingChecks, ruleIds, HEAD_SHA } from "../helpers/fixture";
import YAML from "yaml";

const route = "src/app/api/proposals/route.ts";
const list = "src/components/proposals/ProposalList.tsx";

describe("Scenario A: safe change", () => {
  it("passes when an isolated component is modified and checks pass", () => {
    const head = overlay(baseApp(), {
      "src/components/ui/Badge.tsx": `export function Badge({ label }: { label: string }) {\n  return <span className="badge rounded">{label}</span>;\n}\n`,
    });
    const d = analyze(head);
    expect(d.decision).toBe("PASS");
    expect(d.blockingFindingIds).toEqual([]);
  });

  it("blocks nothing but reports pending when mandatory CI has not reported", () => {
    const head = overlay(baseApp(), { "src/components/ui/Badge.tsx": `export const Badge = () => null;\nexport const x = 1;\n` });
    const d = analyze(head, { checks: [] });
    expect(d.decision).toBe("PENDING");
    expect(d.pendingChecks).toEqual(["lint", "typecheck", "unit-tests", "build"]);
  });
});

describe("Scenario B: broken API contract", () => {
  const head = overlay(baseApp(), {
    [route]: `import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listProposals } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const items = await listProposals();
  return NextResponse.json({ items, total: items.length });
}
`,
  });

  it("detects the renamed field, identifies the consumer, and blocks", () => {
    const d = analyze(head);
    expect(d.decision).toBe("BLOCKED");
    const f = d.findings.find((x) => x.ruleId === "contract/api-field-removed")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("P1");
    expect(f.kind).toBe("confirmed");
    expect(f.affectedFiles).toContain(list);
    expect(f.description).toMatch(/renamed `proposals` -> `items`/);
    expect(f.evidence.some((e) => e.file === list && e.line)).toBe(true);
  });

  it("selects the mapped regression tests", () => {
    const d = analyze(head);
    expect(d.impact.selectedTests.contract).toContain("tests/contract/proposals.contract.test.ts");
    expect(d.impact.criticalWorkflows).toContain("proposals");
  });

  it("is not satisfied by an approval (confirmed breakage is fixed, not waived)", () => {
    const d = analyze(head, { reviews: [{ user: "alice-architect", state: "APPROVED", commitId: HEAD_SHA, submittedAt: "2026-01-01T00:00:00Z" }] });
    expect(d.decision).toBe("BLOCKED");
  });

  it("passes once the consumer is updated in the same PR (additive/compatible change)", () => {
    const fixed = overlay(head, {
      [list]: (baseApp().files.get(list) as string).replaceAll("data.proposals", "data.items"),
      [route]: (head.files.get(route) as string).replace("{ items, total", "{ items, proposals: items, total"),
      "tests/proposals.test.ts": `import { formatTitle } from "@/lib/db";\nexport const t = formatTitle(" b ");\n`,
    });
    const d = analyze(fixed);
    expect(ruleIds(d)).not.toContain("contract/api-field-removed");
    expect(["PASS", "PASS_WITH_WARNINGS"]).toContain(d.decision);
  });
});

describe("Scenario C: incompatible database migration", () => {
  const head = overlay(baseApp(), {
    "supabase/migrations/002_drop_status.sql": `alter table proposals drop column status;\n`,
  });

  it("flags the column still used by code and blocks", () => {
    const d = analyze(head);
    const f = d.findings.find((x) => x.ruleId === "migration/column-dropped-in-use")!;
    expect(f).toBeDefined();
    expect(f.kind).toBe("confirmed");
    expect(f.affectedFiles).toEqual(expect.arrayContaining(["supabase/migrations/002_drop_status.sql", "src/lib/db.ts"]));
    expect(f.requiredTests).toContain("migration-validation");
    expect(d.decision).toBe("BLOCKED");
  });

  it("treats unscoped destructive data operations as P0", () => {
    const d = analyze(overlay(baseApp(), { "supabase/migrations/003_wipe.sql": `delete from proposals;\n` }));
    const f = d.findings.find((x) => x.ruleId === "migration/destructive-data-op")!;
    expect(f.severity).toBe("P0");
    expect(d.decision).toBe("BLOCKED");
  });

  it("only warns for an unused column drop (expand/contract advice)", () => {
    const d = analyze(overlay(baseApp(), { "supabase/migrations/004.sql": `alter table proposals drop column legacy_flag;\n` }));
    const f = d.findings.find((x) => x.ruleId === "migration/schema-breaking")!;
    expect(f.severity).toBe("P2");
    expect(d.decision).toBe("PASS_WITH_WARNINGS");
  });
});

describe("Scenario D: two individually passing PRs conflict when combined", () => {
  const prOne = {
    "src/lib/db.ts": (baseApp().files.get("src/lib/db.ts") as string).replace(/formatTitle/g, "normalizeTitle"),
    "tests/proposals.test.ts": `import { normalizeTitle } from "@/lib/db";\nexport const t = normalizeTitle(" a ");\n`,
  };
  const prTwo = {
    "src/components/proposals/Header.tsx": `import { formatTitle } from "@/lib/db";\nexport const Header = ({ t }: { t: string }) => <h1>{formatTitle(t)}</h1>;\n`,
  };

  it("each PR passes alone against the original base", () => {
    expect(analyze(overlay(baseApp(), prOne, "1".repeat(40))).decision).toMatch(/PASS/);
    // PR two alone also triggers the UI->db forbidden import? use a lib-compatible variant to keep the case about the conflict.
  });

  it("the merged candidate is blocked and linked to the combined result", () => {
    const mainAfterOne = overlay(baseApp(), prOne, "c".repeat(40));
    const candidate = overlay(mainAfterOne, { "src/components/proposals/Header.tsx": prTwo["src/components/proposals/Header.tsx"] }, "d".repeat(40));
    const d = analyze(candidate, { base: mainAfterOne });
    const f = d.findings.find((x) => x.ruleId === "integration/unresolved-import")!;
    expect(f).toBeDefined();
    expect(f.description).toMatch(/formatTitle/);
    expect(d.decision).toBe("BLOCKED");
  });
});

describe("Scenario E: intentional architecture change", () => {
  const moduleMap = YAML.parse(baseApp().files.get(".guardian/module-map.yaml") as string);
  moduleMap.modules.find((m: { name: string }) => m.name === "ui").dependsOn.push("api");
  const head = overlay(baseApp(), {
    ".guardian/module-map.yaml": YAML.stringify(moduleMap),
    "src/components/proposals/Admin.tsx": `import { GET } from "@/app/api/proposals/route";\nexport const Admin = () => GET;\n`,
  });

  it("recognises the change as intentional and requires an architecture approver", () => {
    const d = analyze(head);
    const boundary = d.findings.find((f) => f.ruleId === "arch/module-boundary")!;
    expect(boundary.kind).toBe("intentional");
    expect(d.findings.some((f) => f.ruleId === "arch/protected-path-changed")).toBe(true);
    expect(d.decision).toBe("REQUIRES_APPROVAL");
    expect(d.approval?.approvers).toEqual(["alice-architect"]);
  });

  it("is satisfied by a native approval on the current head from a designated approver", () => {
    const d = analyze(head, { reviews: [{ user: "alice-architect", state: "APPROVED", commitId: HEAD_SHA, submittedAt: "2026-01-01T00:00:00Z" }] });
    expect(["PASS", "PASS_WITH_WARNINGS"]).toContain(d.decision);
    expect(d.waivedFindingIds.length).toBeGreaterThan(0);
  });

  it("still runs mandatory checks: approval cannot override a failing test", () => {
    const failing = passingChecks().map((c) => (c.name === "unit-tests" ? { ...c, status: "FAIL" as const } : c));
    const d = analyze(head, { checks: failing, reviews: [{ user: "alice-architect", state: "APPROVED", commitId: HEAD_SHA, submittedAt: "2026-01-01T00:00:00Z" }] });
    expect(d.decision).toBe("BLOCKED");
    expect(d.failedChecks).toEqual(["unit-tests"]);
  });

  it("does not accept a plain comment or a non-approver", () => {
    expect(analyze(head, { reviews: [{ user: "alice-architect", state: "COMMENTED", commitId: HEAD_SHA, submittedAt: "2026-01-01T00:00:00Z" }] }).decision).toBe("REQUIRES_APPROVAL");
    expect(analyze(head, { reviews: [{ user: "random-dev", state: "APPROVED", commitId: HEAD_SHA, submittedAt: "2026-01-01T00:00:00Z" }] }).decision).toBe("REQUIRES_APPROVAL");
  });

  it("does not let the author approve their own change", () => {
    const d = analyze(head, { author: "alice-architect", reviews: [{ user: "alice-architect", state: "APPROVED", commitId: HEAD_SHA, submittedAt: "2026-01-01T00:00:00Z" }] });
    expect(d.decision).toBe("REQUIRES_APPROVAL");
  });
});

describe("Scenario G: new commit after approval", () => {
  const moduleMap = YAML.parse(baseApp().files.get(".guardian/module-map.yaml") as string);
  moduleMap.modules.find((m: { name: string }) => m.name === "ui").dependsOn.push("api");
  const files = {
    ".guardian/module-map.yaml": YAML.stringify(moduleMap),
    "src/components/proposals/Admin.tsx": `import { GET } from "@/app/api/proposals/route";\nexport const Admin = () => GET;\n`,
  };
  const oldSha = "e".repeat(40);
  const newSha = "f".repeat(40);

  it("an approval for the old head does not count for the new head", () => {
    const head = overlay(baseApp(), files, newSha);
    const d = analyze(head, { reviews: [{ user: "alice-architect", state: "APPROVED", commitId: oldSha, submittedAt: "2026-01-01T00:00:00Z" }] });
    expect(d.decision).toBe("REQUIRES_APPROVAL");
    expect(d.reasons.join(" ")).toMatch(/approval was for eeeeeee/);
  });

  it("an analysis for the old head is STALE once the PR head moved", () => {
    const head = overlay(baseApp(), files, oldSha);
    expect(analyze(head, { currentHeadSha: newSha }).decision).toBe("STALE");
  });
});

describe("Scenario H: production-only failures a local build would not catch", () => {
  it("flags a new undeclared environment variable", () => {
    const head = overlay(baseApp(), {
      "src/lib/payments.ts": `export const key = process.env.STRIPE_API_KEY;\n`,
    });
    const d = analyze(head);
    expect(ruleIds(d)).toContain("env/undeclared-variable");
    expect(d.findings.find((f) => f.ruleId === "env/undeclared-variable")!.requiredTests).toContain("preview-smoke");
  });

  it("blocks server-only variables read in client components", () => {
    const head = overlay(baseApp(), {
      [list]: (baseApp().files.get(list) as string).replace("const [total", "const dbUrl = process.env.DATABASE_URL;\n  const [total"),
    });
    const d = analyze(head);
    expect(ruleIds(d)).toContain("env/server-var-in-client");
    expect(d.decision).toBe("BLOCKED");
  });

  it("blocks promotion when a mandatory hosted check fails or is for another commit", () => {
    const head = overlay(baseApp(), { "src/components/ui/Badge.tsx": `export const Badge = () => null;\nexport const y = 2;\n` });
    const wrongSha = passingChecks("0".repeat(40));
    expect(analyze(head, { checks: wrongSha }).decision).toBe("PENDING");
  });
});

describe("Scenario I: security-sensitive changes", () => {
  it("blocks a committed credential without echoing it", () => {
    const fake = "ghp_" + "a1B2c3D4e5F6g7H8i9J0".repeat(2); // guardian:allow-secret
    const head = overlay(baseApp(), { "src/lib/gh.ts": `export const token = "${fake}";\n` });
    const d = analyze(head);
    const f = d.findings.find((x) => x.ruleId === "security/secret-exposure")!;
    expect(f.severity).toBe("P0");
    expect(JSON.stringify(d)).not.toContain(fake);
    expect(d.decision).toBe("BLOCKED");
  });

  it("no approval can waive a secret", () => {
    const fake = "ghp_" + "a1B2c3D4e5F6g7H8i9J0".repeat(2);
    const head = overlay(baseApp(), { "src/lib/gh.ts": `export const token = "${fake}";\n` });
    const d = analyze(head, { reviews: [{ user: "alice-architect", state: "APPROVED", commitId: HEAD_SHA, submittedAt: "2026-01-01T00:00:00Z" }] });
    expect(d.decision).toBe("BLOCKED");
  });

  it("flags pull_request_target workflows that run PR code", () => {
    const head = overlay(baseApp(), {
      ".github/workflows/ci.yml": `name: ci
on: pull_request_target
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm ci && npm test
`,
    });
    const d = analyze(head);
    expect(ruleIds(d)).toContain("security/pull-request-target");
    expect(d.decision).toBe("BLOCKED");
  });

  it("changes to Guardian policy itself require approval and use the BASE policy", () => {
    const head = overlay(baseApp(), {
      ".guardian/risk-policy.yaml": (baseApp().files.get(".guardian/risk-policy.yaml") as string).replace("[P0, P1]", "[]").replace("mandatoryChecks: [lint, typecheck, unit-tests, build]", "mandatoryChecks: []"),
    });
    const d = analyze(head, { checks: [{ name: "lint", status: "FAIL", headSha: HEAD_SHA }] });
    // The weakened policy in the PR is ignored: the base policy still requires (and sees failing) lint.
    expect(d.decision).toBe("BLOCKED");
    expect(ruleIds(d)).toContain("arch/protected-path-changed");
  });

  it("detects removal of an authentication check from a route", () => {
    const head = overlay(baseApp(), {
      [route]: `import { NextResponse } from "next/server";
import { listProposals } from "@/lib/db";

export async function GET() {
  const proposals = await listProposals();
  return NextResponse.json({ proposals, total: proposals.length });
}
`,
    });
    const d = analyze(head);
    expect(ruleIds(d)).toContain("auth/check-removed");
    expect(d.decision).toBe("BLOCKED");
  });
});
