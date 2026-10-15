import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { getGateway } from "@/github/client";
import { dispatchJob } from "@/jobs/inngest";
import { handleWebhook } from "@/jobs/webhook-handler";
import { getStore } from "@/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GitHub App webhook endpoint. Acknowledges quickly: verify signature on the RAW body, persist, enqueue a durable
 * job, return. No analysis ever runs inside this request.
 */
export async function POST(req: Request) {
  let env;
  try {
    env = getEnv();
  } catch {
    // Fail closed: without configuration nothing is accepted, and GitHub will show the failed delivery.
    return NextResponse.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }
  const rawBody = await req.text(); // must be the exact bytes GitHub signed
  const result = await handleWebhook(
    {
      rawBody,
      event: req.headers.get("x-github-event"),
      deliveryId: req.headers.get("x-github-delivery"),
      signature: req.headers.get("x-hub-signature-256"),
    },
    {
      store: getStore(),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      dispatch: (job) => dispatchJob(job),
      gatewayFor: (installationId) => getGateway(installationId, "analysis"),
      repairEnabled: env.GUARDIAN_REPAIR_ENABLED === "true",
    },
  );
  return NextResponse.json(result.body, { status: result.status });
}
