import { beforeEach, describe, expect, it } from "vitest";

import { getPool } from "@/lib/db";
import { minorFromDb } from "@/lib/money";
import { createPayment, depositToAccount, getInvariant, listLedger } from "@/lib/payments";

import { balanceOf, countRows, getDemoAccounts, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

describe("double-entry ledger", () => {
  it("moves exactly the right amount and writes one debit and one credit", async () => {
    const { alice, bob } = await getDemoAccounts();
    const aliceBefore = await balanceOf(alice);
    const bobBefore = await balanceOf(bob);
    const paymentsBefore = await countRows("payments");
    const ledgerBefore = await countRows("ledger_entries");

    const result = await createPayment(
      { from_account_id: alice, to_account_id: bob, amount_minor: 125_000 },
      crypto.randomUUID(),
    );

    expect(result.status).toBe(201);
    const payment = (result.body as { payment: { id: string; amount_minor: number; status: string } }).payment;
    expect(payment.amount_minor).toBe(125_000);
    expect(payment.status).toBe("completed");

    expect(await balanceOf(alice)).toBe(aliceBefore - 125_000);
    expect(await balanceOf(bob)).toBe(bobBefore + 125_000);
    expect(await countRows("payments")).toBe(paymentsBefore + 1);
    expect(await countRows("ledger_entries")).toBe(ledgerBefore + 2);

    const { rows } = await getPool().query<{ direction: string; account_id: string; amount_minor: string }>(
      "SELECT direction, account_id, amount_minor FROM ledger_entries WHERE payment_id = $1 ORDER BY id",
      [payment.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ direction: "debit", account_id: alice });
    expect(rows[1]).toMatchObject({ direction: "credit", account_id: bob });
    expect(minorFromDb(rows[0]?.amount_minor ?? "0")).toBe(125_000);
    expect(minorFromDb(rows[1]?.amount_minor ?? "0")).toBe(125_000);
  });

  it("deposits from the system account increase the target balance", async () => {
    const { carol } = await getDemoAccounts();
    const before = await balanceOf(carol);

    const result = await depositToAccount(carol, { amount_minor: 42_500 });

    expect(result.status).toBe(201);
    expect(await balanceOf(carol)).toBe(before + 42_500);
    const invariant = await getInvariant();
    expect(invariant.balanced).toBe(true);
  });

  it("stays balanced after many random payments", async () => {
    const { alice, bob, carol } = await getDemoAccounts();
    const accounts = [alice, bob, carol];

    // Fund the accounts generously so the random walk exercises successful
    // transfers rather than stopping at the first insufficient balance.
    for (const accountId of accounts) {
      const deposit = await depositToAccount(accountId, { amount_minor: 50_000_000 });
      expect(deposit.status).toBe(201);
    }

    const paymentCount = 40;
    for (let index = 0; index < paymentCount; index += 1) {
      const from = accounts[index % accounts.length] ?? alice;
      const to = accounts[(index + 1) % accounts.length] ?? bob;
      const amountMinor = 1 + ((index * 7_919) % 50_000);
      const result = await createPayment(
        { from_account_id: from, to_account_id: to, amount_minor: amountMinor },
        crypto.randomUUID(),
      );
      expect(result.status).toBe(201);
    }

    const invariant = await getInvariant();
    expect(invariant.total_debits).toBe(invariant.total_credits);
    expect(invariant.balanced).toBe(true);

    const ledger = await listLedger("100");
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    const sumDebits = ledger.entries
      .filter((entry) => entry.direction === "debit")
      .reduce((sum, entry) => sum + entry.amount_minor, 0);
    const sumCredits = ledger.entries
      .filter((entry) => entry.direction === "credit")
      .reduce((sum, entry) => sum + entry.amount_minor, 0);
    expect(sumDebits).toBe(sumCredits);

    const { rows } = await getPool().query<{ debits: string; credits: string }>(`
      SELECT
        COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0)::text AS debits,
        COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)::text AS credits
      FROM ledger_entries
    `);
    expect(minorFromDb(rows[0]?.debits ?? "0")).toBe(minorFromDb(rows[0]?.credits ?? "0"));
    expect(await countRows("ledger_entries")).toBe(6 + accounts.length * 2 + paymentCount * 2);
  });
});
