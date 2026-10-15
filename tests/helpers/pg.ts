import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PostgresStore } from "@/storage/postgres";

/** Real PostgreSQL (WASM) with the production migrations applied: verifies SQL without external credentials. */
export async function makePgliteStore() {
  const db = new PGlite();
  const dir = path.resolve(import.meta.dirname, "../../src/storage/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(path.join(dir, f), "utf8"));
  const adapter = {
    query: async (text: string, params?: unknown[]) => {
      const r = await db.query(text, params as any[]);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  return { db, store: new PostgresStore(adapter as any) };
}
