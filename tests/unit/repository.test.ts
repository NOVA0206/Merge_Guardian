import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { discoverBaseline } from "@/repository/architecture-discovery";
import { extractRouteContract } from "@/repository/contract-discovery";
import { buildDependencyGraph, effectiveExports } from "@/repository/dependency-graph";
import { computeChangeSet } from "@/repository/diff-parser";
import { classifyFile, routeUrlForFile } from "@/repository/file-classifier";
import { isAnalyzablePath, snapshotFromMap, snapshotFromZip } from "@/repository/snapshot";
import { parseMigrationSql } from "@/analysis/contract-analysis";
import { parseGuardianConfig } from "@/config/guardian-config";
import { baseApp } from "../helpers/fixture";

const snap = (files: Record<string, string>, sha = "1".repeat(40)) => snapshotFromMap(sha, files);

describe("file classification", () => {
  it.each([
    ["src/app/api/x/route.ts", ["source", "api-route"]],
    ["tests/a.test.ts", ["test"]],
    ["supabase/migrations/001.sql", ["migration"]],
    [".github/workflows/ci.yml", ["workflow"]],
    [".guardian/risk-policy.yaml", ["guardian-policy"]],
    ["package.json", ["dependency-manifest"]],
    ["package-lock.json", ["lockfile"]],
    [".github/CODEOWNERS", ["codeowners"]],
  ])("%s", (path, expected) => {
    expect(classifyFile(path)).toEqual(expect.arrayContaining(expected as never[]));
  });
  it("maps Next.js route files to URLs", () => {
    expect(routeUrlForFile("src/app/api/items/[id]/route.ts")).toBe("/api/items/[id]");
    expect(routeUrlForFile("app/(group)/api/x/route.ts")).toBe("/api/x");
    expect(routeUrlForFile("pages/api/users/index.ts")).toBe("/api/users");
    expect(routeUrlForFile("src/lib/a.ts")).toBeUndefined();
  });
});

describe("dependency graph (TypeScript compiler API)", () => {
  const files = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    "src/a.ts": `import { b } from "@/b";\nimport def, * as ns from "./c";\nexport const a = b;\nexport default def;\nconst lazy = () => import("./d");\nconst r = require("./e");\nexport * from "./f";\nexport { g as renamed } from "./g";\nimport x from "lodash/fp";\nimport { readFile } from "node:fs";\nconst k = process.env.API_KEY + process.env["OTHER"];\nfetch("/api/things?x=1");\nfetch(\`/api/items/\${id}\`);`,
    "src/b.ts": "export const b = 1;",
    "src/c.ts": "export default 2; export const z = 1;",
    "src/d.tsx": "export const d = 1;",
    "src/e.js": "module.exports = 1;",
    "src/f.ts": "export const fromF = 1;",
    "src/g.ts": "export const g = 1;",
    "src/client.tsx": `"use client";\nexport const C = () => process.env.NEXT_PUBLIC_X;`,
  };
  const g = buildDependencyGraph(snap(files));
  it("resolves aliases, relative, dynamic, require and re-exports", () => {
    const imports = g.facts.get("src/a.ts")!.imports;
    expect(imports.find((i) => i.specifier === "@/b")?.resolved).toBe("src/b.ts");
    expect(imports.find((i) => i.specifier === "./c")?.names.sort()).toEqual(["*", "default"]);
    expect(imports.find((i) => i.specifier === "./d")?.kind).toBe("dynamic");
    expect(imports.find((i) => i.specifier === "./e")?.kind).toBe("require");
    expect(imports.find((i) => i.specifier === "lodash/fp")?.external).toBe("lodash");
    expect(imports.find((i) => i.specifier === "node:fs")?.external).toBe("node:fs");
  });
  it("collects exports including star and renamed re-exports", () => {
    expect([...effectiveExports(g, "src/a.ts")].sort()).toEqual(["a", "default", "fromF", "renamed"]);
  });
  it("finds env vars (dot, bracket), api calls (literal vs template), and client components", () => {
    const f = g.facts.get("src/a.ts")!;
    expect(f.envVars.map((e) => e.name).sort()).toEqual(["API_KEY", "OTHER"]);
    expect(f.apiCalls).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/api/things", confidence: "high" }), expect.objectContaining({ path: "/api/items/", confidence: "medium" })]));
    expect(g.facts.get("src/client.tsx")!.isClientComponent).toBe(true);
  });
  it("computes direct and transitive dependents with shortest paths", () => {
    const chain = buildDependencyGraph(snap({ "a.ts": `import "./b";`, "b.ts": `import "./c"; export {}`, "c.ts": "export const c = 1;", "d.ts": `import "./c";` }));
    expect(chain.directDependents("c.ts").map((e) => e.from).sort()).toEqual(["b.ts", "d.ts"]);
    expect(chain.transitiveDependents(["c.ts"]).get("a.ts")).toEqual(["c.ts", "b.ts", "a.ts"]);
  });
  it("records uncertainty instead of inventing edges", () => {
    const u = buildDependencyGraph(snap({ "a.ts": `import "./missing";\nexport const = ;` }));
    expect(u.uncertain).toContain("a.ts");
    expect(u.edges).toHaveLength(0);
  });
  it("handles circular imports without looping", () => {
    const c = buildDependencyGraph(snap({ "a.ts": `import "./b"; export const a=1;`, "b.ts": `import "./a"; export const b=1;` }));
    expect(c.transitiveDependents(["a.ts"]).size).toBe(1);
  });
});

describe("route contract discovery", () => {
  it("extracts methods and top-level JSON fields; flags spreads as uncertain", () => {
    const c = extractRouteContract("src/app/api/x/route.ts", `export async function GET(){ return NextResponse.json({ a: 1, b, "c-d": 2 }); }\nexport const POST = async () => Response.json({ ok: true, ...rest });`)!;
    expect(c.url).toBe("/api/x");
    expect(c.methods).toEqual(["GET", "POST"]);
    expect(c.responseFields).toEqual(["a", "b", "c-d", "ok"]);
    expect(c.uncertain).toBe(true);
  });
});

describe("change sets", () => {
  it("detects added, modified, deleted and renamed files and the actual added lines", () => {
    const base = snap({ "keep.ts": "a\nb", "old.ts": "same content", "gone.ts": "x", "mod.ts": "l1\nl2\nl3" });
    const head = snap({ "keep.ts": "a\nb", "new.ts": "same content", "added.ts": "n1\nn2", "mod.ts": "l1\nCHANGED\nl3" }, "2".repeat(40));
    const cs = computeChangeSet(base, head);
    const by = Object.fromEntries(cs.files.map((f) => [f.path, f]));
    expect(by["new.ts"]).toMatchObject({ status: "renamed", previousPath: "old.ts" });
    expect(by["added.ts"]?.status).toBe("added");
    expect(by["gone.ts"]?.status).toBe("deleted");
    expect(by["mod.ts"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(by["mod.ts"]!.addedLines).toEqual([{ line: 2, text: "CHANGED" }]);
    expect(by["keep.ts"]).toBeUndefined();
  });
});

describe("snapshots", () => {
  it("reads a GitHub-style zipball, strips the prefix and skips junk and oversized files", () => {
    const zip = zipSync({
      "owner-repo-abc/src/a.ts": strToU8("export const a = 1;"),
      "owner-repo-abc/node_modules/x/index.js": strToU8("bad"),
      "owner-repo-abc/image.png": strToU8("binary"),
      "owner-repo-abc/.env": strToU8("A=1"),
    });
    const s = snapshotFromZip("3".repeat(40), zip);
    expect([...s.files.keys()].sort()).toEqual([".env", "src/a.ts"]);
  });
  it("rejects archives over the memory limit", () => {
    expect(() => snapshotFromZip("3".repeat(40), new Uint8Array(2048), 1024)).toThrow(/limit/);
  });
  it("analyzable path rules", () => {
    expect(isAnalyzablePath("src/x.ts")).toBe(true);
    expect(isAnalyzablePath("node_modules/a/b.ts")).toBe(false);
    expect(isAnalyzablePath("logo.png")).toBe(false);
  });
});

describe("migration SQL parsing", () => {
  it("recognises destructive and breaking statements, ignoring comments", () => {
    const ops = parseMigrationSql(`-- drop table old;\nALTER TABLE "public"."t" DROP COLUMN IF EXISTS "c";\nalter table t rename column a to b;\nALTER TABLE t ALTER COLUMN x SET NOT NULL;\nTRUNCATE TABLE logs;\nDELETE FROM sessions;\nDELETE FROM sessions WHERE id = 1;\nDROP TABLE IF EXISTS old_things;`);
    const kinds = ops.map((o) => o.kind).sort();
    expect(kinds).toEqual(["drop-column", "drop-table", "rename-column", "set-not-null", "truncate", "unscoped-delete"]);
    expect(ops.find((o) => o.kind === "drop-column")).toMatchObject({ table: "public.t", column: "c" });
  });
});

describe("guardian config", () => {
  it("parses the fixture configuration and hashes it into a policy version", () => {
    const c = parseGuardianConfig((p) => baseApp().files.get(p));
    expect(c.moduleMap.modules.map((m) => m.name)).toEqual(["ui", "api", "lib"]);
    expect(c.version).toMatch(/^[0-9a-f]{8}$/);
  });
  it("rejects invalid or missing files with a precise message", () => {
    expect(() => parseGuardianConfig(() => undefined)).toThrow(/Missing Guardian config file/);
    expect(() => parseGuardianConfig((p) => (p.endsWith("risk-policy.yaml") ? "version: 1\nblockingSeverities: [P9]" : baseApp().files.get(p)))).toThrow(/risk-policy.yaml/);
  });
});

describe("baseline discovery", () => {
  it("drafts valid, unreviewed configuration and records uncertainty", () => {
    const draft = discoverBaseline(
      snap({
        "package.json": JSON.stringify({ dependencies: { next: "15" }, engines: { node: ">=20" } }),
        "package-lock.json": "{}",
        "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
        "src/lib/db.ts": "export const q = process.env.DATABASE_URL;",
        "src/components/A.tsx": `import { q } from "@/lib/db";\nexport const A = () => q;`,
        "src/app/api/x/route.ts": `export async function GET(){ return Response.json({ ...x }); }`,
      }),
    );
    const parsed = parseGuardianConfig((p) => draft.files[p]);
    expect(parsed.architecture.reviewed).toBe(false);
    expect(parsed.architecture.framework).toBe("nextjs");
    expect(parsed.moduleMap.modules.find((m) => m.name === "components")?.dependsOn).toEqual(["lib"]);
    expect(parsed.environment.variables.map((v) => v.name)).toContain("DATABASE_URL");
    expect(draft.uncertainties.join(" ")).toMatch(/\/api\/x/);
    expect(draft.report).toMatch(/reviewed: false/);
  });
});
