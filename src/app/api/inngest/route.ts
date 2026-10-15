import { serve } from "inngest/next";
import { functions } from "@/jobs/functions";
import { inngest } from "@/jobs/inngest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Each Inngest step is a separate invocation; one analysis step must fit in this limit (Vercel Pro: up to 300s). */
export const maxDuration = 300;

// The Inngest SDK verifies request signatures with INNGEST_SIGNING_KEY in production.
export const { GET, POST, PUT } = serve({ client: inngest, functions });
