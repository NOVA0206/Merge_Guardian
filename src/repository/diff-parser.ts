import { createHash } from "node:crypto";
import { classifyFile, type FileKind } from "./file-classifier";
import type { RepoSnapshot } from "./snapshot";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  previousPath?: string;
  kinds: FileKind[];
  additions: number;
  deletions: number;
  /** Lines present in the new version but not the old (1-based line numbers in the new file). */
  addedLines: Array<{ line: number; text: string }>;
}

export interface ChangeSet {
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Multiset line diff: lines in `next` not matched by a line in `prev`. Good enough for scanning, not for patching. */
function diffLines(prev: string, next: string) {
  const counts = new Map<string, number>();
  for (const l of prev.split("\n")) counts.set(l, (counts.get(l) ?? 0) + 1);
  const added: Array<{ line: number; text: string }> = [];
  let deletions = 0;
  const nextLines = next.split("\n");
  nextLines.forEach((text, i) => {
    const c = counts.get(text) ?? 0;
    if (c > 0) counts.set(text, c - 1);
    else added.push({ line: i + 1, text });
  });
  for (const c of counts.values()) deletions += c;
  return { added, deletions };
}

/**
 * Compute the change set between two snapshots. Operating on snapshots (rather than API patches)
 * means the analysis sees the real merge candidate and is independent of GitHub's patch truncation.
 */
export function computeChangeSet(base: RepoSnapshot, head: RepoSnapshot): ChangeSet {
  const files: ChangedFile[] = [];
  const deleted: string[] = [];
  const added: string[] = [];

  for (const [path, content] of head.files) {
    const old = base.files.get(path);
    if (old === undefined) added.push(path);
    else if (old !== content) {
      const d = diffLines(old, content);
      files.push({ path, status: "modified", kinds: classifyFile(path), additions: d.added.length, deletions: d.deletions, addedLines: d.added });
    }
  }
  for (const path of base.files.keys()) if (!head.files.has(path)) deleted.push(path);

  // Rename detection by identical content hash.
  const deletedByHash = new Map<string, string>();
  for (const p of deleted) deletedByHash.set(sha1(base.files.get(p)!), p);
  const renamedFrom = new Set<string>();
  for (const path of added) {
    const content = head.files.get(path)!;
    const from = deletedByHash.get(sha1(content));
    const lines = content.split("\n").map((text, i) => ({ line: i + 1, text }));
    if (from && !renamedFrom.has(from)) {
      renamedFrom.add(from);
      files.push({ path, status: "renamed", previousPath: from, kinds: classifyFile(path), additions: 0, deletions: 0, addedLines: [] });
    } else {
      files.push({ path, status: "added", kinds: classifyFile(path), additions: lines.length, deletions: 0, addedLines: lines });
    }
  }
  for (const path of deleted) {
    if (renamedFrom.has(path)) continue;
    files.push({ path, status: "deleted", kinds: classifyFile(path), additions: 0, deletions: base.files.get(path)!.split("\n").length, addedLines: [] });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { baseSha: base.sha, headSha: head.sha, files };
}

export function summarizeChangeSet(cs: ChangeSet) {
  const by = (s: ChangeStatus) => cs.files.filter((f) => f.status === s).length;
  const kind = (k: FileKind) => cs.files.filter((f) => f.kinds.includes(k)).length;
  return {
    total: cs.files.length,
    added: by("added"),
    modified: by("modified"),
    deleted: by("deleted"),
    renamed: by("renamed"),
    dependencyChanges: kind("dependency-manifest") + kind("lockfile"),
    migrations: kind("migration"),
    workflows: kind("workflow"),
    apiRoutes: kind("api-route"),
    tests: kind("test"),
    guardianPolicy: kind("guardian-policy"),
  };
}
