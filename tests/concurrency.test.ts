import { beforeEach, describe, expect, it } from "vitest";

import { getPool } from "@/lib/db";
import {
  createAccount,
  createPayment,
  depositToAccount,
  getInvariant,
  listAccounts,
  setPostPaymentInsertHook,
} from "@/lib/payments";

import { balanceOf, countRows, getDemoAccounts, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
  setPostPaymentInsertHook(null);
});

describe("concurrency safety and correctness", () => {
  it("lets exactly one of two concurrent 70% payments through", async () => {
    const { alice, bob } = await getDemoAccounts();
    const startBalance = await balanceOf(alice);
    const amountMinor = Math.floor((startBalance * 70) / 100);
    const paymentsBefore = await countRows("payments");
    const ledgerBefore = await countRows("ledger_entries");
    const bobBefore = await balanceOf(bob);

    const results = await Promise.all([
      createPayment({ from_account_id: alice, to_account_id: bob, amount_minor: amountMinor }, crypto.randomUUID()),
      createPayment({ from_account_id: alice, to_account_id: bob, amount_minor: amountMinor }, crypto.randomUUID()),
    ]);

    const success = results.filter((result) => result.status === 201);
    const failures = results.filter((result) => result.status === 422);

    expect(success).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ body: { error: { code: "INSUFFICIENT_FUNDS" } } });

    expect(await countRows("payments")).toBe(paymentsBefore + 1);
    expect(await countRows("ledger_entries")).toBe(ledgerBefore + 2);
    expect(await balanceOf(alice)).toBe(startBalance - amountMinor);
    expect(await balanceOf(bob)).toBe(bobBefore + amountMinor);
    expect(await balanceOf(alice)).toBeGreaterThanOrEqual(0);
  });

  it("50 parallel payments with different keys from one sender whose balance covers exactly N: exactly N succeed, balance ends at the correct value, never negative", async () => {
    const { alice, bob } = await getDemoAccounts();
    // Reset Alice's balance to exactly 150_000 by transferring out the difference
    const currentBalance = await balanceOf(alice);
    const targetBalance = 150_000;
    if (currentBalance > targetBalance) {
      await createPayment(
        { from_account_id: alice, to_account_id: bob, amount_minor: currentBalance - targetBalance },
        crypto.randomUUID(),
      );
    }
    expect(await balanceOf(alice)).toBe(150_000);

    const paymentAmount = 10_000;
    const expectedN = 15; // 150,000 / 10,000 = exactly 15

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        createPayment(
          { from_account_id: alice, to_account_id: bob, amount_minor: paymentAmount },
          crypto.randomUUID(),
        ),
      ),
    );

    const success = results.filter((result) => result.status === 201);
    const insufficient = results.filter(
      (result) =>
        result.status === 422 &&
        (result.body as { error?: { code?: string } }).error?.code === "INSUFFICIENT_FUNDS",
    );

    expect(success).toHaveLength(expectedN);
    expect(insufficient).toHaveLength(50 - expectedN);
    expect(await balanceOf(alice)).toBe(0);
    expect(await balanceOf(alice)).toBeGreaterThanOrEqual(0);
  });

  it("handles simultaneous bidirectional transfers (A->B and B->A) with NO deadlocks", async () => {
    const { alice, bob } = await getDemoAccounts();
    // Ensure both Alice and Bob have ample funds
    await depositToAccount(alice, { amount_minor: 500_000 });
    await depositToAccount(bob, { amount_minor: 500_000 });

    const aliceBefore = await balanceOf(alice);
    const bobBefore = await balanceOf(bob);

    // 20 concurrent transfers A -> B and 20 concurrent transfers B -> A, fired simultaneously
    const count = 20;
    const transferAmount = 1_000;

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        createPayment(
          { from_account_id: alice, to_account_id: bob, amount_minor: transferAmount },
          crypto.randomUUID(),
        ),
      );
      promises.push(
        createPayment(
          { from_account_id: bob, to_account_id: alice, amount_minor: transferAmount },
          crypto.randomUUID(),
        ),
      );
    }

    const results = (await Promise.all(promises)) as { status: number }[];
    // All 40 transfers should succeed with 201, zero deadlocks
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await balanceOf(alice)).toBe(aliceBefore);
    expect(await balanceOf(bob)).toBe(bobBefore);
  });

  it("200 random parallel transfers across all accounts: total debits equal total credits, no balance negative, ledger count = 2 * payment count", async () => {
    const { alice, bob, carol } = await getDemoAccounts();
    const daveRes = await createAccount({ name: "Dave" });
    const eveRes = await createAccount({ name: "Eve" });
    const dave = (daveRes.body as { account: { id: string } }).account.id;
    const eve = (eveRes.body as { account: { id: string } }).account.id;

    const allAccountIds = [alice, bob, carol, dave, eve];
    // Generously fund all accounts so payments can flow
    for (const id of allAccountIds) {
      await depositToAccount(id, { amount_minor: 50_000_000 });
    }

    const paymentCount = 200;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < paymentCount; i++) {
      const fromIdx = i % allAccountIds.length;
      let toIdx = (i + 1 + Math.floor(i / allAccountIds.length)) % allAccountIds.length;
      if (fromIdx === toIdx) {
        toIdx = (toIdx + 1) % allAccountIds.length;
      }
      const fromId = allAccountIds[fromIdx]!;
      const toId = allAccountIds[toIdx]!;
      const amount = 1_000 + ((i * 37) % 5_000);

      promises.push(
        createPayment(
          { from_account_id: fromId, to_account_id: toId, amount_minor: amount },
          crypto.randomUUID(),
        ),
      );
    }

    const results = (await Promise.all(promises)) as { status: number }[];
    const successCount = results.filter((r) => r.status === 201).length;
    expect(successCount).toBe(paymentCount);

    // Verify invariants
    const invariant = await getInvariant();
    expect(invariant.total_debits).toBe(invariant.total_credits);
    expect(invariant.balanced).toBe(true);

    // Verify no non-system balance is negative
    const accounts = await listAccounts();
    for (const acc of accounts) {
      if (!acc.is_system) {
        expect(acc.balance_minor).toBeGreaterThanOrEqual(0);
      }
    }

    // Verify number of ledger entries equals 2 times the number of payments
    const paymentsCount = await countRows("payments");
    const ledgerEntriesCount = await countRows("ledger_entries");
    expect(ledgerEntriesCount).toBe(paymentsCount * 2);
  });

  it("Atomicity: injects a failure after payment insert but before ledger insert, verifies nothing persisted and key is not left stuck", async () => {
    const { alice, bob } = await getDemoAccounts();
    const aliceBefore = await balanceOf(alice);
    const bobBefore = await balanceOf(bob);
    const paymentsBefore = await countRows("payments");
    const ledgerBefore = await countRows("ledger_entries");

    const key = crypto.randomUUID();
    const request = { from_account_id: alice, to_account_id: bob, amount_minor: 25_000 };

    // Inject failure between payment insert and ledger insert
    setPostPaymentInsertHook(() => {
      throw new Error("INJECTED_ATOMICITY_FAILURE_BETWEEN_PAYMENT_AND_LEDGER");
    });

    let errorThrown = false;
    try {
      await createPayment(request, key);
    } catch (err: unknown) {
      errorThrown = true;
      expect((err as Error).message).toBe("INJECTED_ATOMICITY_FAILURE_BETWEEN_PAYMENT_AND_LEDGER");
    }
    expect(errorThrown).toBe(true);

    // Verify database state: nothing was persisted, transaction rolled back
    expect(await countRows("payments")).toBe(paymentsBefore);
    expect(await countRows("ledger_entries")).toBe(ledgerBefore);
    expect(await balanceOf(alice)).toBe(aliceBefore);
    expect(await balanceOf(bob)).toBe(bobBefore);

    // Verify idempotency key is NOT left stuck in idempotency_keys table
    const { rows: keyRows } = await getPool().query(
      "SELECT * FROM idempotency_keys WHERE key = $1",
      [key],
    );
    expect(keyRows).toHaveLength(0);

    // Clear injection hook
    setPostPaymentInsertHook(null);

    // Retry with the EXACT SAME KEY and request: must succeed!
    const retryResult = await createPayment(request, key);
    expect(retryResult.status).toBe(201);
    expect(retryResult.replayed).not.toBe(true);

    expect(await countRows("payments")).toBe(paymentsBefore + 1);
    expect(await countRows("ledger_entries")).toBe(ledgerBefore + 2);
    expect(await balanceOf(alice)).toBe(aliceBefore - 25_000);
    expect(await balanceOf(bob)).toBe(bobBefore + 25_000);
  });
});

