import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePreviewDeployment, verifyDeployedCommit, type FetchLike } from "@/verification/preview";
import { parseSmokeConfig, runSmoke, summarizeSmoke } from "@/verification/production-smoke";

const SHA = "d".repeat(40);

let server: Server;
let base: string;
let commitServed = SHA;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.url === "/") return send(200, "<h1>Merge Guardian</h1>", "text/html");
    if (req.url === "/api/health") return send(200, { status: "ok", version: "1", commit: commitServed, checks: {} });
    if (req.url === "/api/jobs") return send(401, { error: "unauthenticated" });
    if (req.url === "/leaky") return send(200, "DATABASE_URL=postgres://user:pw@db/x", "text/plain");
    if (req.url === "/slow") return setTimeout(() => send(200, "late"), 300);
    send(404, "nope", "text/plain");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("hosted smoke tests (real HTTP)", () => {
  const cfg = (extra = "") => parseSmokeConfig(`version: 1\nroutes:\n  - { path: /, textIncludes: ["Merge Guardian"] }\n  - { path: /api/health, jsonFields: [status, commit] }\n  - { path: /api/jobs, status: 401 }\n${extra}`);

  it("passes when every route behaves", async () => {
    const results = await runSmoke(base, cfg());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(summarizeSmoke(results).ok).toBe(true);
  });

  it("fails on wrong status, missing route, leaked secrets and slow responses", async () => {
    const results = await runSmoke(base, cfg(`  - { path: /missing }\n  - { path: /leaky, textExcludes: ["postgres://"] }\n  - { path: /slow, timeoutMs: 50 }\n`));
    const byPath = Object.fromEntries(results.map((r) => [r.path, r]));
    expect(byPath["/missing"]!.problems[0]).toMatch(/expected HTTP 200, got 404/);
    expect(byPath["/leaky"]!.problems[0]).toMatch(/forbidden text/);
    expect(byPath["/slow"]!.problems[0]).toMatch(/timed out/);
    expect(summarizeSmoke(results).ok).toBe(false);
  });

  it("reports an unreachable host as a failure, not a pass", async () => {
    const results = await runSmoke("http://127.0.0.1:1", cfg());
    expect(results.every((r) => !r.ok)).toBe(true);
  });
});

describe("Scenario H support: deployment must be the commit under test", () => {
  it("accepts a deployment that serves the expected SHA", async () => {
    commitServed = SHA;
    expect(await verifyDeployedCommit({ url: base, expectedSha: SHA })).toMatchObject({ ok: true });
  });
  it("rejects a healthy deployment of a different (stale) commit", async () => {
    commitServed = "e".repeat(40);
    const r = await verifyDeployedCommit({ url: base, expectedSha: SHA });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stale or wrong deployment/);
  });
});

describe("preview deployment resolution", () => {
  const dep = (over: Record<string, unknown> = {}) => ({ id: 1, sha: SHA, environment: "Preview", creator: { login: "vercel[bot]" }, created_at: "2026-01-01T00:00:00Z", ...over });
  const status = (state: string, url?: string) => ({ state, environment_url: url, created_at: "2026-01-01T00:01:00Z" });
  const fakeFetch = (deployments: unknown[], statuses: Record<number, unknown[]>): FetchLike => async (url) => {
    const m = /deployments\/(\d+)\/statuses/.exec(url);
    return new Response(JSON.stringify(m ? (statuses[Number(m[1])] ?? []) : deployments), { status: 200 });
  };
  const base0 = { repo: "acme/app", sha: SHA, token: "t", intervalMs: 1, sleep: async () => {} };

  it("returns the URL of the successful preview for exactly this commit", async () => {
    const r = await resolvePreviewDeployment({ ...base0, fetchImpl: fakeFetch([dep()], { 1: [status("success", "https://app-git-feature.vercel.app")] }) });
    expect(r).toEqual({ ok: true, url: "https://app-git-feature.vercel.app", deploymentId: 1 });
  });

  it("ignores deployments for other SHAs, other environments and untrusted creators", async () => {
    let t = 0;
    const r = await resolvePreviewDeployment({
      ...base0,
      timeoutMs: 5,
      now: () => (t += 10),
      fetchImpl: fakeFetch([dep({ sha: "f".repeat(40) }), dep({ id: 2, environment: "Production" }), dep({ id: 3, creator: { login: "attacker" } })], { 1: [status("success", "https://x.vercel.app")], 2: [status("success", "https://y.vercel.app")], 3: [status("success", "https://evil.vercel.app")] }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Timed out/);
  });

  it("fails (never succeeds) when the deployment errored or never appeared", async () => {
    expect(await resolvePreviewDeployment({ ...base0, fetchImpl: fakeFetch([dep()], { 1: [status("failure")] }) })).toMatchObject({ ok: false, reason: expect.stringContaining("failure") });
    let t = 0;
    expect(await resolvePreviewDeployment({ ...base0, timeoutMs: 5, now: () => (t += 10), fetchImpl: fakeFetch([], {}) })).toMatchObject({ ok: false });
  });

  it("rejects non-https or malformed deployment URLs", async () => {
    const r = await resolvePreviewDeployment({ ...base0, fetchImpl: fakeFetch([dep()], { 1: [status("success", "javascript:alert(1)")] }) });
    expect(r.ok).toBe(false);
  });
});
