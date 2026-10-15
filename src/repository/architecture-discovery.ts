import YAML from "yaml";
import { buildDependencyGraph } from "./dependency-graph";
import { discoverRouteContracts } from "./contract-discovery";
import type { RepoSnapshot } from "./snapshot";

export interface BaselineDraft {
  files: Record<string, string>;
  report: string;
  uncertainties: string[];
}

function detectFramework(pkg: Record<string, any> | undefined): string {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const f of ["next", "nuxt", "@remix-run/react", "vite", "express", "fastify"]) if (deps[f]) return f === "@remix-run/react" ? "remix" : f === "next" ? "nextjs" : f;
  return "unknown";
}

function detectPackageManager(s: RepoSnapshot): string {
  if (s.files.has("pnpm-lock.yaml")) return "pnpm";
  if (s.files.has("yarn.lock")) return "yarn";
  return "npm";
}

/** Top-level module key for a source file: first directory under src/ (or app root). */
function moduleOf(path: string): string | undefined {
  const m = /^(?:src\/)?([^/]+)\//.exec(path);
  return m ? m[1] : undefined;
}

/**
 * Inspect the repository and draft the six `.guardian` files. Everything inferred is marked
 * `reviewed: false`; uncertain relationships are listed rather than invented (spec section 6).
 */
export function discoverBaseline(snapshot: RepoSnapshot): BaselineDraft {
  const uncertainties: string[] = [];
  let pkg: Record<string, any> | undefined;
  try {
    pkg = JSON.parse(snapshot.files.get("package.json") ?? "undefined");
  } catch {
    uncertainties.push("package.json is missing or not valid JSON; framework and scripts could not be detected.");
  }
  const graph = buildDependencyGraph(snapshot);
  const routes = [...discoverRouteContracts(snapshot).values()];

  const modules = new Map<string, { paths: Set<string>; deps: Set<string> }>();
  for (const path of graph.facts.keys()) {
    const m = moduleOf(path);
    if (!m || /\.(test|spec)\./.test(path)) continue;
    const prefix = path.startsWith("src/") ? `src/${m}/**` : `${m}/**`;
    if (!modules.has(m)) modules.set(m, { paths: new Set(), deps: new Set() });
    modules.get(m)!.paths.add(prefix);
  }
  for (const e of graph.edges) {
    const a = moduleOf(e.from);
    const b = moduleOf(e.to);
    if (a && b && a !== b && modules.has(a) && modules.has(b)) modules.get(a)!.deps.add(b);
  }
  for (const f of graph.uncertain) uncertainties.push(`Relationships in ${f} may be incomplete (syntax errors or unresolved relative imports).`);
  for (const r of routes) if (r.uncertain) uncertainties.push(`Response shape of ${r.url} (${r.file}) uses spreads or variables; field list may be incomplete.`);

  const envNames = new Set<string>();
  for (const f of graph.facts.values()) for (const e of f.envVars) if (!/^(NODE_ENV|VERCEL.*|CI|NEXT_RUNTIME)$/.test(e.name)) envNames.add(e.name);

  const architecture = {
    version: 1,
    framework: detectFramework(pkg),
    runtime: pkg?.engines?.node ? `node ${pkg.engines.node}` : "node",
    packageManager: detectPackageManager(snapshot),
    reviewed: false,
    layers: [],
    criticalWorkflows: [],
    protectedDecisions: [{ id: "guardian-policy", description: "Guardian policy files change only through reviewed PRs.", protectedPaths: [".guardian/**", ".github/workflows/**"] }],
  };
  const moduleMap = {
    version: 1,
    modules: [...modules.entries()].map(([name, v]) => ({ name, paths: [...v.paths], dependsOn: [...v.deps].sort(), publicInterface: [], shared: false, criticalConsumers: [] })),
  };
  const contracts = {
    version: 1,
    apiContracts: routes.map((r) => ({ id: r.url.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root", route: r.url, file: r.file, responseFields: r.responseFields, consumers: [] })),
    databaseExpectations: [],
    sharedSymbols: [],
    externalServices: [],
  };
  const policy = {
    version: 1,
    blockingSeverities: ["P0", "P1"],
    mediumRequiresReview: false,
    mandatoryChecks: ["lint", "typecheck", "unit-tests", "build"],
    nonWaivable: { categories: ["security", "auth"], ruleIds: [] },
    severityOverrides: {},
    confidence: { minForBlocking: 0.7, lowConfidenceCap: "P3" },
    approval: { architectureApprovers: [], securityApprovers: [], requiredApprovals: 1 },
    aiRequired: false,
  };
  const environment = {
    version: 1,
    variables: [...envNames].sort().map((name) => ({ name, scope: name.startsWith("NEXT_PUBLIC_") ? "browser" : "server", environments: ["development", "preview", "production"], description: "" })),
    mustMatchAcrossEnvironments: [],
  };
  const testMatrix = { version: 1, features: [] };

  const files: Record<string, string> = {
    ".guardian/architecture.yaml": YAML.stringify(architecture),
    ".guardian/module-map.yaml": YAML.stringify(moduleMap),
    ".guardian/protected-contracts.yaml": YAML.stringify(contracts),
    ".guardian/risk-policy.yaml": YAML.stringify(policy),
    ".guardian/environment-requirements.yaml": YAML.stringify(environment),
    ".guardian/test-matrix.yaml": YAML.stringify(testMatrix),
  };

  const report = [
    "# Guardian baseline discovery report",
    "",
    `- Framework: **${architecture.framework}** | Package manager: **${architecture.packageManager}**`,
    `- Source files analysed: ${graph.facts.size}; import edges: ${graph.edges.length}`,
    `- Modules discovered: ${moduleMap.modules.map((m) => m.name).join(", ") || "none"}`,
    `- API routes discovered: ${routes.length}`,
    `- Environment variables referenced in code: ${[...envNames].join(", ") || "none"}`,
    "",
    "## Needs human review before rules become mandatory",
    "",
    "The generated files are **drafts** (`reviewed: false`). Observed module dependencies were recorded as *allowed*; ",
    "tighten `dependsOn`, add `publicInterface`, `layers`, `criticalWorkflows` and the `test-matrix` before relying on them.",
    "",
    ...(uncertainties.length ? uncertainties.map((u) => `- ⚠ ${u}`) : ["- No parsing uncertainties detected."]),
    "",
  ].join("\n");

  return { files, report, uncertainties };
}
