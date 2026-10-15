import { buildContext, type AnalysisContext } from "@/analysis/context";
import { parseGuardianConfig } from "@/config/guardian-config";
import type { SemanticReviewer } from "@/analysis/semantic-review";
import type { GitHubGateway } from "@/github/gateway";
import type { RepoSnapshot } from "@/repository/snapshot";
import type { Store } from "@/storage/store";
import type { EnqueueInput } from "@/storage/store";
import type { GuardianConfig } from "@/config/guardian-config";

export interface GuardianDeps {
  github: GitHubGateway;
  store: Store;
  /** Optional: when absent the AI step is "skipped" and only deterministic analysis runs. */
  reviewer?: SemanticReviewer;
  guardianVersion: string;
  now: () => Date;
  dashboardUrl?: (jobId: string) => string | undefined;
  /** Enqueue a follow-up analysis (e.g. after a repair lands). */
  enqueue?: (input: EnqueueInput) => Promise<void>;
  /** Repair engine hook; absent when repair is disabled. */
  repair?: (args: { repoFullName: string; prNumber: number; installationId: number; findingId: string; sourceHeadSha: string; requestedBy: string; ctx: AnalysisContext; findings: import("@/reporting/finding-schema").Finding[] }) => Promise<{ status: "proposed" | "failed"; branch?: string; repairPrNumber?: number; sessionId?: string; detail: string }>;
  /** Max time a mandatory CI check may stay missing before the PR is blocked instead of pending. */
  pendingGraceMs?: number;
}

/**
 * Large, rebuildable objects that must NOT go into checkpointed state. Rebuilt from GitHub if the
 * process restarts between a pause and a resume.
 */
export interface RunScope {
  base?: RepoSnapshot;
  head?: RepoSnapshot;
  config?: GuardianConfig;
  ctx?: AnalysisContext;
}

const scopes = new Map<string, RunScope>();
export function getScope(runId: string): RunScope {
  let s = scopes.get(runId);
  if (!s) {
    s = {};
    scopes.set(runId, s);
    // Bound memory in long-lived processes.
    if (scopes.size > 20) scopes.delete(scopes.keys().next().value as string);
  }
  return s;
}
export function dropScope(runId: string) {
  scopes.delete(runId);
}

type RunIdentity = { runId: string; repoFullName: string; baseSha?: string; analyzedSha?: string };

/** Trusted policy config for this run, re-fetched from the BASE revision if the process restarted since it was loaded. */
export async function ensureConfig(deps: GuardianDeps, state: RunIdentity): Promise<GuardianConfig | undefined> {
  const scope = getScope(state.runId);
  if (scope.config) return scope.config;
  if (!state.baseSha) return undefined;
  const base = scope.base ?? (await deps.github.downloadSnapshot(state.repoFullName, state.baseSha));
  scope.base = base;
  scope.config = parseGuardianConfig((p) => base.files.get(p));
  return scope.config;
}

/** Full analysis context (graphs included), rebuilt on demand, e.g. when a repair runs after a resume. */
export async function ensureContext(deps: GuardianDeps, state: RunIdentity): Promise<AnalysisContext | undefined> {
  const scope = getScope(state.runId);
  if (scope.ctx) return scope.ctx;
  if (!state.baseSha || !state.analyzedSha) return undefined;
  const [base, head] = await Promise.all([
    scope.base ?? deps.github.downloadSnapshot(state.repoFullName, state.baseSha),
    scope.head ?? deps.github.downloadSnapshot(state.repoFullName, state.analyzedSha),
  ]);
  scope.base = base;
  scope.head = head;
  scope.config ??= parseGuardianConfig((p) => base.files.get(p));
  scope.ctx = buildContext(base, head, scope.config);
  return scope.ctx;
}
