import { config } from "dotenv";

import { runMigrations } from "../lib/migrations";

config({ quiet: true });

/**
 * Vitest global setup: bring the dedicated test database up to date before any
 * test file runs. Tests always use a real Postgres, never mocks.
 */
export default async function setup(): Promise<void> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start the test database with `docker compose up -d` and copy .env.example to .env.",
    );
  }

  const applied = await runMigrations(testDatabaseUrl);
  if (applied.length > 0) {
    console.log(`[tests] applied migrations: ${applied.join(", ")}`);
  }
}
