/**
 * Full local stack for end-to-end tests, using the PRODUCTION build:
 *   real PostgreSQL 17 (embedded-postgres) + real migrations  ->  mock GitHub API  ->  Inngest dev server  ->  `next start`
 * Playwright's webServer launches this and waits for http://localhost:3100/api/health to report ready.
 */
import { generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "../../../scripts/migrate";
import { startMockGitHub } from "./mock-github";
import { startTestPostgres } from "./postgres";

export const PORTS = { app: 3100, db: 54329, github: 54330, inngest: 8288 } as const;
export const WEBHOOK_SECRET = "e2e-webhook-secret-0123456789";
const root = path.resolve(__dirname, "../../..");

const children: ChildProcess[] = [];
const killAll = () => {
  for (const c of children) {
    try {
      if (process.platform === "win32" && c.pid) spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
};

async function waitFor(url: string, ms: number, ok = (r: Response) => r.ok): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (ok(await fetch(url))) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main() {
  const pgServer = await startTestPostgres(PORTS.db);
  const DATABASE_URL = pgServer.url;
  await migrate(DATABASE_URL, () => undefined);

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

  if (!existsSync(path.join(root, ".next", "BUILD_ID"))) throw new Error("Run `npm run build` before the end-to-end tests (they exercise the production build).");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production" as const,
    PORT: String(PORTS.app),
    APP_URL: `http://localhost:${PORTS.app}`,
    DATABASE_URL,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_CLIENT_ID: "Iv1.e2e",
    GITHUB_APP_CLIENT_SECRET: "e2e-client-secret",
    SESSION_SECRET: "e2e-session-secret-that-is-at-least-32-chars",
    GITHUB_API_URL: `http://127.0.0.1:${PORTS.github}`,
    GITHUB_WEB_URL: `http://127.0.0.1:${PORTS.github}`,
    GUARDIAN_ALLOW_INSECURE_GITHUB_URL: "1",
    INNGEST_DEV: `http://127.0.0.1:${PORTS.inngest}`,
    INNGEST_EVENT_KEY: "e2e",
    ANTHROPIC_API_KEY: "",
    VERCEL_GIT_COMMIT_SHA: "c0ffee".repeat(6) + "c0ff",
    NEXT_PUBLIC_GITHUB_APP_SLUG: "guardian-e2e",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  const next = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORTS.app)], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
  children.push(next);
  await waitFor(`http://localhost:${PORTS.app}/api/health`, 60_000);

  const inngestBin = path.join(root, "node_modules", "inngest-cli", "bin", process.platform === "win32" ? "inngest.exe" : "inngest");
  const inngest = spawn(inngestBin, ["dev", "-u", `http://localhost:${PORTS.app}/api/inngest`, "--no-discovery", "--port", String(PORTS.inngest)], { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
  children.push(inngest);
  await waitFor(`http://127.0.0.1:${PORTS.inngest}/`, 60_000);
  // Register the app's functions with the dev server.
  await fetch(`http://localhost:${PORTS.app}/api/inngest`, { method: "PUT" }).catch(() => undefined);

  // Started LAST: Playwright treats the mock's endpoint as the "whole stack is ready" signal.
  const gh = await startMockGitHub(PORTS.github);
  console.log(`e2e stack ready: app=${PORTS.app} db=${PORTS.db} github=${PORTS.github} inngest=${PORTS.inngest}`);

  const shutdown = async () => {
    killAll();
    await gh.stop().catch(() => undefined);
    await pgServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  next.on("exit", (code) => {
    console.error(`next exited (${code})`);
    void shutdown();
  });
}

main().catch((e) => {
  console.error(e);
  killAll();
  process.exit(1);
});
process.on("exit", killAll);
