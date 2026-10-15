import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { buildGuardianGraph } from "@/graph/guardian-graph";
import type { GuardianDeps } from "@/graph/deps";
import { guardianInputSchema, type GuardianInput, type GuardianStateType } from "@/graph/state";

export interface RunOutcome {
  state: GuardianStateType;
  /** True when the graph paused at an interrupt (approval / awaiting commit) and can be resumed. */
  interrupted: boolean;
  interruptValue?: unknown;
}

/** Stable per-revision thread: a new head SHA is, by construction, a fresh workflow with no inherited approvals. */
export function threadIdFor(i: Pick<GuardianInput, "repoFullName" | "prNumber" | "expectedHeadSha">): string {
  return `${i.repoFullName}#${i.prNumber}@${i.expectedHeadSha}`;
}

const RECURSION_LIMIT = 60;

export async function runGuardian(rawInput: unknown, deps: GuardianDeps, checkpointer?: BaseCheckpointSaver): Promise<RunOutcome> {
  const input = guardianInputSchema.parse(rawInput);
  const graph = buildGuardianGraph(deps, checkpointer);
  const config = { configurable: { thread_id: threadIdFor(input) }, recursionLimit: RECURSION_LIMIT };

  // A paused thread for this exact revision? Resume it instead of starting over.
  if (checkpointer) {
    const snap = await graph.getState(config);
    if (snap.next.length > 0) {
      // The resume payload carries no authority: approvals are re-read from GitHub inside the graph.
      // Re-bind job/run ids so the resumed run reports against THIS job, with a fresh scope.
      const update = { jobId: input.jobId, runId: input.runId, trigger: input.trigger, startedAt: deps.now().toISOString() };
      return toOutcome(await graph.invoke(new Command({ resume: { at: deps.now().toISOString() }, update }), config));
    }
    if (snap.values && Object.keys(snap.values).length > 0 && snap.next.length === 0) {
      // Completed earlier for this SHA: start a fresh run on a new run id but re-use nothing from the old state.
      config.configurable.thread_id = `${threadIdFor(input)}:${input.runId}`;
    }
  }

  const result = await graph.invoke(
    {
      repoFullName: input.repoFullName,
      installationId: input.installationId,
      prNumber: input.prNumber,
      jobId: input.jobId,
      runId: input.runId,
      trigger: input.trigger,
      expectedHeadSha: input.expectedHeadSha,
      startedAt: deps.now().toISOString(),
      repair: { requested: input.repairRequested, sessionId: input.repairSessionId, attempts: 0, status: "none" as const },
    },
    config,
  );
  return toOutcome(result);
}

function toOutcome(result: GuardianStateType & { __interrupt__?: Array<{ value: unknown }> }): RunOutcome {
  const intr = result.__interrupt__;
  return { state: result, interrupted: Boolean(intr?.length), interruptValue: intr?.[0]?.value };
}
