import type { ReviewRecord } from "@/policy/approval-policy";
import type { CheckResult } from "@/reporting/finding-schema";
import type { RepoSnapshot } from "@/repository/snapshot";
import type { RepoPermission } from "@/security/permissions";

export interface PullRequestInfo {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  headRepoFullName: string;
  isFork: boolean;
  /** GitHub's test-merge commit for the PR; undefined when GitHub has not computed it or there are conflicts. */
  mergeCommitSha?: string;
  /** false = conflicts; null/undefined = not computed yet. */
  mergeable?: boolean | null;
}

export interface CheckRunUpsert {
  repoFullName: string;
  headSha: string;
  existingId?: number;
  name: string;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure" | "action_required" | "cancelled" | "neutral";
  title: string;
  summary: string;
  detailsUrl?: string;
  externalId?: string;
}

export interface FileCommit {
  path: string;
  /** null deletes the file. */
  content: string | null;
}

/** Everything Guardian needs from GitHub, behind an interface so workflows are testable without the network. */
export interface GitHubGateway {
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  /** Resolve the commit pair to analyse: [baseSha, candidateOrHeadSha]. */
  resolveRevisions(repo: string, pr: PullRequestInfo): Promise<{ baseSha: string; analyzedSha: string; candidateSha?: string; conflict: boolean }>;
  downloadSnapshot(repo: string, sha: string, maxBytes?: number): Promise<RepoSnapshot>;
  listReviews(repo: string, number: number): Promise<ReviewRecord[]>;
  /** Check runs on `sha`, folded to one CheckResult per name (latest wins). */
  listCheckResults(repo: string, sha: string, excludeName?: string): Promise<CheckResult[]>;
  upsertCheckRun(input: CheckRunUpsert): Promise<number>;
  upsertReportComment(repo: string, number: number, body: string, existingId?: number): Promise<number>;
  getCollaboratorPermission(repo: string, user: string): Promise<RepoPermission>;
  getFileAtRef?(repo: string, path: string, ref: string): Promise<string | undefined>;

  /* repair (requires the write-scoped gateway) */
  createBranchFromSha(repo: string, branch: string, sha: string): Promise<void>;
  commitFiles(repo: string, branch: string, message: string, files: FileCommit[]): Promise<string>;
  openPullRequest(repo: string, input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<number>;
}
