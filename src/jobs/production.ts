import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { AnthropicSemanticReviewer } from "@/analysis/semantic-review";
import { getEnv } from "@/config/env";
import { getGateway } from "@/github/client";
import type { GuardianDeps } from "@/graph/deps";
import { getStore } from "@/storage";
import { createRepairHook } from "@/repair/repair-controller";
import { dispatchJob } from "./inngest";
import type { PipelineDeps } from "./pipeline";

export const GUARDIAN_VERSION = process.env.npm_package_version ?? "0.1.0";
export const CHECKPOINT_SCHEMA = "guardian_graph";

let saver: PostgresSaver | undefined;

/** Durable LangGraph checkpoints live in a dedicated schema so Supabase's REST API (public schema) never exposes them. */
export function getCheckpointer(): PostgresSaver {
  saver ??= PostgresSaver.fromConnString(getEnv().DATABASE_URL, { schema: CHECKPOINT_SCHEMA });
  return saver;
}

export function dashboardUrl(jobId: string): string | undefined {
  const base = process.env.APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  return base ? `${base}/dashboard/jobs/${jobId}` : undefined;
}

export function pipelineDepsFor(installationId: number): PipelineDeps {
  const env = getEnv();
  const store = getStore();
  const guardian: GuardianDeps = {
    github: getGateway(installationId, "analysis"),
    store,
    reviewer: env.ANTHROPIC_API_KEY ? new AnthropicSemanticReviewer(env.ANTHROPIC_API_KEY, env.GUARDIAN_MODEL) : undefined,
    guardianVersion: GUARDIAN_VERSION,
    now: () => new Date(),
    dashboardUrl,
    enqueue: async (input) => {
      const { job, created } = await store.enqueueJob(input);
      if (created) await dispatchJob(job);
    },
    repair: env.GUARDIAN_REPAIR_ENABLED === "true" ? createRepairHook({ store, gatewayFor: (id) => getGateway(id, "repair"), reviewerKey: env.ANTHROPIC_API_KEY, model: env.GUARDIAN_MODEL }) : undefined,
  };
  return { guardian, checkpointer: getCheckpointer() };
}
