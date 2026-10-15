import { Inngest } from "inngest";
import type { AnalysisJob } from "@/storage/store";

export const EVENT_ANALYSIS_REQUESTED = "guardian/analysis.requested";

/**
 * Inngest provides durable, retried, concurrency-limited execution that survives Vercel function limits.
 * Keys are read from INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY automatically. In production the serve
 * endpoint rejects requests that are not signed by Inngest.
 */
export const inngest = new Inngest({ id: "github-merge-guardian" });

/** Hand a persisted job to the durable runner. `salt` lets the sweeper re-dispatch without being deduplicated. */
export async function dispatchJob(job: AnalysisJob, salt = ""): Promise<void> {
  await inngest.send({
    id: salt ? `${job.id}:${salt}` : job.id,
    name: EVENT_ANALYSIS_REQUESTED,
    data: { jobId: job.id, prKey: `${job.repoFullName}#${job.prNumber}` },
  });
}
