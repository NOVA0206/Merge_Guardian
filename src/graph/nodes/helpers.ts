import { isGraphBubbleUp } from "@langchain/langgraph";
import { isTransientError } from "@/errors";
import { safeErrorMessage } from "@/security/secret-redaction";
import type { GuardianStateType, GuardianUpdate } from "../state";

export type NodeFn = (state: GuardianStateType) => Promise<GuardianUpdate>;

/**
 * Uniform failure handling for every node:
 *  - transient errors (network, 5xx, rate limit) are re-thrown so the durable job layer retries the whole run;
 *  - permanent errors are recorded in state and the run proceeds to a fail-closed ERROR decision;
 *  - after the first recorded error, analysis nodes are skipped (they would only cascade the failure).
 */
export function guarded(name: string, fn: NodeFn, opts: { runOnError?: boolean } = {}): NodeFn {
  return async (state) => {
    if (state.errors.length > 0 && !opts.runOnError) return {};
    if (state.workflowStatus === "stale" && !opts.runOnError) return {};
    try {
      return await fn(state);
    } catch (err) {
      // Interrupts (pause for approval) are control flow, not failures.
      if (isGraphBubbleUp(err) || isTransientError(err)) throw err;
      return { errors: [`${name}: ${safeErrorMessage(err)}`], workflowStatus: "error" };
    }
  };
}
