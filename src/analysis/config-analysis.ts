import { builtinModules } from "node:module";
import type { Finding } from "@/reporting/finding-schema";
import { diffEvidence, modulesOf, ruleFinding, type AnalysisContext } from "./context";

const IGNORED_ENV = /^(NODE_ENV|CI|VERCEL(_.*)?|NEXT_RUNTIME|NEXT_PHASE|PORT|TZ|NEXT_PUBLIC_VERCEL_.*)$/;
const SECRETISH = /(SECRET|PRIVATE|PASSWORD|TOKEN|SERVICE_ROLE|API_KEY|SIGNING)/i;

/** Environment variable declarations vs usage, and server/browser exposure. */
export function analyzeEnvironment(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const declared = new Map(ctx.config.environment.variables.map((v) => [v.name, v]));

  for (const cf of ctx.changes.files) {
    if (cf.status === "deleted") continue;
    const facts = ctx.headGraph.facts.get(cf.path);
    if (!facts || facts.envVars.length === 0) continue;
    const baseNames = new Set(ctx.baseGraph.facts.get(cf.previousPath ?? cf.path)?.envVars.map((e) => e.name));
    const seen = new Set<string>();
    for (const ev of facts.envVars) {
      if (IGNORED_ENV.test(ev.name) || seen.has(ev.name)) continue;
      seen.add(ev.name);
      const decl = declared.get(ev.name);

      if (ev.name.startsWith("NEXT_PUBLIC_") && SECRETISH.test(ev.name)) {
        findings.push(
          ruleFinding(
            "env/public-secret-name",
            {
              confidence: 0.85,
              kind: "probable",
              description: `\`${ev.name}\` is browser-exposed (NEXT_PUBLIC_) but its name suggests a secret.`,
              evidence: [diffEvidence(cf.path, `Reads ${ev.name}.`, ev.line)],
              affectedFiles: [cf.path],
              affectedModules: modulesOf([cf.path], ctx.config),
              potentialImpact: "Anything prefixed NEXT_PUBLIC_ is inlined into client JavaScript and readable by every visitor.",
              recommendedFix: "Move the value to a server-only variable and access it through a server route.",
              requiredTests: [],
            },
            ev.name,
          ),
        );
      }
      if (!baseNames.has(ev.name) && !decl) {
        findings.push(
          ruleFinding(
            "env/undeclared-variable",
            {
              confidence: 0.9,
              kind: "probable",
              description: `\`${ev.name}\` is newly used in ${cf.path} but is not declared in environment-requirements.yaml.`,
              evidence: [diffEvidence(cf.path, `Reads ${ev.name}.`, ev.line)],
              affectedFiles: [cf.path],
              affectedModules: modulesOf([cf.path], ctx.config),
              potentialImpact: "The variable is unlikely to be configured in Vercel Preview/Production, producing a deploy-only failure.",
              recommendedFix: "Declare it in environment-requirements.yaml and add it to every required Vercel environment before merging.",
              requiredTests: ["preview-smoke"],
            },
            ev.name,
          ),
        );
      }
      if (facts.isClientComponent && decl?.scope === "server") {
        findings.push(
          ruleFinding(
            "env/server-var-in-client",
            {
              confidence: 0.95,
              kind: "confirmed",
              description: `Server-only variable \`${ev.name}\` is read in client component ${cf.path}; it will be undefined in the browser.`,
              evidence: [diffEvidence(cf.path, `'use client' file reads server-only ${ev.name}.`, ev.line)],
              affectedFiles: [cf.path],
              affectedModules: modulesOf([cf.path], ctx.config),
              potentialImpact: "Works in local server rendering but fails in the deployed browser bundle.",
              recommendedFix: "Read the variable in a server component or route handler and pass the result down.",
              requiredTests: ["preview-smoke"],
            },
            `${cf.path}:${ev.name}`,
          ),
        );
      }
    }
  }
  return findings;
}

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function pkgJson(text: string | undefined): { deps: Record<string, string> } | undefined {
  if (!text) return undefined;
  try {
    const p = JSON.parse(text);
    return { deps: { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}), ...(p.peerDependencies ?? {}), ...(p.optionalDependencies ?? {}) } };
  } catch {
    return undefined;
  }
}

const major = (range: string) => /(\d+)\./.exec(range.replace(/^[^\d]*/, "") + ".")?.[1];

export function analyzeDependencies(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const baseP = pkgJson(ctx.base.files.get("package.json"));
  const headP = pkgJson(ctx.head.files.get("package.json"));
  const manifestChanged = ctx.changes.files.some((f) => f.path === "package.json");
  const lockChanged = ctx.changes.files.some((f) => f.kinds.includes("lockfile"));

  if (manifestChanged && !lockChanged) {
    findings.push(
      ruleFinding(
        "dependency/lockfile-not-updated",
        {
          confidence: 0.8,
          kind: "probable",
          description: "package.json changed but no lockfile changed; CI installs with the lockfile and will not see new versions.",
          evidence: [diffEvidence("package.json", "Manifest modified without lockfile.")],
          affectedFiles: ["package.json"],
          affectedModules: [],
          potentialImpact: "Local and deployed dependency trees diverge; `npm ci` can fail outright.",
          recommendedFix: "Run the package manager install and commit the updated lockfile.",
          requiredTests: [],
        },
      ),
    );
  }

  if (baseP && headP) {
    for (const [name, range] of Object.entries(headP.deps)) {
      const before = baseP.deps[name];
      if (before && major(before) && major(range) && major(before) !== major(range)) {
        findings.push(
          ruleFinding(
            "dependency/major-bump",
            {
              confidence: 0.75,
              kind: "potential",
              description: `\`${name}\` changes major version (${before} -> ${range}).`,
              evidence: [diffEvidence("package.json", `${name}: ${before} -> ${range}`)],
              affectedFiles: ["package.json"],
              affectedModules: [],
              potentialImpact: "Major versions may include breaking API or runtime changes.",
              recommendedFix: "Review the changelog and run the full test suite and a preview deployment.",
              requiredTests: ["build", "preview-smoke"],
            },
            name,
          ),
        );
      }
    }
  }

  if (headP) {
    const missing = new Map<string, string[]>();
    for (const cf of ctx.changes.files) {
      if (cf.status === "deleted") continue;
      const facts = ctx.headGraph.facts.get(cf.path);
      if (!facts) continue;
      for (const imp of facts.imports) {
        const ext = imp.external;
        if (!ext || BUILTINS.has(ext) || /^[@~#]\/?$/.test(ext) || ext.startsWith("@/") || ext.startsWith("~") || ext.startsWith("#")) continue;
        if (headP.deps[ext] === undefined && headP.deps[`@types/${ext}`] === undefined && ext !== "bun") {
          missing.set(ext, [...(missing.get(ext) ?? []), cf.path]);
        }
      }
    }
    for (const [pkg, files] of missing) {
      findings.push(
        ruleFinding(
          "dependency/missing-package",
          {
            confidence: 0.85,
            kind: "confirmed",
            description: `\`${pkg}\` is imported by ${files.join(", ")} but not declared in package.json.`,
            evidence: files.slice(0, 5).map((f) => diffEvidence(f, `Imports \`${pkg}\`.`)),
            affectedFiles: files,
            affectedModules: modulesOf(files, ctx.config),
            potentialImpact: "Works locally through a hoisted or global install; fails on a clean Vercel/CI install.",
            recommendedFix: `Add \`${pkg}\` to package.json and commit the lockfile.`,
            requiredTests: ["build"],
          },
          pkg,
        ),
      );
    }
  }
  return findings;
}
