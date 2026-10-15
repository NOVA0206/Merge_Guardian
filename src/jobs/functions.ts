import { getStore } from "@/storage";
import { EVENT_ANALYSIS_REQUESTED, dispatchJob, inngest } from "./inngest";
import { failExhaustedJob, processAnalysisJob } from "./pipeline";
import { pipelineDepsFor } from "./production";

/**
 * Runs one analysis job durably. At most one run per PR at a time; transient failures are retried by
 * Inngest, and when retries are exhausted the required check is failed (never left pending).
 */
export const analyzePullRequest = inngest.createFunction(
  {
    id: "analyze-pull-request",
    triggers: [{ event: EVENT_ANALYSIS_REQUESTED }],
    retries: 2, // + the first run = 3 attempts, matching the job's maxAttempts
    concurrency: [{ key: "event.data.prKey", limit: 1 }],
    onFailure: async ({ event, error }) => {
      const original = (event.data as { event?: { data?: { jobId?: string } } }).event;
      const jobId = original?.data?.jobId;
      if (!jobId) return;
      const job = await getStore().getJob(jobId);
      if (job) await failExhaustedJob(jobId, error.message, pipelineDepsFor(job.installationId));
    },
  },
  async ({ event, step }) => {
    const jobId = (event.data as { jobId: string }).jobId;
    return step.run("process-job", async () => {
      const job = await getStore().getJob(jobId);
      if (!job) return { status: "skipped", reason: "job not found" };
      return processAnalysisJob(jobId, pipelineDepsFor(job.installationId));
    });
  },
);

/**
 * Safety net for lost events and crashed workers: re-dispatch jobs that have sat queued/running too long.
 * Re-dispatch is safe because claiming is atomic and terminal jobs are skipped.
 */
export const sweepStuckJobs = inngest.createFunction(
  { id: "sweep-stuck-jobs", triggers: [{ cron: "*/5 * * * *" }], retries: 1 },
  async ({ step }) => {
    return step.run("redispatch", async () => {
      const stuck = await getStore().listStuckJobs(3);
      const bucket = Math.floor(Date.now() / (10 * 60_000));
      for (const job of stuck) await dispatchJob(job, `sweep-${bucket}`);
      return { redispatched: stuck.map((j) => j.id) };
    });
  },
);

export const functions = [analyzePullRequest, sweepStuckJobs];
