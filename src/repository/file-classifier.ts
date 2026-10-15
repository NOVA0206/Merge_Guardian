export type FileKind =
  | "source"
  | "test"
  | "api-route"
  | "migration"
  | "dependency-manifest"
  | "lockfile"
  | "workflow"
  | "guardian-policy"
  | "codeowners"
  | "env-template"
  | "config"
  | "docs"
  | "other";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** A path can have several kinds (an API route is also source). */
export function classifyFile(path: string): FileKind[] {
  const kinds: FileKind[] = [];
  if (path.startsWith(".guardian/")) kinds.push("guardian-policy");
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) kinds.push("workflow");
  if (/(^|\/)CODEOWNERS$/.test(path)) kinds.push("codeowners");
  if (/(^|\/)(package\.json)$/.test(path)) kinds.push("dependency-manifest");
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/.test(path)) kinds.push("lockfile");
  if (/(^|\/)\.env\.example$/.test(path)) kinds.push("env-template");
  if (/\.sql$/.test(path) && /(^|\/)(migrations?|supabase\/migrations|prisma\/migrations|db\/migrate)\//.test(path)) kinds.push("migration");
  if (/(^|\/)(tests?|__tests__|e2e)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) kinds.push("test");
  else if (SOURCE.test(path)) kinds.push("source");
  if (isApiRoutePath(path)) kinds.push("api-route");
  if (/\.(md|mdx|txt)$/i.test(path) || path.startsWith("docs/")) kinds.push("docs");
  if (/(^|\/)(next\.config|vercel|tsconfig|vite\.config|tailwind\.config|postcss\.config|eslint\.config)[^/]*$/.test(path)) kinds.push("config");
  return kinds.length ? kinds : ["other"];
}

export function isApiRoutePath(path: string): boolean {
  return /(^|\/)app\/.*\/?route\.[jt]sx?$/.test(path) || /(^|\/)pages\/api\/.+\.[jt]sx?$/.test(path);
}

/** Map a Next.js route file to the URL path consumers call, e.g. src/app/api/items/[id]/route.ts -> /api/items/[id]. */
export function routeUrlForFile(path: string): string | undefined {
  let m = /(?:^|\/)app\/(.*?)\/?route\.[jt]sx?$/.exec(path);
  if (m) {
    const segs = (m[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return "/" + segs.join("/");
  }
  m = /(?:^|\/)pages\/api\/(.+?)(?:\/index)?\.[jt]sx?$/.exec(path);
  if (m) return "/api/" + m[1];
  return undefined;
}

export function isTestFile(path: string): boolean {
  return classifyFile(path).includes("test");
}
