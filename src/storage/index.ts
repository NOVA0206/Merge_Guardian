import { ConfigError } from "@/errors";
import { PostgresStore, getPool } from "./postgres";
import type { Store } from "./store";

export type { Store } from "./store";

let store: Store | undefined;

/**
 * The deployed app always uses PostgreSQL. There is intentionally NO in-memory fallback here:
 * if DATABASE_URL is missing the request fails loudly rather than silently losing state.
 */
export function getStore(): Store {
  if (store) return store;
  const url = process.env.DATABASE_URL;
  if (!url) throw new ConfigError("DATABASE_URL is not configured");
  store = new PostgresStore(getPool(url));
  return store;
}

/** Test seam. */
export function setStoreForTests(s: Store | undefined) {
  store = s;
}
