/**
 * Throwaway real PostgreSQL server for local development (official binaries via `embedded-postgres`).
 *   tsx scripts/dev-db.ts [port]
 * Then:  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres npm run db:migrate
 * Data lives in a temp directory and is deleted on exit. NOT for production.
 */
import { startTestPostgres } from "../tests/e2e/support/postgres";

async function main() {
  const port = Number(process.argv[2] ?? 54329);
  const pg = await startTestPostgres(port);
  console.log(`dev database listening on ${pg.url}`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
