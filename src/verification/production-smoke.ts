import { z } from "zod";
import YAML from "yaml";
import type { FetchLike } from "./preview";

export const smokeConfigSchema = z.object({
  version: z.literal(1),
  routes: z
    .array(
      z.object({
        path: z.string().startsWith("/"),
        method: z.enum(["GET", "HEAD"]).default("GET"),
        /** Expected HTTP status; 401/403 are valid for routes that must reject anonymous callers. */
        status: z.number().int().default(200),
        /** For JSON routes: top-level fields that must exist. */
        jsonFields: z.array(z.string()).default([]),
        textIncludes: z.array(z.string()).default([]),
        /** Must not appear in the response (e.g. stack traces, env dumps). */
        textExcludes: z.array(z.string()).default([]),
        timeoutMs: z.number().int().positive().default(10_000),
      }),
    )
    .min(1),
});
export type SmokeConfig = z.infer<typeof smokeConfigSchema>;

export interface SmokeResult {
  path: string;
  ok: boolean;
  status?: number;
  ms: number;
  problems: string[];
}

export function parseSmokeConfig(yamlText: string): SmokeConfig {
  return smokeConfigSchema.parse(YAML.parse(yamlText));
}

export async function runSmoke(baseUrl: string, cfg: SmokeConfig, opts: { fetchImpl?: FetchLike; headers?: Record<string, string> } = {}): Promise<SmokeResult[]> {
  const f = opts.fetchImpl ?? fetch;
  const results: SmokeResult[] = [];
  for (const r of cfg.routes) {
    const started = Date.now();
    const problems: string[] = [];
    let status: number | undefined;
    try {
      const res = await f(baseUrl.replace(/\/$/, "") + r.path, { method: r.method, headers: opts.headers, redirect: "manual", signal: AbortSignal.timeout(r.timeoutMs) });
      status = res.status;
      if (res.status !== r.status) problems.push(`expected HTTP ${r.status}, got ${res.status}`);
      if (r.method === "GET" && (r.jsonFields.length || r.textIncludes.length || r.textExcludes.length)) {
        const text = await res.text();
        for (const t of r.textIncludes) if (!text.includes(t)) problems.push(`response is missing expected text "${t}"`);
        for (const t of r.textExcludes) if (text.includes(t)) problems.push(`response contains forbidden text "${t}"`);
        if (r.jsonFields.length) {
          try {
            const json = JSON.parse(text) as Record<string, unknown>;
            for (const field of r.jsonFields) if (!(field in json)) problems.push(`JSON field "${field}" is missing`);
          } catch {
            problems.push("response is not valid JSON");
          }
        }
      }
    } catch (e) {
      problems.push(`request failed: ${(e as Error).name === "TimeoutError" ? `timed out after ${r.timeoutMs}ms` : (e as Error).message}`);
    }
    results.push({ path: r.path, ok: problems.length === 0, status, ms: Date.now() - started, problems });
  }
  return results;
}

export function summarizeSmoke(results: readonly SmokeResult[]): { ok: boolean; markdown: string } {
  const ok = results.every((r) => r.ok);
  const lines = results.map((r) => `| \`${r.path}\` | ${r.ok ? "PASS" : "**FAIL**"} | ${r.status ?? "-"} | ${r.ms}ms | ${r.problems.join("; ") || ""} |`);
  return { ok, markdown: ["| Route | Result | Status | Time | Problems |", "|---|---|---|---|---|", ...lines].join("\n") };
}
