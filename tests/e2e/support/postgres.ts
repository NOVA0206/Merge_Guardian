import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TestPostgres {
  url: string;
  stop(): Promise<void>;
}

/**
 * A real PostgreSQL server (official binaries via `embedded-postgres`) on a throwaway data directory.
 * Real processes per connection, so the app's pool and LangGraph's checkpointer behave exactly as in production.
 */
export async function startTestPostgres(port: number): Promise<TestPostgres> {
  const dir = mkdtempSync(path.join(tmpdir(), "guardian-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await pg.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
