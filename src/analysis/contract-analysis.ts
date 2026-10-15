import { discoverRouteContracts } from "@/repository/contract-discovery";
import { effectiveExports } from "@/repository/dependency-graph";
import { isTestFile } from "@/repository/file-classifier";
import { matchesAny } from "@/repository/snapshot";
import type { Finding } from "@/reporting/finding-schema";
import { diffEvidence, modulesOf, ruleFinding, snippetAt, type AnalysisContext } from "./context";

/** Contracts the project itself declared as protected. */
function declaredFields(ctx: AnalysisContext, routeFile: string): Set<string> {
  const c = ctx.config.contracts.apiContracts.find((a) => a.file === routeFile);
  return new Set(c?.responseFields ?? []);
}

function contractTests(ctx: AnalysisContext, files: string[]): string[] {
  const tests = new Set<string>();
  for (const f of ctx.config.testMatrix.features) {
    if (files.some((p) => matchesAny(p, f.sources))) for (const t of [...f.tests.contract, ...f.tests.integration, ...f.tests.unit]) tests.add(t);
  }
  return [...tests];
}

export function analyzeApiContracts(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const baseRoutes = discoverRouteContracts(ctx.base);
  const headRoutes = discoverRouteContracts(ctx.head);

  for (const [file, baseRoute] of baseRoutes) {
    const changed = ctx.changes.files.some((f) => f.path === file || f.previousPath === file);
    if (!changed) continue;
    const headRoute = headRoutes.get(file);
    const consumers = ctx.headGraph.apiConsumers(baseRoute.url).filter((c) => c.file !== file && !isTestFile(c.file));

    if (!headRoute) {
      // Route file deleted. Only a break if some route still serves the same URL.
      const moved = [...headRoutes.values()].some((r) => r.url === baseRoute.url);
      if (!moved && consumers.length > 0) {
        findings.push(
          ruleFinding(
            "contract/api-route-removed",
            {
              confidence: 0.9,
              kind: "confirmed",
              description: `${baseRoute.url} was removed but ${consumers.length} file(s) still call it.`,
              evidence: consumers.slice(0, 5).map((c) => ({ source: "static" as const, file: c.file, line: c.call.line, snippet: snippetAt(ctx.head.files.get(c.file), c.call.line), detail: `Still calls ${baseRoute.url}.` })),
              affectedFiles: [file, ...consumers.map((c) => c.file)],
              affectedModules: modulesOf([file, ...consumers.map((c) => c.file)], ctx.config),
              potentialImpact: "Callers receive 404 responses at runtime; builds and type checks will not catch this.",
              recommendedFix: "Restore the route or update every consumer in the same PR.",
              requiredTests: contractTests(ctx, [file]),
            },
            baseRoute.url,
          ),
        );
      }
      continue;
    }

    const removed = baseRoute.responseFields.filter((f) => !headRoute.responseFields.includes(f));
    if (removed.length === 0) continue;
    const added = headRoute.responseFields.filter((f) => !baseRoute.responseFields.includes(f));
    const protectedFields = declaredFields(ctx, file);
    const renameHint = removed.length === 1 && added.length === 1 ? ` The field may have been renamed \`${removed[0]}\` -> \`${added[0]}\`.` : "";
    const uncertain = headRoute.uncertain;

    for (const field of removed) {
      const using = consumers.filter((c) => ctx.headGraph.facts.get(c.file)?.accessedProperties.has(field));
      const isProtected = protectedFields.has(field);
      if (using.length > 0) {
        findings.push(
          ruleFinding(
            "contract/api-field-removed",
            {
              confidence: 0.9,
              kind: "confirmed",
              description: `\`${field}\` is no longer returned by ${baseRoute.url}, but ${using.map((u) => u.file).join(", ")} still read(s) \`.${field}\`.${renameHint}`,
              evidence: [
                diffEvidence(file, `Response fields before: [${baseRoute.responseFields.join(", ")}]; after: [${headRoute.responseFields.join(", ")}].`),
                ...using.slice(0, 5).map((u) => ({ source: "static" as const, file: u.file, line: u.call.line, snippet: snippetAt(ctx.head.files.get(u.file), u.call.line), detail: `Calls ${baseRoute.url} and reads \`.${field}\`.` })),
              ],
              affectedFiles: [file, ...using.map((u) => u.file)],
              affectedModules: modulesOf([file, ...using.map((u) => u.file)], ctx.config),
              potentialImpact: `Consumers read a field that is now undefined, breaking the UI or workflow that depends on it${isProtected ? " (declared in protected-contracts.yaml)" : ""}.`,
              recommendedFix: "Keep the old field (additive change), or update every consumer and add a contract test in the same PR.",
              requiredTests: contractTests(ctx, [file, ...using.map((u) => u.file)]),
              repairable: renameHint !== "",
              data: renameHint !== "" ? { kind: "field-rename", from: removed[0], to: added[0], consumers: using.map((u) => u.file), route: file, protected: isProtected } : undefined,
            },
            `${baseRoute.url}:${field}`,
          ),
        );
      } else if (isProtected) {
        findings.push(
          ruleFinding(
            "contract/api-field-removed",
            {
              confidence: 0.95,
              kind: "confirmed",
              description: `\`${field}\` is part of the protected contract for ${baseRoute.url} but is no longer returned.${renameHint}`,
              evidence: [diffEvidence(file, `Protected field \`${field}\` missing from response; now returns [${headRoute.responseFields.join(", ")}].`)],
              affectedFiles: [file],
              affectedModules: modulesOf([file], ctx.config),
              potentialImpact: "External or undiscovered consumers of a declared contract will break.",
              recommendedFix: "Restore the field or version the API and update protected-contracts.yaml through an approved change.",
              requiredTests: contractTests(ctx, [file]),
            },
            `${baseRoute.url}:${field}`,
          ),
        );
      } else {
        findings.push(
          ruleFinding(
            "contract/api-field-removed-unconsumed",
            {
              confidence: uncertain ? 0.4 : 0.6,
              kind: "potential",
              description: `\`${field}\` is no longer returned by ${baseRoute.url}; no in-repo consumer reads it, but external clients may.${renameHint}`,
              evidence: [diffEvidence(file, `Response fields before: [${baseRoute.responseFields.join(", ")}]; after: [${headRoute.responseFields.join(", ")}].`)],
              affectedFiles: [file],
              affectedModules: modulesOf([file], ctx.config),
              potentialImpact: "Mobile apps, other services, or cached clients may still expect the field.",
              recommendedFix: "Confirm there are no external consumers, or keep the field during a deprecation window.",
              requiredTests: contractTests(ctx, [file]),
            },
            `${baseRoute.url}:${field}`,
          ),
        );
      }
    }
  }
  return findings;
}

/** Removed or renamed exports that other files still import: a build-time or runtime break once merged. */
export function analyzeExportCompatibility(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const cf of ctx.changes.files) {
    const origin = cf.previousPath ?? cf.path;
    if (!ctx.baseGraph.facts.has(origin)) continue;
    const baseExports = effectiveExports(ctx.baseGraph, origin);

    if (cf.status === "deleted" || cf.status === "renamed") {
      const dependents = ctx.baseGraph.directDependents(origin).filter((d) => ctx.head.files.has(d.from));
      const stillBroken = dependents.filter((d) => {
        const hf = ctx.headGraph.facts.get(d.from);
        const imp = hf?.imports.find((i) => i.resolved === undefined && i.names.some((n) => d.names.includes(n)) && i.specifier.startsWith("."));
        return Boolean(imp);
      });
      if (stillBroken.length > 0) {
        findings.push(
          ruleFinding(
            "integration/removed-module",
            {
              confidence: 0.9,
              kind: "confirmed",
              description: `${origin} was ${cf.status === "deleted" ? "deleted" : `renamed to ${cf.path}`} but ${stillBroken.map((d) => d.from).join(", ")} still import(s) the old path.`,
              evidence: stillBroken.slice(0, 5).map((d) => ({ source: "graph" as const, file: d.from, detail: `Imports ${origin} (unresolved at head).` })),
              affectedFiles: [origin, ...stillBroken.map((d) => d.from)],
              affectedModules: modulesOf([origin, ...stillBroken.map((d) => d.from)], ctx.config),
              potentialImpact: "Module resolution fails at build or run time.",
              recommendedFix: "Update the importing files or restore the module.",
              requiredTests: [],
              repairable: cf.status === "renamed",
              data: cf.status === "renamed" ? { kind: "module-rename", from: origin, to: cf.path, importers: stillBroken.map((d) => d.from) } : undefined,
            },
            origin,
          ),
        );
      }
      continue;
    }

    const headExports = effectiveExports(ctx.headGraph, cf.path);
    const removed = [...baseExports].filter((n) => !headExports.has(n));
    for (const name of removed) {
      const importers = ctx.headGraph.directDependents(cf.path).filter((d) => d.names.includes(name));
      if (importers.length === 0) continue;
      findings.push(
        ruleFinding(
          "integration/removed-export",
          {
            confidence: 0.95,
            kind: "confirmed",
            description: `\`${name}\` is no longer exported from ${cf.path} but is imported by ${importers.map((i) => i.from).join(", ")}.`,
            evidence: importers.slice(0, 5).map((i) => ({ source: "graph" as const, file: i.from, detail: `Imports \`${name}\` from ${cf.path}.` })),
            affectedFiles: [cf.path, ...importers.map((i) => i.from)],
            affectedModules: modulesOf([cf.path, ...importers.map((i) => i.from)], ctx.config),
            potentialImpact: "The importing modules fail to compile or receive undefined at runtime.",
            recommendedFix: "Re-export the symbol or update every importer in this PR.",
            requiredTests: [],
          },
          `${cf.path}:${name}`,
        ),
      );
    }
  }
  return findings;
}

// Matches a, "a", public.a, "public"."a", public."a" ... (captured whole, then normalised by `clean`).
const SQL_IDENT = String.raw`((?:["\`]?[A-Za-z_]\w*["\`]?\.)?["\`]?[A-Za-z_]\w*["\`]?)`;
const clean = (s: string | undefined) => s?.replace(/["\`]/g, "");

interface SqlOp {
  kind: "drop-table" | "drop-column" | "rename-column" | "set-not-null" | "truncate" | "unscoped-delete" | "drop-schema";
  table?: string;
  column?: string;
  line: number;
  text: string;
}

export function parseMigrationSql(sql: string): SqlOp[] {
  const ops: SqlOp[] = [];
  const stripped = sql.replace(/--.*$/gm, (m) => " ".repeat(m.length));
  const lineAt = (idx: number) => stripped.slice(0, idx).split("\n").length;
  const push = (re: RegExp, build: (m: RegExpExecArray) => Omit<SqlOp, "line" | "text">) => {
    for (const m of stripped.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      ops.push({ ...build(m as RegExpExecArray), line: lineAt(m.index ?? 0), text: m[0].trim().slice(0, 160) });
    }
  };
  push(new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?${SQL_IDENT}`, "i"), (m) => ({ kind: "drop-table", table: clean(m[1]) }));
  push(new RegExp(String.raw`\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${SQL_IDENT}\s+drop\s+column\s+(?:if\s+exists\s+)?${SQL_IDENT}`, "i"), (m) => ({ kind: "drop-column", table: clean(m[1]), column: clean(m[2]) }));
  push(new RegExp(String.raw`\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${SQL_IDENT}\s+rename\s+column\s+${SQL_IDENT}\s+to\s+${SQL_IDENT}`, "i"), (m) => ({ kind: "rename-column", table: clean(m[1]), column: clean(m[2]) }));
  push(new RegExp(String.raw`\balter\s+table\s+(?:only\s+)?${SQL_IDENT}\s+alter\s+column\s+${SQL_IDENT}\s+set\s+not\s+null`, "i"), (m) => ({ kind: "set-not-null", table: clean(m[1]), column: clean(m[2]) }));
  push(/\btruncate\s+(?:table\s+)?(?:only\s+)?["`]?([A-Za-z_][\w.]*)["`]?/i, (m) => ({ kind: "truncate", table: m[1] }));
  push(/\bdelete\s+from\s+["`]?([A-Za-z_][\w.]*)["`]?\s*(?:;|$)/im, (m) => ({ kind: "unscoped-delete", table: m[1] }));
  push(/\bdrop\s+(?:schema|database)\s+/i, () => ({ kind: "drop-schema" }));
  return ops;
}

const word = (s: string) => new RegExp(`(?<![\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);

export function analyzeMigrations(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const migrations = ctx.changes.files.filter((f) => f.kinds.includes("migration") && f.status !== "deleted");
  if (migrations.length === 0) return findings;
  const sourceFiles = [...ctx.headGraph.facts.keys()].filter((p) => !isTestFile(p));

  for (const mig of migrations) {
    const sql = ctx.head.files.get(mig.path) ?? "";
    // For modified (not new) migration files, only inspect newly added lines to avoid re-reporting history.
    const text = mig.status === "added" ? sql : mig.addedLines.map((l) => l.text).join("\n");
    for (const op of parseMigrationSql(text)) {
      const tableBare = op.table?.split(".").pop();
      const usingFiles = (needle: string | undefined) =>
        needle
          ? sourceFiles.filter((p) => {
              const content = ctx.head.files.get(p) ?? "";
              return word(needle).test(content) && (!tableBare || word(tableBare).test(content) || needle === tableBare);
            })
          : [];
      const expectation = ctx.config.contracts.databaseExpectations.find((e) => e.table === tableBare);

      if (op.kind === "truncate" || op.kind === "unscoped-delete" || op.kind === "drop-schema") {
        findings.push(
          ruleFinding(
            "migration/destructive-data-op",
            {
              confidence: 0.85,
              kind: "probable",
              description: `Migration ${mig.path} contains a destructive operation: \`${op.text}\`.`,
              evidence: [diffEvidence(mig.path, "Destructive statement in migration.", op.line, op.text)],
              affectedFiles: [mig.path],
              affectedModules: modulesOf([mig.path], ctx.config),
              potentialImpact: "Production data may be irreversibly deleted when the migration runs.",
              recommendedFix: "Scope the statement with a WHERE clause, take a backup, or split into a reviewed one-off data task.",
              requiredTests: ["migration-validation"],
            },
            `${op.kind}:${op.table ?? ""}:${op.line}`,
          ),
        );
        continue;
      }

      if (op.kind === "drop-column" || op.kind === "drop-table" || op.kind === "rename-column") {
        const needle = op.kind === "drop-table" ? tableBare : op.column;
        const users = usingFiles(needle);
        const expected = op.kind !== "drop-table" ? expectation?.columns.includes(op.column ?? "") : Boolean(expectation);
        if (users.length > 0 || expected) {
          findings.push(
            ruleFinding(
              "migration/column-dropped-in-use",
              {
                confidence: users.length > 0 ? 0.85 : 0.9,
                kind: users.length > 0 ? "confirmed" : "probable",
                description: `${mig.path} ${op.kind.replace("-", " ")}s \`${op.kind === "drop-table" ? op.table : `${op.table}.${op.column}`}\`${users.length ? `, still referenced by ${users.join(", ")}` : ", which protected-contracts.yaml declares as required"}.`,
                evidence: [
                  diffEvidence(mig.path, "Schema-removing statement.", op.line, op.text),
                  ...users.slice(0, 5).map((u) => ({ source: "static" as const, file: u, detail: `References \`${needle}\` (table \`${tableBare}\`).` })),
                ],
                affectedFiles: [mig.path, ...users],
                affectedModules: modulesOf([mig.path, ...users], ctx.config),
                potentialImpact: "Queries in deployed and new code fail once the migration runs; a rolling deploy can break production before the code change lands.",
                recommendedFix: "Use expand/contract: stop reading the column first, deploy, then drop it in a later migration.",
                requiredTests: ["migration-validation", ...contractTests(ctx, users)],
              },
              `${op.kind}:${op.table}:${op.column ?? ""}`,
            ),
          );
        } else {
          findings.push(
            ruleFinding(
              "migration/schema-breaking",
              {
                confidence: 0.55,
                kind: "potential",
                description: `${mig.path} removes \`${op.table}${op.column ? "." + op.column : ""}\`; no in-repo usage was found, but the currently deployed version or external tools may use it.`,
                evidence: [diffEvidence(mig.path, "Schema-removing statement.", op.line, op.text)],
                affectedFiles: [mig.path],
                affectedModules: modulesOf([mig.path], ctx.config),
                potentialImpact: "Backward-incompatible with the version still serving traffic during rollout.",
                recommendedFix: "Confirm nothing reads the object, then use expand/contract.",
                requiredTests: ["migration-validation"],
              },
              `${op.kind}:${op.table}:${op.column ?? ""}`,
            ),
          );
        }
      } else if (op.kind === "set-not-null") {
        findings.push(
          ruleFinding(
            "migration/schema-breaking",
            {
              confidence: 0.6,
              kind: "potential",
              description: `${mig.path} makes \`${op.table}.${op.column}\` NOT NULL; existing NULL rows or old writers will fail.`,
              evidence: [diffEvidence(mig.path, "SET NOT NULL statement.", op.line, op.text)],
              affectedFiles: [mig.path],
              affectedModules: modulesOf([mig.path], ctx.config),
              potentialImpact: "Migration can fail on existing data; the previous app version may insert NULLs.",
              recommendedFix: "Backfill first, add a default, then enforce NOT NULL in a later migration.",
              requiredTests: ["migration-validation"],
            },
            `${op.kind}:${op.table}:${op.column}`,
          ),
        );
      }
    }
  }
  return findings;
}

const ASSET = /\.(css|scss|svg|png|jpe?g|gif|webp|ico|json|md|mdx|txt)$/i;

/**
 * Imports in changed files that point at a missing module or a name the target no longer exports.
 * This is what exposes two individually-passing PRs that conflict once combined (spec scenario D).
 */
export function analyzeImportResolution(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  for (const cf of ctx.changes.files) {
    if (cf.status === "deleted") continue;
    const facts = ctx.headGraph.facts.get(cf.path);
    if (!facts) continue;
    for (const imp of facts.imports) {
      if (imp.specifier.startsWith(".") && !imp.resolved && !ASSET.test(imp.specifier)) {
        findings.push(
          ruleFinding(
            "integration/unresolved-import",
            {
              confidence: 0.9,
              kind: "confirmed",
              description: `${cf.path} imports \`${imp.specifier}\`, which does not exist in the merged tree.`,
              evidence: [{ source: "graph", file: cf.path, detail: `Unresolved relative import \`${imp.specifier}\`.` }],
              affectedFiles: [cf.path],
              affectedModules: modulesOf([cf.path], ctx.config),
              potentialImpact: "Build fails, or fails only in the merged result if another change moved or removed the module.",
              recommendedFix: "Fix the import path or restore the module.",
              requiredTests: [],
            },
            `${cf.path}:${imp.specifier}`,
          ),
        );
        continue;
      }
      if (!imp.resolved || imp.kind === "reexport" || imp.names.includes("*")) continue;
      const targetFacts = ctx.headGraph.facts.get(imp.resolved);
      if (!targetFacts || targetFacts.parseUncertain) continue;
      const available = effectiveExports(ctx.headGraph, imp.resolved);
      const unresolvedStar = targetFacts.starReexports.some((s) => !targetFacts.imports.find((i) => i.specifier === s)?.resolved);
      if (unresolvedStar) continue;
      const missing = imp.names.filter((n) => !available.has(n));
      if (missing.length === 0) continue;
      findings.push(
        ruleFinding(
          "integration/unresolved-import",
          {
            confidence: 0.95,
            kind: "confirmed",
            description: `${cf.path} imports ${missing.map((m) => `\`${m}\``).join(", ")} from ${imp.resolved}, which does not export ${missing.length > 1 ? "them" : "it"}.`,
            evidence: [
              { source: "graph", file: cf.path, detail: `Imports ${missing.join(", ")} from ${imp.specifier}.` },
              { source: "graph", file: imp.resolved, detail: `Exports: [${[...available].join(", ")}].` },
            ],
            affectedFiles: [cf.path, imp.resolved],
            affectedModules: modulesOf([cf.path, imp.resolved], ctx.config),
            potentialImpact: "Compilation fails or the binding is undefined at runtime in the merged result.",
            recommendedFix: "Import the new name, or restore the export for compatibility.",
            requiredTests: [],
          },
          `${cf.path}:${imp.resolved}:${missing.join(",")}`,
        ),
      );
    }
  }
  return findings;
}
