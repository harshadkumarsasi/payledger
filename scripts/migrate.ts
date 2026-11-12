import "dotenv/config";

import { runMigrations } from "../lib/migrations";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exitCode = 1;
    return;
  }

  const applied = await runMigrations(databaseUrl);
  if (applied.length === 0) {
    console.log("Database is already up to date.");
    return;
  }
  console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});
