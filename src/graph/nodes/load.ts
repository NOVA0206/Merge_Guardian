import { analyzeImpact } from "@/analysis/impact-analysis";
import { buildContext } from "@/analysis/context";
import { parseGuardianConfig } from "@/config/guardian-config";
import { computeChangeSet } from "@/repository/diff-parser";
import { sanitizeText } from "@/security/input-sanitization";
import type { GuardianDeps } from "../deps";
import { getScope } from "../deps";
import { guarded } from "./helpers";

export const loadPullRequest = (deps: GuardianDeps) =>
  guarded("loadPullRequest", async (state) => {
    const pr = await deps.github.getPullRequest(state.repoFullName, state.prNumber);
    const summary = {
      author: pr.author,
      title: sanitizeText(pr.title, 300),
      body: sanitizeText(pr.body, 3000),
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      headSha: pr.headSha,
      isFork: pr.isFork,
      draft: pr.draft,
      state: pr.state,
    };
    if (pr.headSha !== state.expectedHeadSha) {
      // The PR moved since this job was queued: this analysis can never satisfy the check.
      return { pr: summary, workflowStatus: "stale" };
    }
    if (pr.state === "closed") return { pr: summary, workflowStatus: "complete" };
    const rev = await deps.github.resolveRevisions(state.repoFullName, pr);
    return { pr: summary, baseSha: rev.baseSha, analyzedSha: rev.analyzedSha, candidateSha: rev.candidateSha, mergeConflict: rev.conflict };
  });

export const loadArchitectureBaseline = (deps: GuardianDeps) =>
  guarded("loadArchitectureBaseline", async (state) => {
    if (!state.baseSha || !state.analyzedSha) return {};
    const scope = getScope(state.runId);
    const [base, head] = await Promise.all([
      scope.base ?? deps.github.downloadSnapshot(state.repoFullName, state.baseSha),
      scope.head ?? deps.github.downloadSnapshot(state.repoFullName, state.analyzedSha),
    ]);
    scope.base = base;
    scope.head = head;
    // Trusted configuration always comes from the BASE revision, never from the PR under review.
    const config = parseGuardianConfig((p) => base.files.get(p));
    scope.config = config;
    return { policyVersion: config.version, baselineReviewed: config.architecture.reviewed };
  });

export const parseDiff = (_deps: GuardianDeps) =>
  guarded("parseDiff", async (state) => {
    const scope = getScope(state.runId);
    if (!scope.base || !scope.head) return {};
    const changes = computeChangeSet(scope.base, scope.head);
    scope.ctx = buildContext(scope.base, scope.head, scope.config, changes);
    return { filesChanged: changes.files.length };
  });

export const buildImpactGraph = (_deps: GuardianDeps) =>
  guarded("buildImpactGraph", async (state) => {
    const ctx = getScope(state.runId).ctx;
    if (!ctx) return {};
    return { impact: analyzeImpact(ctx) };
  });
