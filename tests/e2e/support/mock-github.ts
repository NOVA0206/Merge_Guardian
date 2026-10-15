/**
 * Minimal GitHub REST/OAuth API double for end-to-end tests. It implements only what Guardian calls, records every write,
 * and exposes /__mock/* control endpoints so tests can script pull requests, CI results, reviews and outages.
 * It is test infrastructure: it never runs in production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { zipSync, strToU8 } from "fflate";
import path from "node:path";
import { snapshotFromDirectory } from "../../../src/repository/snapshot";

interface MockPr {
  number: number;
  state: "open" | "closed";
  headSha: string;
  baseSha: string;
  headRef: string;
  author: string;
  /** path -> content (null deletes) applied on top of the fixture app for this head */
  overlay: Record<string, string | null>;
}

interface MockCheck {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  output?: { title?: string; summary?: string };
  started_at: string;
  html_url?: string;
}

export interface MockGitHub {
  server: Server;
  port: number;
  stop(): Promise<void>;
}

export async function startMockGitHub(port: number): Promise<MockGitHub> {
  const fixture = snapshotFromDirectory("0".repeat(40), path.resolve(__dirname, "../../fixtures/app-base"));
  const repo = { id: 1, full_name: "acme/app", default_branch: "main" };
  const state = {
    prs: new Map<number, MockPr>(),
    reviews: [] as Array<{ id: number; user: { login: string }; state: string; commit_id: string; submitted_at: string }>,
    checks: [] as MockCheck[],
    comments: [] as Array<{ id: number; issue: number; body: string; user: { login: string; type: string } }>,
    permissions: {} as Record<string, string>,
    requests: [] as Array<{ method: string; path: string }>,
    failNext: 0,
    failStatus: 502,
    nextId: 5000,
    deploymentEvents: [] as unknown[],
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

  const filesFor = (sha: string): Map<string, string> | undefined => {
    const files = new Map(fixture.files);
    if (sha === "a".repeat(40)) return files; // base
    const pr = [...state.prs.values()].find((p) => p.headSha === sha);
    if (!pr) return undefined;
    for (const [p, c] of Object.entries(pr.overlay)) c === null ? files.delete(p) : files.set(p, c);
    return files;
  };

  const prJson = (pr: MockPr) => ({
    number: pr.number,
    state: pr.state,
    draft: false,
    title: `PR ${pr.number}`,
    body: "",
    user: { login: pr.author },
    mergeable: true,
    merge_commit_sha: null,
    base: { ref: "main", sha: pr.baseSha, repo },
    head: { ref: pr.headRef, sha: pr.headSha, repo },
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? "" : await readBody(req);
    const data = body ? (JSON.parse(body) as Record<string, any>) : {};

    /* ---------- control plane ---------- */
    if (p.startsWith("/__mock/")) {
      if (p === "/__mock/reset") {
        state.prs.clear(); state.reviews = []; state.checks = []; state.comments = []; state.requests = []; state.failNext = 0; state.permissions = {};
        return json(res, 200, { ok: true });
      }
      if (p === "/__mock/pr") {
        state.prs.set(data.number, { number: data.number, state: data.state ?? "open", headSha: data.headSha, baseSha: "a".repeat(40), headRef: data.headRef ?? "feature/dev-one-change", author: data.author ?? "dev-one", overlay: data.overlay ?? {} });
        return json(res, 200, { ok: true });
      }
      if (p === "/__mock/ci") {
        for (const name of data.names ?? ["lint", "typecheck", "unit-tests", "build"]) {
          state.checks = state.checks.filter((c) => !(c.name === name && c.head_sha === data.sha));
          state.checks.push({ id: state.nextId++, name, head_sha: data.sha, status: data.status ?? "completed", conclusion: data.status === "in_progress" ? null : (data.conclusion ?? "success"), started_at: new Date().toISOString() });
        }
        return json(res, 200, { ok: true });
      }
      if (p === "/__mock/review") {
        state.reviews.push({ id: state.nextId++, user: { login: data.user }, state: data.state, commit_id: data.commitId, submitted_at: new Date().toISOString() });
        return json(res, 200, { ok: true });
      }
      if (p === "/__mock/permission") {
        state.permissions[data.user] = data.permission;
        return json(res, 200, { ok: true });
      }
      if (p === "/__mock/fail-next") {
        state.failNext = data.count ?? 1;
        state.failStatus = data.status ?? 502;
        return json(res, 200, { ok: true });
      }
      if (p === "/__mock/recorded") {
        const guardianChecks = state.checks.filter((c) => c.name === "Guardian / architecture");
        return json(res, 200, { checks: guardianChecks, comments: state.comments, requests: state.requests });
      }
      return json(res, 404, { message: "unknown control endpoint" });
    }

    /* ---------- OAuth (web) ---------- */
    if (p === "/login/oauth/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "mock-code");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (p === "/login/oauth/access_token") return json(res, 200, { access_token: "mock-user-token", token_type: "bearer" });
    if (p === "/user") return json(res, 200, { login: "dev-one", id: 4242 });
    if (p === "/user/installations") return json(res, 200, { total_count: 1, installations: [{ id: 99 }] });

    /* ---------- REST API ---------- */
    state.requests.push({ method, path: p });
    if (p.startsWith("/repos/") && state.failNext > 0) {
      state.failNext--;
      return json(res, state.failStatus, { message: "mock outage" });
    }

    let m: RegExpExecArray | null;
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === "POST") {
      return json(res, 201, { token: "ghs_mocktoken", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: "all" });
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(p))) return json(res, 200, { id: Number(m[1]), account: { login: "acme", type: "Organization" }, target_type: "Organization", suspended_at: null });
    if (p === "/installation/repositories") return json(res, 200, { total_count: 1, repositories: [repo] });

    if ((m = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(p))) {
      const pr = state.prs.get(Number(m[1]));
      return pr ? json(res, 200, prJson(pr)) : json(res, 404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/acme\/app\/pulls\/(\d+)\/reviews$/.exec(p))) return json(res, 200, state.reviews);
    if ((m = /^\/repos\/acme\/app\/compare\/(.+)$/.exec(p))) return json(res, 200, { merge_base_commit: { sha: "a".repeat(40) } });
    if ((m = /^\/repos\/acme\/app\/zipball\/([0-9a-f]{40})$/.exec(p))) {
      const files = filesFor(m[1]!);
      if (!files) return json(res, 404, { message: "Not Found" });
      const entries: Record<string, Uint8Array> = {};
      for (const [fp, content] of files) entries[`acme-app-${m[1]!.slice(0, 7)}/${fp}`] = strToU8(content);
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(Buffer.from(zipSync(entries)));
    }
    if ((m = /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p))) {
      const runs = state.checks.filter((c) => c.head_sha === m![1]);
      return json(res, 200, { total_count: runs.length, check_runs: runs });
    }
    if (p === "/repos/acme/app/check-runs" && method === "POST") {
      const c: MockCheck = { id: state.nextId++, name: data.name, head_sha: data.head_sha, status: data.status, conclusion: data.conclusion ?? null, output: data.output, started_at: new Date().toISOString(), html_url: data.details_url };
      state.checks.push(c);
      return json(res, 201, c);
    }
    if ((m = /^\/repos\/acme\/app\/check-runs\/(\d+)$/.exec(p)) && method === "PATCH") {
      const c = state.checks.find((x) => x.id === Number(m![1]));
      if (!c) return json(res, 404, { message: "Not Found" });
      Object.assign(c, { status: data.status ?? c.status, conclusion: data.conclusion ?? null, output: data.output ?? c.output });
      return json(res, 200, c);
    }
    if ((m = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(p))) {
      if (method === "GET") return json(res, 200, state.comments.filter((c) => c.issue === Number(m![1])));
      const c = { id: state.nextId++, issue: Number(m[1]), body: data.body, user: { login: "guardian[bot]", type: "Bot" } };
      state.comments.push(c);
      return json(res, 201, c);
    }
    if ((m = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(p)) && method === "PATCH") {
      const c = state.comments.find((x) => x.id === Number(m![1]));
      if (!c) return json(res, 404, { message: "Not Found" });
      c.body = data.body;
      return json(res, 200, c);
    }
    if ((m = /^\/repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const permission = state.permissions[m[1]!] ?? "none";
      return permission === "none" ? json(res, 404, { message: "Not Found" }) : json(res, 200, { permission });
    }
    return json(res, 404, { message: `mock: no handler for ${method} ${p}` });
  });

  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { server, port, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
