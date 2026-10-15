import { assertSafeRepoPath } from "@/security/input-sanitization";
import { snapshotFromMap, type RepoSnapshot } from "@/repository/snapshot";

export interface PatchFile {
  path: string;
  /** Full new content; null deletes the file. */
  content: string | null;
}

export interface Patch {
  findingId: string;
  summary: string;
  files: PatchFile[];
  /** Commands CI should run to validate this repair (informational; executed only in isolated CI). */
  tests: string[];
}

export interface FileDiffStat {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

/**
 * An in-memory copy of the repository at the source revision. Repairs are applied here, never to a real
 * checkout, and nothing in this class can execute code or touch the filesystem or network.
 */
export class VirtualWorkspace {
  private readonly files: Map<string, string>;

  constructor(readonly source: RepoSnapshot) {
    this.files = new Map(source.files);
  }

  apply(patch: Patch): RepoSnapshot {
    for (const f of patch.files) {
      const path = assertSafeRepoPath(f.path);
      if (f.content === null) this.files.delete(path);
      else this.files.set(path, f.content);
    }
    return snapshotFromMap(this.source.sha, new Map(this.files));
  }

  diff(patch: Patch): FileDiffStat[] {
    return patch.files.map((f) => {
      const before = this.source.files.get(f.path);
      const after = f.content;
      const b = before?.split("\n") ?? [];
      const a = after?.split("\n") ?? [];
      const set = new Set(b);
      const additions = a.filter((l) => !set.has(l)).length;
      const aset = new Set(a);
      const deletions = b.filter((l) => !aset.has(l)).length;
      return { path: f.path, status: before === undefined ? "added" : after === null ? "deleted" : "modified", additions, deletions };
    });
  }
}
