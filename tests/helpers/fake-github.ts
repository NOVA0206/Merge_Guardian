import type { CheckRunUpsert, FileCommit, GitHubGateway, PullRequestInfo } from "@/github/gateway";
import type { ReviewRecord } from "@/policy/approval-policy";
import type { CheckResult } from "@/reporting/finding-schema";
import type { RepoSnapshot } from "@/repository/snapshot";
import type { RepoPermission } from "@/security/permissions";

export interface FakeState {
  pr: PullRequestInfo;
  base: RepoSnapshot;
  head: RepoSnapshot;
  reviews: ReviewRecord[];
  checks: CheckResult[];
  permissions: Record<string, RepoPermission>;
}

/** Records every write so tests can assert exactly what Guardian published (and what it did NOT). */
export class FakeGitHub implements GitHubGateway {
  checkRuns: Array<CheckRunUpsert & { id: number }> = [];
  comments = new Map<number, string>();
  branches: Array<{ branch: string; sha: string }> = [];
  commits: Array<{ branch: string; message: string; files: FileCommit[] }> = [];
  pullRequests: Array<{ head: string; base: string; title: string; draft?: boolean }> = [];
  failNextWith?: unknown;
  calls = { getPullRequest: 0, downloadSnapshot: 0 };
  private nextId = 1000;

  constructor(public state: FakeState) {}

  private maybeFail() {
    if (this.failNextWith) {
      const e = this.failNextWith;
      this.failNextWith = undefined;
      throw e;
    }
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    this.calls.getPullRequest++;
    this.maybeFail();
    return this.state.pr;
  }
  async resolveRevisions(_repo: string, pr: PullRequestInfo) {
    return { baseSha: this.state.base.sha, analyzedSha: this.state.head.sha, candidateSha: undefined, conflict: pr.mergeable === false };
  }
  async downloadSnapshot(_repo: string, sha: string) {
    this.calls.downloadSnapshot++;
    return sha === this.state.base.sha ? this.state.base : this.state.head;
  }
  async listReviews() {
    return this.state.reviews;
  }
  async listCheckResults() {
    return this.state.checks;
  }
  async upsertCheckRun(i: CheckRunUpsert) {
    const id = i.existingId ?? this.nextId++;
    const idx = this.checkRuns.findIndex((c) => c.id === id);
    const rec = { ...i, id };
    if (idx >= 0) this.checkRuns[idx] = rec;
    else this.checkRuns.push(rec);
    return id;
  }
  async upsertReportComment(_r: string, _n: number, body: string, existingId?: number) {
    const id = existingId ?? this.nextId++;
    this.comments.set(id, body);
    return id;
  }
  async getCollaboratorPermission(_r: string, user: string) {
    return this.state.permissions[user] ?? "none";
  }
  async createBranchFromSha(_r: string, branch: string, sha: string) {
    if (!branch.startsWith("guardian/")) throw new Error("refused: not a guardian/ branch");
    this.branches.push({ branch, sha });
  }
  async commitFiles(_r: string, branch: string, message: string, files: FileCommit[]) {
    if (!branch.startsWith("guardian/")) throw new Error("refused: not a guardian/ branch");
    this.commits.push({ branch, message, files });
    return "c".repeat(40);
  }
  async openPullRequest(_r: string, input: { head: string; base: string; title: string; body: string; draft?: boolean }) {
    this.pullRequests.push(input);
    return 900 + this.pullRequests.length;
  }

  get lastCheck() {
    return this.checkRuns[this.checkRuns.length - 1];
  }
  get lastComment() {
    return [...this.comments.values()].at(-1);
  }
}

export function makePr(head: string, over: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 7,
    state: "open",
    draft: false,
    title: "Rename field",
    body: "",
    author: "dev-one",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRef: "feature/dev-one-rename",
    headSha: head,
    headRepoFullName: "acme/app",
    isFork: false,
    mergeable: true,
    ...over,
  };
}
