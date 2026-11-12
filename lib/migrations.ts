import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import { sslForConnectionString } from "./db";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

/**
 * Applies every migrations/*.sql file that has not been recorded yet, in
 * filename order. Each file runs in its own transaction, so a failed migration
 * never leaves a partially applied schema.
 */
export async function runMigrations(connectionString: string): Promise<string[]> {
  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: sslForConnectionString(connectionString),
  });
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (existing.rowCount) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed`, { cause: error });
      }
      applied.push(file);
    }
  } finally {
    client.release();
    await pool.end();
  }

  return applied;
}
