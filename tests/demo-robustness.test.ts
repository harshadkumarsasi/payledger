import { beforeEach, describe, expect, it } from "vitest";

import {
  createAccount,
  createPayment,
  depositToAccount,
  getInvariant,
  listAccounts,
  resetDemoData,
} from "@/lib/payments";

import { balanceOf, getDemoAccounts, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

// Helper implementing the dashboard's robust retry storm execution logic
async function executeRetryStorm(fromId?: string, toId?: string, amountMinor = 10_000) {
  const accounts = (await listAccounts()).filter((a) => !a.is_system);
  if (accounts.length < 2) throw new Error("Need at least 2 accounts");

  let sender =
    (fromId ? accounts.find((a) => a.id === fromId && a.balance_minor >= amountMinor) : null) ??
    accounts.find((a) => a.balance_minor >= amountMinor) ??
    null;

  if (!sender) {
    const topUpTarget = fromId ? accounts.find((a) => a.id === fromId) ?? accounts[0]! : accounts[0]!;
    await depositToAccount(topUpTarget.id, { amount_minor: Math.max(100_000, amountMinor * 2) });
    const fresh = await listAccounts();
    sender = fresh.find((a) => a.id === topUpTarget.id)!;
  }

  const receiver =
    accounts.find((a) => a.id !== sender!.id && a.id === toId) ??
    accounts.find((a) => a.id !== sender!.id)!;

  const key = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      createPayment(
        { from_account_id: sender!.id, to_account_id: receiver.id, amount_minor: amountMinor },
        key,
      ),
    ),
  );

  const created = results.filter((r) => r.status === 201 && !r.replayed).length;
  const replayed = results.filter((r) => r.replayed).length;
  const failed = results.filter((r) => r.status !== 201).length;

  return { created, replayed, failed, key, sender, receiver };
}

// Helper implementing the dashboard's robust overdraft race execution logic
async function executeOverdraftRace(fromId?: string, toId?: string) {
  const accounts = (await listAccounts()).filter((a) => !a.is_system);
  if (accounts.length < 2) throw new Error("Need at least 2 accounts");

  let sender =
    (fromId ? accounts.find((a) => a.id === fromId && a.balance_minor >= 10_000) : null) ??
    accounts.find((a) => a.balance_minor >= 10_000) ??
    null;

  if (!sender) {
    const topUpTarget = fromId ? accounts.find((a) => a.id === fromId) ?? accounts[0]! : accounts[0]!;
    await depositToAccount(topUpTarget.id, { amount_minor: 500_000 });
    const fresh = await listAccounts();
    sender = fresh.find((a) => a.id === topUpTarget.id)!;
  }

  const receiver =
    accounts.find((a) => a.id !== sender!.id && a.id === toId) ??
    accounts.find((a) => a.id !== sender!.id)!;

  const amountMinor = Math.floor((sender.balance_minor * 70) / 100);
  expect(amountMinor).toBeGreaterThan(0);

  const results = await Promise.all([
    createPayment(
      { from_account_id: sender.id, to_account_id: receiver.id, amount_minor: amountMinor },
      crypto.randomUUID(),
    ),
    createPayment(
      { from_account_id: sender.id, to_account_id: receiver.id, amount_minor: amountMinor },
      crypto.randomUUID(),
    ),
  ]);

  const successCount = results.filter((r) => r.status === 201).length;
  const insufficientCount = results.filter(
    (r) =>
      r.status === 422 &&
      (r.body as { error?: { code?: string } }).error?.code === "INSUFFICIENT_FUNDS",
  ).length;

  return { successCount, insufficientCount, results, sender, receiver, amountMinor };
}

describe("Demo Robustness across edge states", () => {
  it("State 1: freshly reset state produces sensible results", async () => {
    // Retry Storm on fresh state
    const storm = await executeRetryStorm();
    expect(storm.created).toBe(1);
    expect(storm.replayed).toBe(19);
    expect(storm.failed).toBe(0);

    // Overdraft Race on fresh state
    const race = await executeOverdraftRace();
    expect(race.successCount).toBe(1);
    expect(race.insufficientCount).toBe(1);
  });

  it("State 2: drained sender (balance 0) automatically tops up or picks funded sender", async () => {
    const { alice, bob } = await getDemoAccounts();
    // Completely drain Alice's balance to 0
    const aliceBalance = await balanceOf(alice);
    await createPayment(
      { from_account_id: alice, to_account_id: bob, amount_minor: aliceBalance },
      crypto.randomUUID(),
    );
    expect(await balanceOf(alice)).toBe(0);

    // Drain Bob and Carol too
    const { carol } = await getDemoAccounts();
    const bobBal = await balanceOf(bob);
    await createPayment(
      { from_account_id: bob, to_account_id: carol, amount_minor: bobBal },
      crypto.randomUUID(),
    );
    const carolBal = await balanceOf(carol);
    // Drain Carol to 0 by moving to Alice then Alice to Bob...
    // Simply transfer Carol's money so all accounts are drained
    // Or transfer Carol to Alice and Alice to Bob:
    // To ensure all non-system accounts have 0 balance, let's drain Carol
    await createPayment(
      { from_account_id: carol, to_account_id: alice, amount_minor: carolBal },
      crypto.randomUUID(),
    );
    await createPayment(
      { from_account_id: alice, to_account_id: bob, amount_minor: carolBal },
      crypto.randomUUID(),
    );

    // When Alice (balance 0) is chosen as sender:
    const storm = await executeRetryStorm(alice, bob);
    expect(storm.created).toBe(1);
    expect(storm.replayed).toBe(19);
    expect(storm.failed).toBe(0);

    // Drain Alice back to 0
    const newBal = await balanceOf(alice);
    if (newBal > 0) {
      await createPayment(
        { from_account_id: alice, to_account_id: bob, amount_minor: newBal },
        crypto.randomUUID(),
      );
    }
    expect(await balanceOf(alice)).toBe(0);

    // Overdraft race on drained Alice
    const race = await executeOverdraftRace(alice, bob);
    expect(race.successCount).toBe(1);
    expect(race.insufficientCount).toBe(1);
  });

  it("State 3: sender with a tiny balance (e.g. 5 paise)", async () => {
    const { alice, bob } = await getDemoAccounts();
    // Set Alice's balance to exactly 5 paise (5 minor units)
    const aliceBal = await balanceOf(alice);
    if (aliceBal > 5) {
      await createPayment(
        { from_account_id: alice, to_account_id: bob, amount_minor: aliceBal - 5 },
        crypto.randomUUID(),
      );
    }
    expect(await balanceOf(alice)).toBe(5);

    // Storm with Alice
    const storm = await executeRetryStorm(alice, bob);
    expect(storm.created).toBe(1);
    expect(storm.replayed).toBe(19);

    // Overdraft race with tiny balance
    const race = await executeOverdraftRace(alice, bob);
    expect(race.successCount).toBe(1);
    expect(race.insufficientCount).toBe(1);
  });

  it("State 4: with extra accounts created", async () => {
    // Create 5 extra accounts
    for (let i = 1; i <= 5; i++) {
      await createAccount({ name: `Extra User ${i}` });
    }
    const accounts = await listAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(8);

    const storm = await executeRetryStorm();
    expect(storm.created).toBe(1);
    expect(storm.replayed).toBe(19);

    const race = await executeOverdraftRace();
    expect(race.successCount).toBe(1);
    expect(race.insufficientCount).toBe(1);
  });

  it("State 5: run twice in a row", async () => {
    // Run Retry Storm twice in a row
    const storm1 = await executeRetryStorm();
    expect(storm1.created).toBe(1);
    expect(storm1.replayed).toBe(19);

    const storm2 = await executeRetryStorm();
    expect(storm2.created).toBe(1);
    expect(storm2.replayed).toBe(19);

    // Run Overdraft Race twice in a row
    const race1 = await executeOverdraftRace();
    expect(race1.successCount).toBe(1);
    expect(race1.insufficientCount).toBe(1);

    const race2 = await executeOverdraftRace();
    expect(race2.successCount).toBe(1);
    expect(race2.insufficientCount).toBe(1);
  });

  it("State 6: while concurrent traffic and auto-refresh transfers are running", async () => {
    const { alice, bob, carol } = await getDemoAccounts();

    // Start background transfers simulating auto-refresh / background activity
    const backgroundPromises = Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        createPayment(
          { from_account_id: bob, to_account_id: carol, amount_minor: 100 + i },
          crypto.randomUUID(),
        ),
      ),
    );

    // Concurrently run retry storm and overdraft race
    const [storm, race] = await Promise.all([
      executeRetryStorm(alice, bob),
      executeOverdraftRace(alice, carol),
    ]);

    await backgroundPromises;

    expect(storm.created).toBe(1);
    expect(storm.replayed).toBe(19);
    expect(race.successCount).toBe(1);
    expect(race.insufficientCount).toBe(1);

    const invariant = await getInvariant();
    expect(invariant.balanced).toBe(true);
  });

  it("Reset button under concurrent traffic and rate limiting", async () => {
    // First reset succeeds
    const firstReset = await resetDemoData();
    expect(firstReset.status).toBe(200);

    // Immediate second reset is rate-limited (429)
    const secondReset = await resetDemoData();
    expect(secondReset.status).toBe(429);
    expect(secondReset).toMatchObject({
      body: { error: { code: "RATE_LIMITED" } },
    });

    // Invariant holds
    const invariant = await getInvariant();
    expect(invariant.balanced).toBe(true);
  });
});
