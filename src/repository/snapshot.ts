import { unzipSync } from "fflate";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";

/** An immutable, in-memory view of a repository at one revision. No filesystem needed at analysis time. */
export interface RepoSnapshot {
  sha: string;
  files: ReadonlyMap<string, string>;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".vercel", ".turbo", "out"]);
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|sql|md|mdx|prisma|env\.example|toml|txt|css|html|graphql|gql)$/i;
const MAX_FILE_BYTES = 512 * 1024;

export function isAnalyzablePath(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/.test(path)) return true;
  return TEXT_EXT.test(path) || /(^|\/)\.env(\..+)?$/.test(path) ||/(^|\/)CODEOWNERS$/.test(path);
}

export function snapshotFromMap(sha: string, files: Record<string, string> | Map<string, string>): RepoSnapshot {
  return { sha, files: files instanceof Map ? files : new Map(Object.entries(files)) };
}

/** Build a snapshot from a GitHub zipball. Rejects archives above `maxBytes` (serverless memory guard). */
export function snapshotFromZip(sha: string, zip: Uint8Array, maxBytes = 60 * 1024 * 1024, opts: { stripPrefix?: boolean } = {}): RepoSnapshot {
  if (zip.byteLength > maxBytes) throw new Error(`Repository archive exceeds ${Math.round(maxBytes / 1048576)}MB limit`);
  const entries = unzipSync(zip, { filter: (f) => !f.name.endsWith("/") && f.originalSize <= MAX_FILE_BYTES });
  const dec = new TextDecoder("utf-8", { fatal: false });
  const files = new Map<string, string>();
  for (const [name, data] of Object.entries(entries)) {
    const rel = opts.stripPrefix === false ? name : name.slice(name.indexOf("/") + 1); // GitHub zipballs wrap files in "<owner>-<repo>-<sha>/"
    if (!rel || !isAnalyzablePath(rel)) continue;
    files.set(rel, dec.decode(data));
  }
  return { sha, files };
}

/** Read a working directory into a snapshot (CLI, GitHub Actions checkout, and test fixtures). */
export function snapshotFromDirectory(sha: string, root: string): RepoSnapshot {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.size <= MAX_FILE_BYTES) {
        const rel = relative(root, full).split(sep).join("/");
        if (isAnalyzablePath(rel)) files.set(rel, readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return { sha, files };
}

const matcherCache = new Map<string, (p: string) => boolean>();
export function matchesGlob(path: string, glob: string): boolean {
  let m = matcherCache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matcherCache.set(glob, m);
  }
  return m(path);
}
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

/** Snapshot of a git revision in a local checkout (CLI / Actions). Uses `git archive`; never checks anything out. */
export function snapshotFromGitRef(ref: string, cwd = process.cwd(), maxBytes = 200 * 1024 * 1024): RepoSnapshot {
  if (!/^[\w./@^~-]{1,200}$/.test(ref) || ref.startsWith("-")) throw new Error(`Unsafe git ref: ${ref}`);
  const sha = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd, encoding: "utf8" }).trim();
  const zip = execFileSync("git", ["archive", "--format=zip", sha], { cwd, maxBuffer: maxBytes });
  return snapshotFromZip(sha, new Uint8Array(zip), maxBytes, { stripPrefix: false });
}
