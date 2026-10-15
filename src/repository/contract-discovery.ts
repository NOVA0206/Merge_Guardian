import ts from "typescript";
import { isApiRoutePath, routeUrlForFile } from "./file-classifier";
import type { RepoSnapshot } from "./snapshot";

export interface RouteContract {
  url: string;
  file: string;
  methods: string[];
  /** Top-level keys seen in JSON responses. */
  responseFields: string[];
  /** True when a spread, variable, or computed key means the field list may be incomplete. */
  uncertain: boolean;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function extractRouteContract(file: string, content: string): RouteContract | undefined {
  const url = routeUrlForFile(file);
  if (!url) return undefined;
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const methods = new Set<string>();
  const fields = new Set<string>();
  let uncertain = false;

  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name && HTTP_METHODS.has(st.name.text)) methods.add(st.name.text);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && HTTP_METHODS.has(d.name.text)) methods.add(d.name.text);
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "json") {
      const arg = node.arguments[0];
      const callee = node.expression.expression.getText(sf);
      const looksLikeResponse = /(^|\.)(NextResponse|Response)$/.test(callee) || /^res(ponse)?$/.test(callee) || /\)$/.test(callee);
      if (arg && looksLikeResponse) {
        if (ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
              const n = p.name;
              if (ts.isIdentifier(n) || ts.isStringLiteral(n)) fields.add(n.text);
              else uncertain = true;
            } else uncertain = true;
          }
        } else if (!ts.isArrayLiteralExpression(arg)) uncertain = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { url, file, methods: [...methods].sort(), responseFields: [...fields].sort(), uncertain };
}

export function discoverRouteContracts(snapshot: RepoSnapshot): Map<string, RouteContract> {
  const out = new Map<string, RouteContract>();
  for (const [path, content] of snapshot.files) {
    if (!isApiRoutePath(path)) continue;
    const c = extractRouteContract(path, content);
    if (c) out.set(path, c);
  }
  return out;
}
