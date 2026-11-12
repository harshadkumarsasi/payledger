import { beforeEach, describe, expect, it } from "vitest";

import { MAX_ACCOUNTS, createAccount, resetDemoData } from "@/lib/payments";

import { countRows, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

describe("accounts and demo reset", () => {
  it("creates an account with a zero balance and trims the name", async () => {
    const result = await createAccount({ name: "  Dave  " });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      account: { name: "Dave", balance_minor: 0, is_system: false, currency: "INR" },
    });
    expect(await countRows("accounts")).toBe(5); // 3 demo + system + Dave
  });

  it("rejects a missing or blank account name", async () => {
    expect((await createAccount({ name: "   " })).status).toBe(400);
    expect((await createAccount({})).status).toBe(400);
    expect(await countRows("accounts")).toBe(4);
  });

  it(`caps non-system accounts at ${MAX_ACCOUNTS}`, async () => {
    for (let index = 3; index < MAX_ACCOUNTS; index += 1) {
      const result = await createAccount({ name: `Account ${index}` });
      expect(result.status).toBe(201);
    }

    const overTheLimit = await createAccount({ name: "One too many" });

    expect(overTheLimit.status).toBe(409);
    expect(overTheLimit).toMatchObject({ body: { error: { code: "ACCOUNT_LIMIT_REACHED" } } });
    expect(await countRows("accounts")).toBe(1 + MAX_ACCOUNTS);
  });

  it("resets the demo data and rate-limits immediate repeated resets", async () => {
    const first = await resetDemoData();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      seeded: ["Alice", "Bob", "Carol"],
    });
    const accounts = (first.body as { accounts: { name: string; balance_minor: number }[] }).accounts;
    const byName = new Map(accounts.map((account) => [account.name, account.balance_minor]));
    expect(byName.get("Alice")).toBe(500_000);
    expect(byName.get("Bob")).toBe(250_000);
    expect(byName.get("Carol")).toBe(100_000);

    const second = await resetDemoData();
    expect(second.status).toBe(429);
    expect(second).toMatchObject({ body: { error: { code: "RATE_LIMITED" } } });
  });
});
