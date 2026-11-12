import { config } from "dotenv";
import { afterAll } from "vitest";

config({ quiet: true });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Tests require a dedicated Postgres database; start it with `docker compose up -d`.",
  );
}

// The application reads DATABASE_URL. Point it at the test database so a stray
// import can never touch the development or production database.
process.env.DATABASE_URL = testDatabaseUrl;

afterAll(async () => {
  const { closePool } = await import("../lib/db");
  await closePool();
});
