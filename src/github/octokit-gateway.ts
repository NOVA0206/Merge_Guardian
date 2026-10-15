import type { Octokit } from "octokit";
import { getEnv } from "@/config/env";
import type { ReviewRecord } from "@/policy/approval-policy";
import type { CheckResult } from "@/reporting/finding-schema";
import { snapshotFromZip } from "@/repository/snapshot";
import type { RepoPermission } from "@/security/permissions";
import { assertSha } from "@/security/input-sanitization";
import { splitRepo } from "./repo";
import type { CheckRunUpsert, FileCommit, GitHubGateway, PullRequestInfo } from "./gateway";
import { mapCheckRuns } from "./checks";
import { REPORT_MARKER } from "@/reporting/report-builder";

export class OctokitGateway implements GitHubGateway {
  constructor(private readonly octokit: Octokit) {}

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const { owner, repo: name } = splitRepo(repo);
    // GitHub computes mergeability lazily; poll briefly so the test-merge commit is available.
    let pr = (await this.octokit.rest.pulls.get({ owner, repo: name, pull_number: number })).data;
    for (let i = 0; i < 3 && pr.mergeable === null && pr.state === "open"; i++) {
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      pr = (await this.octokit.rest.pulls.get({ owner, repo: name, pull_number: number })).data;
    }
    return {
      number: pr.number,
      state: pr.state as "open" | "closed",
      draft: Boolean(pr.draft),
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      headRepoFullName: pr.head.repo?.full_name ?? repo,
      isFork: Boolean(pr.head.repo && pr.head.repo.full_name !== repo),
      mergeCommitSha: pr.mergeable === false ? undefined : (pr.merge_commit_sha ?? undefined),
      mergeable: pr.mergeable,
    };
  }

  async resolveRevisions(repo: string, pr: PullRequestInfo) {
    const { owner, repo: name } = splitRepo(repo);
    if (pr.mergeable === false) {
      // Conflicting PR: analyse the head against the merge base so findings are still useful.
      const cmp = await this.octokit.rest.repos.compareCommitsWithBasehead({ owner, repo: name, basehead: `${pr.baseSha}...${pr.headSha}` });
      return { baseSha: cmp.data.merge_base_commit.sha, analyzedSha: pr.headSha, conflict: true };
    }
    if (pr.mergeCommitSha) {
      const c = await this.octokit.rest.git.getCommit({ owner, repo: name, commit_sha: pr.mergeCommitSha });
      const first = c.data.parents[0]?.sha;
      // A merge commit's first parent is the target-branch tip it was merged onto.
      if (first && c.data.parents.length === 2) return { baseSha: first, analyzedSha: pr.mergeCommitSha, candidateSha: pr.mergeCommitSha, conflict: false };
    }
    const cmp = await this.octokit.rest.repos.compareCommitsWithBasehead({ owner, repo: name, basehead: `${pr.baseSha}...${pr.headSha}` });
    return { baseSha: cmp.data.merge_base_commit.sha, analyzedSha: pr.headSha, conflict: false };
  }

  async downloadSnapshot(repo: string, sha: string, maxBytes = getEnv().GUARDIAN_MAX_SNAPSHOT_MB * 1024 * 1024) {
    assertSha(sha);
    const { owner, repo: name } = splitRepo(repo);
    const res = await this.octokit.rest.repos.downloadZipballArchive({ owner, repo: name, ref: sha });
    return snapshotFromZip(sha, new Uint8Array(res.data as ArrayBuffer), maxBytes);
  }

  async listReviews(repo: string, number: number): Promise<ReviewRecord[]> {
    const { owner, repo: name } = splitRepo(repo);
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, { owner, repo: name, pull_number: number, per_page: 100 });
    return reviews
      .filter((r) => r.user && r.commit_id)
      .map((r) => ({ id: r.id, user: r.user!.login, state: r.state as ReviewRecord["state"], commitId: r.commit_id!, submittedAt: r.submitted_at ?? new Date(0).toISOString() }));
  }

  async listCheckResults(repo: string, sha: string, excludeName?: string): Promise<CheckResult[]> {
    assertSha(sha);
    const { owner, repo: name } = splitRepo(repo);
    const runs = await this.octokit.paginate(this.octokit.rest.checks.listForRef, { owner, repo: name, ref: sha, per_page: 100, filter: "latest" });
    return mapCheckRuns(runs, sha, excludeName);
  }

  async upsertCheckRun(i: CheckRunUpsert): Promise<number> {
    assertSha(i.headSha);
    const { owner, repo } = splitRepo(i.repoFullName);
    const output = { title: i.title.slice(0, 250), summary: i.summary.slice(0, 60_000) };
    const common = { owner, repo, name: i.name, status: i.status, output, details_url: i.detailsUrl, external_id: i.externalId, ...(i.conclusion ? { conclusion: i.conclusion } : {}) };
    if (i.existingId) {
      return (await this.octokit.rest.checks.update({ ...common, check_run_id: i.existingId })).data.id;
    }
    return (await this.octokit.rest.checks.create({ ...common, head_sha: i.headSha })).data.id;
  }

  async upsertReportComment(repoFullName: string, number: number, body: string, existingId?: number): Promise<number> {
    const { owner, repo } = splitRepo(repoFullName);
    if (existingId) {
      try {
        return (await this.octokit.rest.issues.updateComment({ owner, repo, comment_id: existingId, body })).data.id;
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
    }
    // Recover from lost state: find our marker comment instead of posting a duplicate.
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
    const mine = comments.find((c) => c.body?.includes(REPORT_MARKER) && c.user?.type === "Bot");
    if (mine) return (await this.octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body })).data.id;
    return (await this.octokit.rest.issues.createComment({ owner, repo, issue_number: number, body })).data.id;
  }

  async getCollaboratorPermission(repoFullName: string, user: string): Promise<RepoPermission> {
    const { owner, repo } = splitRepo(repoFullName);
    try {
      const r = await this.octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: user });
      return r.data.permission as RepoPermission;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return "none";
      throw e;
    }
  }

  async getFileAtRef(repoFullName: string, path: string, ref: string): Promise<string | undefined> {
    const { owner, repo } = splitRepo(repoFullName);
    try {
      const r = await this.octokit.rest.repos.getContent({ owner, repo, path, ref, mediaType: { format: "raw" } });
      return typeof r.data === "string" ? r.data : undefined;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return undefined;
      throw e;
    }
  }

  async createBranchFromSha(repoFullName: string, branch: string, sha: string): Promise<void> {
    assertSha(sha);
    if (/^(main|master|develop|production|release\/.*)$/.test(branch) || !branch.startsWith("guardian/")) {
      throw new Error(`Refusing to create or write branch "${branch}": repair branches must start with guardian/`);
    }
    const { owner, repo } = splitRepo(repoFullName);
    try {
      await this.octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });
    } catch (e) {
      if ((e as { status?: number }).status === 422) {
        // Branch exists from an earlier attempt: move it only if it is a guardian/ branch (never a shared one).
        await this.octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha, force: true });
      } else throw e;
    }
  }

  async commitFiles(repoFullName: string, branch: string, message: string, files: FileCommit[]): Promise<string> {
    if (!branch.startsWith("guardian/")) throw new Error("Refusing to commit outside a guardian/ branch");
    const { owner, repo } = splitRepo(repoFullName);
    const ref = await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const parent = ref.data.object.sha;
    const parentCommit = await this.octokit.rest.git.getCommit({ owner, repo, commit_sha: parent });
    const tree = await this.octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: parentCommit.data.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, ...(f.content === null ? { sha: null } : { content: f.content }) })),
    });
    const commit = await this.octokit.rest.git.createCommit({ owner, repo, message, tree: tree.data.sha, parents: [parent] });
    await this.octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
    return commit.data.sha;
  }

  async openPullRequest(repoFullName: string, input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<number> {
    const { owner, repo } = splitRepo(repoFullName);
    const existing = await this.octokit.rest.pulls.list({ owner, repo, head: `${owner}:${input.head}`, state: "open" });
    if (existing.data[0]) return existing.data[0].number;
    return (await this.octokit.rest.pulls.create({ owner, repo, ...input, draft: input.draft ?? true })).data.number;
  }
}
