import ts from "typescript";
import type { RepoSnapshot } from "./snapshot";

export interface ImportRecord {
  specifier: string;
  /** Snapshot path when the import resolves to a file in the repository. */
  resolved?: string;
  /** Package name for bare specifiers that are not repo-local. */
  external?: string;
  /** Imported binding names; "default" and "*" are used for default and namespace imports. */
  names: string[];
  kind: "static" | "dynamic" | "reexport" | "require";
}

export interface ApiCallRecord {
  path: string;
  confidence: "high" | "medium";
  line: number;
}

export interface FileFacts {
  path: string;
  imports: ImportRecord[];
  exports: string[];
  /** Specifiers of `export * from` (names unknown without resolving; resolved at graph level). */
  starReexports: string[];
  envVars: Array<{ name: string; line: number }>;
  apiCalls: ApiCallRecord[];
  isClientComponent: boolean;
  /** Property names read via `.x` or destructuring; used for consumer/field matching. */
  accessedProperties: Set<string>;
  /** True when parsing produced syntax diagnostics; relationships may be incomplete. */
  parseUncertain: boolean;
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface PathAliases {
  baseUrl: string;
  patterns: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

export function readPathAliases(snapshot: RepoSnapshot): PathAliases {
  const aliases: PathAliases = { baseUrl: "", patterns: [] };
  const raw = snapshot.files.get("tsconfig.json");
  if (!raw) return aliases;
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", raw);
  const co = (parsed.config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
  aliases.baseUrl = (co.baseUrl ?? ".").replace(/^\.\/?/, "").replace(/\/$/, "");
  for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
    const star = pattern.indexOf("*");
    aliases.patterns.push({
      prefix: star >= 0 ? pattern.slice(0, star) : pattern,
      suffix: star >= 0 ? pattern.slice(star + 1) : "",
      targets: targets.map((t) => t.replace(/^\.\//, "")),
    });
  }
  return aliases;
}

function join(...parts: string[]): string {
  const out: string[] = [];
  for (const seg of parts.join("/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function tryResolve(candidate: string, files: ReadonlyMap<string, string>): string | undefined {
  const stripped = candidate.replace(/\.(?:[cm]?js|jsx)$/, "");
  const bases = stripped !== candidate ? [candidate, stripped] : [candidate];
  for (const b of bases) {
    if (CODE_EXT.test(b) && files.has(b)) return b;
    for (const e of RESOLVE_EXT) if (files.has(b + e)) return b + e;
    for (const e of RESOLVE_EXT) if (files.has(`${b}/index${e}`)) return `${b}/index${e}`;
  }
  return undefined;
}

export function resolveSpecifier(
  from: string,
  specifier: string,
  files: ReadonlyMap<string, string>,
  aliases: PathAliases,
): { resolved?: string; external?: string } {
  if (specifier.startsWith(".")) {
    return { resolved: tryResolve(join(dirname(from), specifier), files) };
  }
  for (const a of aliases.patterns) {
    if (specifier.startsWith(a.prefix) && specifier.endsWith(a.suffix) && specifier.length >= a.prefix.length + a.suffix.length) {
      const mid = specifier.slice(a.prefix.length, specifier.length - a.suffix.length);
      for (const t of a.targets) {
        const r = tryResolve(join(aliases.baseUrl, t.replace("*", mid)), files);
        if (r) return { resolved: r };
      }
    }
  }
  const viaBase = tryResolve(join(aliases.baseUrl, specifier), files);
  if (viaBase) return { resolved: viaBase };
  if (specifier.startsWith("node:")) return { external: specifier };
  const parts = specifier.split("/");
  return { external: specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] };
}

function bindingNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push("default");
  const nb = clause.namedBindings;
  if (nb) {
    if (ts.isNamespaceImport(nb)) names.push("*");
    else for (const el of nb.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function collectBindingNames(name: ts.BindingName, out: string[]) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) collectBindingNames(el.name, out);
}

export function extractFileFacts(
  path: string,
  content: string,
  files: ReadonlyMap<string, string>,
  aliases: PathAliases,
): FileFacts {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const facts: FileFacts = {
    path,
    imports: [],
    exports: [],
    starReexports: [],
    envVars: [],
    apiCalls: [],
    isClientComponent: false,
    accessedProperties: new Set(),
    parseUncertain: ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0) > 0,
  };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const addImport = (specifier: string, names: string[], kind: ImportRecord["kind"]) => {
    facts.imports.push({ specifier, names, kind, ...resolveSpecifier(path, specifier, files, aliases) });
  };

  const first = sf.statements[0];
  if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client") {
    facts.isClientComponent = true;
  }

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      addImport(st.moduleSpecifier.text, bindingNames(st.importClause), "static");
    } else if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        if (!st.exportClause) {
          facts.starReexports.push(st.moduleSpecifier.text);
          addImport(st.moduleSpecifier.text, ["*"], "reexport");
        } else if (ts.isNamedExports(st.exportClause)) {
          addImport(st.moduleSpecifier.text, st.exportClause.elements.map((e) => (e.propertyName ?? e.name).text), "reexport");
          for (const e of st.exportClause.elements) facts.exports.push(e.name.text);
        } else if (ts.isNamespaceExport(st.exportClause)) {
          addImport(st.moduleSpecifier.text, ["*"], "reexport");
          facts.exports.push(st.exportClause.name.text);
        }
      } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) facts.exports.push(e.name.text);
      }
    } else if (ts.isExportAssignment(st)) {
      facts.exports.push("default");
    } else if (hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) facts.exports.push("default");
      else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) collectBindingNames(d.name, facts.exports);
      else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
        facts.exports.push(st.name.text);
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const arg0 = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg0 && ts.isStringLiteralLike(arg0)) {
        addImport(arg0.text, ["*"], "dynamic");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && arg0 && ts.isStringLiteralLike(arg0)) {
        addImport(arg0.text, ["*"], "require");
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      facts.accessedProperties.add(node.name.text);
      const t = node.expression.getText(sf);
      if (t === "process.env") facts.envVars.push({ name: node.name.text, line: lineOf(node) });
      else if (t === "import.meta.env") facts.envVars.push({ name: node.name.text, line: lineOf(node) });
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const t = node.expression.getText(sf);
      if (t === "process.env" || t === "import.meta.env") facts.envVars.push({ name: node.argumentExpression.text, line: lineOf(node) });
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) facts.accessedProperties.add(key.text);
      // const { A, B } = process.env
      const decl = node.parent.parent;
      if (ts.isVariableDeclaration(decl) && decl.initializer?.getText(sf) === "process.env" && (ts.isIdentifier(key) || ts.isStringLiteral(key))) {
        facts.envVars.push({ name: key.text, line: lineOf(node) });
      }
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? node.head.text : node.text;
      if (text.startsWith("/api/") || text === "/api") {
        const p = text.split(/[?#]/)[0]!;
        if (p.length > 1) facts.apiCalls.push({ path: p, confidence: ts.isTemplateExpression(node) ? "medium" : "high", line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return facts;
}

export interface DependencyEdge {
  from: string;
  to: string;
  names: string[];
  kind: ImportRecord["kind"];
}

export class DependencyGraph {
  readonly facts = new Map<string, FileFacts>();
  readonly edges: DependencyEdge[] = [];
  private readonly importers = new Map<string, DependencyEdge[]>();
  /** Files with syntax errors or unresolved relative imports: relationships there are incomplete. */
  readonly uncertain: string[] = [];

  constructor(readonly sha: string) {}

  addFacts(f: FileFacts) {
    this.facts.set(f.path, f);
    if (f.parseUncertain) this.uncertain.push(f.path);
    for (const imp of f.imports) {
      if (imp.resolved) {
        const e: DependencyEdge = { from: f.path, to: imp.resolved, names: imp.names, kind: imp.kind };
        this.edges.push(e);
        const list = this.importers.get(imp.resolved) ?? [];
        list.push(e);
        this.importers.set(imp.resolved, list);
      } else if (imp.specifier.startsWith(".") && !/\.(css|svg|png|jpe?g|json|md)$/.test(imp.specifier)) {
        if (!this.uncertain.includes(f.path)) this.uncertain.push(f.path);
      }
    }
  }

  /** Files that import `file`, with the names they import. */
  directDependents(file: string): DependencyEdge[] {
    return this.importers.get(file) ?? [];
  }

  /** All files transitively depending on any of `files`, each with one shortest import path. */
  transitiveDependents(files: readonly string[], maxDepth = 6): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const queue: Array<{ file: string; path: string[] }> = files.map((f) => ({ file: f, path: [f] }));
    const seen = new Set(files);
    while (queue.length) {
      const { file, path } = queue.shift()!;
      if (path.length > maxDepth) continue;
      for (const e of this.directDependents(file)) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        const p = [...path, e.from];
        result.set(e.from, p);
        queue.push({ file: e.from, path: p });
      }
    }
    return result;
  }

  importsOf(file: string): DependencyEdge[] {
    return this.edges.filter((e) => e.from === file);
  }

  /** Consumers calling an API route path (matches dynamic segments such as [id]). */
  apiConsumers(routeUrl: string): Array<{ file: string; call: ApiCallRecord }> {
    const re = new RegExp("^" + routeUrl.replace(/[.*+?^${}()|\\]/g, "\\$&").replace(/\\\[[^\]]+\\\]/g, "[^/]+") + "/?$");
    const out: Array<{ file: string; call: ApiCallRecord }> = [];
    for (const f of this.facts.values()) {
      for (const call of f.apiCalls) if (re.test(call.path) || (call.confidence === "medium" && routeUrl.startsWith(call.path))) out.push({ file: f.path, call });
    }
    return out;
  }
}

export function buildDependencyGraph(snapshot: RepoSnapshot): DependencyGraph {
  const g = new DependencyGraph(snapshot.sha);
  const aliases = readPathAliases(snapshot);
  for (const [path, content] of snapshot.files) {
    if (!CODE_EXT.test(path)) continue;
    g.addFacts(extractFileFacts(path, content, snapshot.files, aliases));
  }
  return g;
}

/** Names exported by `file`, following `export *` re-exports. */
export function effectiveExports(graph: DependencyGraph, file: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  if (seen.has(file)) return out;
  seen.add(file);
  const f = graph.facts.get(file);
  if (!f) return out;
  f.exports.forEach((e) => out.add(e));
  for (const imp of f.imports) {
    if (imp.kind === "reexport" && imp.names.includes("*") && imp.resolved && f.starReexports.includes(imp.specifier)) {
      effectiveExports(graph, imp.resolved, seen).forEach((e) => out.add(e));
    }
  }
  return out;
}
