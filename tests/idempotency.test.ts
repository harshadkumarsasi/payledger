import { beforeEach, describe, expect, it } from "vitest";

import { createPayment } from "@/lib/payments";

import { balanceOf, countRows, getDemoAccounts, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

describe("idempotency", () => {
  it("replays the identical response without creating a second payment", async () => {
    const { alice, bob } = await getDemoAccounts();
    const key = crypto.randomUUID();
    const request = { from_account_id: alice, to_account_id: bob, amount_minor: 25_000 };

    const first = await createPayment(request, key);
    const aliceAfterFirst = await balanceOf(alice);
    const paymentsAfterFirst = await countRows("payments");
    const ledgerAfterFirst = await countRows("ledger_entries");

    const second = await createPayment(request, key);

    expect(first.status).toBe(201);
    expect(first.replayed).not.toBe(true);
    expect(second.status).toBe(201);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(await countRows("payments")).toBe(paymentsAfterFirst);
    expect(await countRows("ledger_entries")).toBe(ledgerAfterFirst);
    expect(await balanceOf(alice)).toBe(aliceAfterFirst);
  });

  it("treats reordered JSON keys as the same request", async () => {
    const { alice, bob } = await getDemoAccounts();
    const key = crypto.randomUUID();

    const first = await createPayment({ from_account_id: alice, to_account_id: bob, amount_minor: 1_000 }, key);
    const second = await createPayment({ amount_minor: 1_000, to_account_id: bob, from_account_id: alice }, key);

    expect(first.status).toBe(201);
    // Replays preserve the original status code; the header is the signal.
    expect(second.status).toBe(201);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
  });

  it("rejects the same key with a different body", async () => {
    const { alice, bob } = await getDemoAccounts();
    const key = crypto.randomUUID();

    await createPayment({ from_account_id: alice, to_account_id: bob, amount_minor: 10_000 }, key);
    const paymentsBefore = await countRows("payments");
    const aliceBefore = await balanceOf(alice);

    const conflicting = await createPayment(
      { from_account_id: alice, to_account_id: bob, amount_minor: 20_000 },
      key,
    );

    expect(conflicting.status).toBe(422);
    expect(conflicting).toMatchObject({
      body: { error: { code: "IDEMPOTENCY_KEY_REUSED" } },
    });
    expect(await countRows("payments")).toBe(paymentsBefore);
    expect(await balanceOf(alice)).toBe(aliceBefore);
  });

  it("creates exactly one payment for 20 identical parallel requests", async () => {
    const { alice, bob } = await getDemoAccounts();
    const key = crypto.randomUUID();
    const request = { from_account_id: alice, to_account_id: bob, amount_minor: 30_000 };
    const paymentsBefore = await countRows("payments");
    const ledgerBefore = await countRows("ledger_entries");

    const results = await Promise.all(Array.from({ length: 20 }, () => createPayment(request, key)));

    const created = results.filter((result) => result.status === 201 && !result.replayed);
    const replayed = results.filter((result) => result.replayed);
    const others = results.filter((result) => !(result.status === 201 || result.replayed));

    expect(others).toEqual([]);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(19);
    expect(await countRows("payments")).toBe(paymentsBefore + 1);
    expect(await countRows("ledger_entries")).toBe(ledgerBefore + 2);

    const ids = new Set(
      results.map((result) => (result.body as { payment: { id: string } }).payment.id),
    );
    expect(ids.size).toBe(1);
    for (const result of replayed) {
      expect(result.body).toEqual(created[0]?.body);
    }
  });

  it("requires an Idempotency-Key", async () => {
    const { alice, bob } = await getDemoAccounts();
    const result = await createPayment(
      { from_account_id: alice, to_account_id: bob, amount_minor: 100 },
      null,
    );
    expect(result.status).toBe(400);
    expect(result).toMatchObject({ body: { error: { code: "MISSING_IDEMPOTENCY_KEY" } } });
  });
});
