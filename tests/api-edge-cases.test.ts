import { beforeEach, describe, expect, it } from "vitest";

import { getPool } from "@/lib/db";
import {
  MAX_ACCOUNTS,
  createAccount,
  createPayment,
  depositToAccount,
  listLedger,
  listPayments,
} from "@/lib/payments";

import { balanceOf, getDemoAccounts, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
});

describe("API Edge Cases", () => {
  describe("Idempotency-Key validation", () => {
    it("rejects missing, empty, or whitespace-only keys", async () => {
      const { alice, bob } = await getDemoAccounts();
      const request = { from_account_id: alice, to_account_id: bob, amount_minor: 100 };

      const nullKey = await createPayment(request, null);
      expect(nullKey.status).toBe(400);
      expect(nullKey).toMatchObject({ body: { error: { code: "MISSING_IDEMPOTENCY_KEY" } } });

      const emptyKey = await createPayment(request, "");
      expect(emptyKey.status).toBe(400);
      expect(emptyKey).toMatchObject({ body: { error: { code: "MISSING_IDEMPOTENCY_KEY" } } });

      const whitespaceKey = await createPayment(request, "    ");
      expect(whitespaceKey.status).toBe(400);
      expect(whitespaceKey).toMatchObject({ body: { error: { code: "MISSING_IDEMPOTENCY_KEY" } } });
    });

    it("rejects keys longer than 200 characters and accepts keys up to 200 characters", async () => {
      const { alice, bob } = await getDemoAccounts();
      const request = { from_account_id: alice, to_account_id: bob, amount_minor: 100 };

      const tooLongKey = "k".repeat(201);
      const rejected = await createPayment(request, tooLongKey);
      expect(rejected.status).toBe(400);
      expect(rejected).toMatchObject({ body: { error: { code: "INVALID_IDEMPOTENCY_KEY" } } });

      const maxLengthKey = "k".repeat(200);
      const accepted = await createPayment(request, maxLengthKey);
      expect(accepted.status).toBe(201);
    });
  });

  describe("Account and UUID validation", () => {
    it("rejects invalid UUIDs and unknown accounts", async () => {
      const { alice, bob } = await getDemoAccounts();

      const badFromUuid = await createPayment(
        { from_account_id: "not-a-valid-uuid", to_account_id: bob, amount_minor: 100 },
        crypto.randomUUID(),
      );
      expect(badFromUuid.status).toBe(400);
      expect(badFromUuid).toMatchObject({ body: { error: { code: "VALIDATION_ERROR" } } });

      const badToUuid = await createPayment(
        { from_account_id: alice, to_account_id: "also-not-a-uuid", amount_minor: 100 },
        crypto.randomUUID(),
      );
      expect(badToUuid.status).toBe(400);
      expect(badToUuid).toMatchObject({ body: { error: { code: "VALIDATION_ERROR" } } });

      const unknownToId = crypto.randomUUID();
      const unknownReceiver = await createPayment(
        { from_account_id: alice, to_account_id: unknownToId, amount_minor: 100 },
        crypto.randomUUID(),
      );
      expect(unknownReceiver.status).toBe(404);
      expect(unknownReceiver).toMatchObject({ body: { error: { code: "ACCOUNT_NOT_FOUND" } } });

      const unknownFromId = crypto.randomUUID();
      const unknownSender = await createPayment(
        { from_account_id: unknownFromId, to_account_id: bob, amount_minor: 100 },
        crypto.randomUUID(),
      );
      expect(unknownSender.status).toBe(404);
      expect(unknownSender).toMatchObject({ body: { error: { code: "ACCOUNT_NOT_FOUND" } } });
    });

    it("rejects transfer between the same account", async () => {
      const { alice } = await getDemoAccounts();
      const result = await createPayment(
        { from_account_id: alice, to_account_id: alice, amount_minor: 100 },
        crypto.randomUUID(),
      );
      expect(result.status).toBe(400);
      expect(result).toMatchObject({ body: { error: { code: "VALIDATION_ERROR" } } });
    });

    it("rejects transfer when currencies do not match", async () => {
      const { alice } = await getDemoAccounts();
      // Insert an account with USD directly into database
      const { rows } = await getPool().query<{ id: string }>(
        "INSERT INTO accounts (name, currency) VALUES ('USD Account', 'USD') RETURNING id",
      );
      const usdAccountId = rows[0]?.id;
      expect(usdAccountId).toBeDefined();

      const result = await createPayment(
        { from_account_id: alice, to_account_id: usdAccountId!, amount_minor: 100 },
        crypto.randomUUID(),
      );
      expect(result.status).toBe(422);
      expect(result).toMatchObject({ body: { error: { code: "CURRENCY_MISMATCH" } } });
    });
  });

  describe("Amount validations", () => {
    it.each([
      ["zero", 0],
      ["negative", -50],
      ["float", 12.34],
      ["string", "500" as unknown as number],
      ["null", null as unknown as number],
      ["beyond safe int", Number.MAX_SAFE_INTEGER + 1000],
    ])("rejects %s amount (%s)", async (_label, amountMinor) => {
      const { alice, bob } = await getDemoAccounts();
      const result = await createPayment(
        { from_account_id: alice, to_account_id: bob, amount_minor: amountMinor },
        crypto.randomUUID(),
      );
      expect(result.status).toBe(400);
      expect(result).toMatchObject({ body: { error: { code: "VALIDATION_ERROR" } } });
    });
  });

  describe("Idempotency replays and conflicts", () => {
    it("replays stored INSUFFICIENT_FUNDS even after account is later topped up", async () => {
      const { alice, bob } = await getDemoAccounts();
      const startBalance = await balanceOf(alice);
      const key = crypto.randomUUID();
      const request = { from_account_id: alice, to_account_id: bob, amount_minor: startBalance + 50_000 };

      // Initial payment fails due to insufficient funds
      const failedResult = await createPayment(request, key);
      expect(failedResult.status).toBe(422);
      expect(failedResult).toMatchObject({ body: { error: { code: "INSUFFICIENT_FUNDS" } } });

      // Alice receives a deposit making her balance now exceed the transfer amount
      const deposit = await depositToAccount(alice, { amount_minor: 100_000 });
      expect(deposit.status).toBe(201);
      expect(await balanceOf(alice)).toBeGreaterThan(request.amount_minor);

      // Retrying the original request with the same key must replay the exact same 422 failure
      const replayed = await createPayment(request, key);
      expect(replayed.status).toBe(422);
      expect(replayed.replayed).toBe(true);
      expect(replayed.body).toEqual(failedResult.body);
    });

    it("returns IDEMPOTENCY_KEY_REUSED when same key is sent with different body", async () => {
      const { alice, bob } = await getDemoAccounts();
      const key = crypto.randomUUID();

      const initial = await createPayment(
        { from_account_id: alice, to_account_id: bob, amount_minor: 1_000 },
        key,
      );
      expect(initial.status).toBe(201);

      const differentAmount = await createPayment(
        { from_account_id: alice, to_account_id: bob, amount_minor: 2_000 },
        key,
      );
      expect(differentAmount.status).toBe(422);
      expect(differentAmount).toMatchObject({ body: { error: { code: "IDEMPOTENCY_KEY_REUSED" } } });
    });
  });

  describe("Caps and Account Name Validation", () => {
    it("enforces deposit cap and non-system account cap", async () => {
      const { alice } = await getDemoAccounts();

      const overDeposit = await depositToAccount(alice, { amount_minor: 100_000_001 });
      expect(overDeposit.status).toBe(400);

      // Create accounts up to MAX_ACCOUNTS (3 exist already: Alice, Bob, Carol)
      for (let i = 3; i < MAX_ACCOUNTS; i++) {
        const res = await createAccount({ name: `User ${i}` });
        expect(res.status).toBe(201);
      }

      const overLimit = await createAccount({ name: "Overflow User" });
      expect(overLimit.status).toBe(409);
      expect(overLimit).toMatchObject({ body: { error: { code: "ACCOUNT_LIMIT_REACHED" } } });
    });

    it("validates account name (empty, too long, HTML/script strings)", async () => {
      const emptyRes = await createAccount({ name: "" });
      expect(emptyRes.status).toBe(400);

      const whitespaceRes = await createAccount({ name: "    " });
      expect(whitespaceRes.status).toBe(400);

      const tooLongRes = await createAccount({ name: "A".repeat(81) });
      expect(tooLongRes.status).toBe(400);

      // HTML/script tag is accepted as plain text and returned safely without script execution
      const scriptPayload = "<script>alert('xss')</script>";
      const xssRes = await createAccount({ name: scriptPayload });
      expect(xssRes.status).toBe(201);
      expect(xssRes.body).toMatchObject({
        account: { name: scriptPayload },
      });
    });
  });

  describe("Pagination limits clamping", () => {
    it("clamps limit parameters between 1 and 100", async () => {
      // Over 100 clamps to 100
      const maxClamp = await listPayments("500");
      expect(maxClamp.ok).toBe(true);

      const maxLedger = await listLedger("1000");
      expect(maxLedger.ok).toBe(true);

      // Non-positive clamps to 1
      const minClamp = await listPayments("0");
      expect(minClamp.ok).toBe(true);

      const negClamp = await listPayments("-10");
      expect(negClamp.ok).toBe(true);

      const minLedger = await listLedger("0");
      expect(minLedger.ok).toBe(true);

      // Null defaults to 25
      const defaultLimit = await listPayments(null);
      expect(defaultLimit.ok).toBe(true);

      // Invalid non-number string is rejected with validation error
      const badLimit = await listPayments("not-a-number");
      expect(badLimit.ok).toBe(false);
    });
  });
});
