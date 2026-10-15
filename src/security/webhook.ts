import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthError } from "@/errors";

/** Verify GitHub's `X-Hub-Signature-256` against the RAW request body. Throws on any mismatch. */
export function verifyGitHubSignature(rawBody: string, signatureHeader: string | null, secret: string): void {
  if (!secret) throw new AuthError("Webhook secret is not configured", 500);
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) throw new AuthError("Missing webhook signature");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AuthError("Invalid webhook signature");
  }
}

export function signGitHubPayload(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
