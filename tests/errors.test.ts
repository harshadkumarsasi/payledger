import { beforeEach, describe, expect, it } from "vitest";

import { createPayment, depositToAccount } from "@/lib/payments";

import { balanceOf, countRows, getDemoAccounts, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

describe("request rejection", () => {
  it("rejects insufficient funds, stores that answer, and replays it", async () => {
    const { alice, bob } = await getDemoAccounts();
    const startBalance = await balanceOf(alice);
    const key = crypto.randomUUID();
    const request = { from_account_id: alice, to_account_id: bob, amount_minor: startBalance + 1 };

    const result = await createPayment(request, key);

    expect(result.status).toBe(422);
    expect(result).toMatchObject({ body: { error: { code: "INSUFFICIENT_FUNDS" } } });
    expect(await countRows("payments")).toBe(3); // three seeded funding payments
    expect(await balanceOf(alice)).toBe(startBalance);

    const replay = await createPayment(request, key);
    expect(replay.status).toBe(422);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(result.body);
  });

  it("returns 404 for an unknown account and leaves no idempotency row behind", async () => {
    const { alice } = await getDemoAccounts();
    const keysBefore = await countRows("idempotency_keys");

    const result = await createPayment(
      { from_account_id: alice, to_account_id: crypto.randomUUID(), amount_minor: 100 },
      crypto.randomUUID(),
    );

    expect(result.status).toBe(404);
    expect(result).toMatchObject({ body: { error: { code: "ACCOUNT_NOT_FOUND" } } });
    expect(await countRows("idempotency_keys")).toBe(keysBefore);
  });

  it("rejects a transfer to the same account", async () => {
    const { alice } = await getDemoAccounts();

    const result = await createPayment(
      { from_account_id: alice, to_account_id: alice, amount_minor: 100 },
      crypto.randomUUID(),
    );

    expect(result.status).toBe(400);
    expect(result).toMatchObject({ body: { error: { code: "VALIDATION_ERROR" } } });
    expect(await countRows("payments")).toBe(3);
  });

  it.each([0, -1, 10.5])("rejects a non-positive or fractional amount (%s)", async (amountMinor) => {
    const { alice, bob } = await getDemoAccounts();

    const result = await createPayment(
      { from_account_id: alice, to_account_id: bob, amount_minor: amountMinor },
      crypto.randomUUID(),
    );

    expect(result.status).toBe(400);
    expect(result).toMatchObject({ body: { error: { code: "VALIDATION_ERROR" } } });
    expect(await countRows("payments")).toBe(3);
  });

  it("rejects a string amount and a malformed UUID", async () => {
    const { alice, bob } = await getDemoAccounts();

    const stringAmount = await createPayment(
      { from_account_id: alice, to_account_id: bob, amount_minor: "1000" },
      crypto.randomUUID(),
    );
    const badUuid = await createPayment(
      { from_account_id: "not-a-uuid", to_account_id: bob, amount_minor: 1_000 },
      crypto.randomUUID(),
    );

    expect(stringAmount.status).toBe(400);
    expect(badUuid.status).toBe(400);
    expect(await countRows("payments")).toBe(3);
  });

  it("enforces the per-deposit limit of 100000000 minor units", async () => {
    const { alice } = await getDemoAccounts();
    const before = await balanceOf(alice);

    const tooLarge = await depositToAccount(alice, { amount_minor: 100_000_001 });
    const atLimit = await depositToAccount(alice, { amount_minor: 100_000_000 });

    expect(tooLarge.status).toBe(400);
    expect(tooLarge).toMatchObject({ body: { error: { code: "VALIDATION_ERROR" } } });
    expect(atLimit.status).toBe(201);
    expect(await balanceOf(alice)).toBe(before + 100_000_000);
  });

  it("rejects deposits into the system account", async () => {
    const { SYSTEM_ACCOUNT_ID } = await import("./helpers");
    const result = await depositToAccount(SYSTEM_ACCOUNT_ID, { amount_minor: 1_000 });
    expect(result.status).toBe(400);
    expect(result).toMatchObject({ body: { error: { code: "CANNOT_DEPOSIT_TO_SYSTEM" } } });
  });
});
