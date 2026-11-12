import { getPool } from "@/lib/db";
import { minorFromDb } from "@/lib/money";
import { SYSTEM_ACCOUNT_ID, seedDemoData } from "@/lib/seed";

export { SYSTEM_ACCOUNT_ID };

export async function resetDatabase(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await seedDemoData(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type DemoAccounts = {
  alice: string;
  bob: string;
  carol: string;
};

export async function getDemoAccounts(): Promise<DemoAccounts> {
  const { rows } = await getPool().query<{ id: string; name: string }>(
    "SELECT id, name FROM accounts WHERE NOT is_system",
  );
  const byName = new Map(rows.map((row) => [row.name, row.id]));
  const alice = byName.get("Alice");
  const bob = byName.get("Bob");
  const carol = byName.get("Carol");
  if (!alice || !bob || !carol) throw new Error("Demo accounts are missing; reset the test database");
  return { alice, bob, carol };
}

export async function balanceOf(accountId: string): Promise<number> {
  const { rows } = await getPool().query<{ balance_minor: string }>(
    `SELECT COALESCE(
       SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END),
       0
     )::text AS balance_minor
     FROM ledger_entries
     WHERE account_id = $1`,
    [accountId],
  );
  return minorFromDb(rows[0]?.balance_minor ?? "0");
}

const COUNTABLE_TABLES = new Set(["accounts", "payments", "ledger_entries", "idempotency_keys"]);

export async function countRows(table: "accounts" | "payments" | "ledger_entries" | "idempotency_keys"): Promise<number> {
  if (!COUNTABLE_TABLES.has(table)) throw new Error(`Unsupported table: ${table}`);
  const { rows } = await getPool().query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
  return minorFromDb(rows[0]?.count ?? "0");
}
