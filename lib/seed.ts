import type { PoolClient } from "pg";

/**
 * Demo data. Balances are funded from the system account, so every seeded
 * rupee already has a matching double-entry pair when the dashboard loads.
 */
export const SYSTEM_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
export const SYSTEM_ACCOUNT_NAME = "External Funding";
export const DEMO_CURRENCY = "INR";

export type DemoSeed = {
  name: string;
  amountMinor: number;
};

export const DEMO_SEED: readonly DemoSeed[] = [
  { name: "Alice", amountMinor: 500_000 }, // ₹5,000.00
  { name: "Bob", amountMinor: 250_000 }, // ₹2,500.00
  { name: "Carol", amountMinor: 100_000 }, // ₹1,000.00
];

/**
 * Caller owns the transaction. Truncates the demo world and recreates the
 * system account plus the three funded demo accounts.
 */
export async function seedDemoData(client: PoolClient): Promise<void> {
  await client.query("TRUNCATE TABLE ledger_entries, payments, idempotency_keys, accounts RESTART IDENTITY");

  await client.query(
    `INSERT INTO accounts (id, name, currency, is_system)
     VALUES ($1, $2, $3, true)`,
    [SYSTEM_ACCOUNT_ID, SYSTEM_ACCOUNT_NAME, DEMO_CURRENCY],
  );

  for (const demo of DEMO_SEED) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO accounts (name, currency)
       VALUES ($1, $2)
       RETURNING id`,
      [demo.name, DEMO_CURRENCY],
    );
    const account = inserted.rows[0];
    if (!account) throw new Error(`Failed to insert demo account ${demo.name}`);

    const payment = await client.query<{ id: string }>(
      `INSERT INTO payments (from_account_id, to_account_id, amount_minor, currency)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [SYSTEM_ACCOUNT_ID, account.id, demo.amountMinor, DEMO_CURRENCY],
    );
    const paymentId = payment.rows[0]?.id;
    if (!paymentId) throw new Error(`Failed to insert funding payment for ${demo.name}`);

    await client.query(
      `INSERT INTO ledger_entries (payment_id, account_id, direction, amount_minor)
       VALUES ($1, $2, 'debit', $3), ($1, $4, 'credit', $3)`,
      [paymentId, SYSTEM_ACCOUNT_ID, demo.amountMinor, account.id],
    );
  }
}
