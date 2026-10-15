/**
 * Idempotent schema setup.
 *   DATABASE_URL=... npm run db:migrate
 * 1. Applies src/storage/migrations/*.sql in order, each in a transaction, guarded by an advisory lock
 *    so concurrent runs (e.g. two CI jobs) cannot interleave.
 * 2. Provisions LangGraph's checkpoint tables in the dedicated `guardian_graph` schema and enables row level
 *    security on them (the schema is also outside Supabase's exposed `public` schema).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

const dir = join(__dirname, "..", "src", "storage", "migrations");
const CHECKPOINT_SCHEMA = "guardian_graph";

export async function migrate(connectionString: string, log: (m: string) => void = console.log): Promise<string[]> {
  const ssl = /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString, ssl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727274)");
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name as string));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) {
        log(`skip   ${file}`);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("insert into schema_migrations(name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
        log(`apply  ${file}`);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }

    // LangGraph checkpoint tables (idempotent: the saver tracks its own migrations).
    const saver = PostgresSaver.fromConnString(connectionString, { schema: CHECKPOINT_SCHEMA });
    try {
      await saver.setup();
    } finally {
      await saver.end();
    }
    await client.query(
      `do $$ declare r record; begin
         for r in select tablename from pg_tables where schemaname = '${CHECKPOINT_SCHEMA}' loop
           execute format('alter table ${CHECKPOINT_SCHEMA}.%I enable row level security', r.tablename);
         end loop; end $$`,
    );
    log(`ready  ${CHECKPOINT_SCHEMA} (checkpoints, RLS enabled)`);
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url).then(
    (a) => console.log(a.length ? `Applied ${a.length} migration(s).` : "Schema already up to date."),
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
