import { Pool, type PoolConfig } from "pg";

/**
 * The app uses a single small pool per server instance. Neon's pooled
 * connection string is safe here; Vercel may run many instances, each capped
 * at five connections.
 */
type DbGlobal = typeof globalThis & { payledgerPool?: Pool };

const dbGlobal = globalThis as DbGlobal;

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }
  return url;
}

/**
 * libpq-style SSL behaviour: local connections are plaintext by default,
 * hosted connections are encrypted. `sslmode=disable` turns SSL off explicitly.
 * Managed Postgres providers such as Neon present valid certificates, so we
 * still verify them for verify-full/verify-ca.
 */
export function sslForConnectionString(connectionString: string): PoolConfig["ssl"] {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return { rejectUnauthorized: false };
  }

  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode === "disable") return undefined;

  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!sslmode && isLocal) return undefined;

  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

export function createPool(connectionString: string, max = 5): Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslForConnectionString(connectionString),
  });
  pool.on("error", (error) => {
    console.error("[db] idle client error", error);
  });
  return pool;
}

export function getPool(): Pool {
  if (!dbGlobal.payledgerPool) {
    dbGlobal.payledgerPool = createPool(getDatabaseUrl());
  }
  return dbGlobal.payledgerPool;
}

/** Used by tests and one-off scripts so the process can exit cleanly. */
export async function closePool(): Promise<void> {
  if (!dbGlobal.payledgerPool) return;
  const pool = dbGlobal.payledgerPool;
  dbGlobal.payledgerPool = undefined;
  await pool.end();
}
