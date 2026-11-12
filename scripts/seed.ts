import "dotenv/config";

import { closePool, getPool } from "../lib/db";
import { seedDemoData } from "../lib/seed";

async function main(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await seedDemoData(client);
    await client.query("COMMIT");
    console.log("Seeded Alice, Bob, Carol, and the External Funding system account.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
