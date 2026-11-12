import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { getPool } from "./db";
import { hashRequest } from "./hash";
import { formatMinor, minorFromDb } from "./money";
import { DEMO_SEED, SYSTEM_ACCOUNT_ID, seedDemoData } from "./seed";
import type { Account, InvariantSummary, LedgerEntry, Payment } from "./types";
import {
  accountIdSchema,
  createAccountSchema,
  depositSchema,
  formatValidationError,
  parseLimit,
  transferSchema,
} from "./validation";

/** A domain result that maps directly onto an HTTP response. */
export type ServiceResult = {
  status: number;
  body: unknown;
  /** True only when this response came from the idempotency store. */
  replayed?: boolean;
};

export type TransferHook = () => void | Promise<void>;
let postPaymentInsertHook: TransferHook | null = null;
export function setPostPaymentInsertHook(hook: TransferHook | null): void {
  postPaymentInsertHook = hook;
}

export const MAX_ACCOUNTS = 20;
const RESET_INTERVAL_MS = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

type DbGlobal = typeof globalThis & { payledgerLastResetAt?: number };
const dbGlobal = globalThis as DbGlobal;

type AccountRow = {
  id: string;
  name: string;
  currency: string;
  is_system: boolean;
  created_at: Date | string;
  balance_minor?: string | null;
};

type PaymentRow = {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: Date | string;
};

type PaymentWithNamesRow = PaymentRow & {
  from_account_name: string;
  to_account_name: string;
};

type LedgerRow = {
  id: string;
  payment_id: string;
  account_id: string;
  account_name: string;
  direction: "debit" | "credit";
  amount_minor: string;
  created_at: Date | string;
};

type IdempotencyRow = {
  request_hash: string;
  status_code: number | null;
  response_body: unknown;
};

type ValidatedTransfer = {
  from_account_id: string;
  to_account_id: string;
  amount_minor: number;
  idempotencyKey: string;
};

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function failure(status: number, code: string, message: string): ServiceResult {
  return { status, body: errorBody(code, message) };
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error("[payments] rollback failed", error);
  }
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    is_system: row.is_system,
    balance_minor: minorFromDb(row.balance_minor ?? "0"),
    created_at: toIso(row.created_at),
  };
}

function mapPayment(row: PaymentRow, fromName: string, toName: string): Payment {
  return {
    id: row.id,
    from_account_id: row.from_account_id,
    from_account_name: fromName,
    to_account_id: row.to_account_id,
    to_account_name: toName,
    amount_minor: minorFromDb(row.amount_minor),
    currency: row.currency,
    status: row.status,
    created_at: toIso(row.created_at),
  };
}

export async function listAccounts(): Promise<Account[]> {
  const { rows } = await getPool().query<AccountRow>(`
    SELECT
      a.id,
      a.name,
      a.currency,
      a.is_system,
      a.created_at,
      COALESCE(
        SUM(CASE WHEN le.direction = 'credit' THEN le.amount_minor ELSE -le.amount_minor END),
        0
      )::text AS balance_minor
    FROM accounts a
    LEFT JOIN ledger_entries le ON le.account_id = a.id
    GROUP BY a.id
    ORDER BY a.is_system ASC, a.created_at ASC, a.name ASC
  `);
  return rows.map(mapAccount);
}

export async function createAccount(input: unknown): Promise<ServiceResult> {
  const parsed = createAccountSchema.safeParse(input);
  if (!parsed.success) {
    return failure(400, "VALIDATION_ERROR", formatValidationError(parsed.error));
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // A transaction-scoped advisory lock serializes the count-then-insert.
    // Without it, two parallel requests could both observe 19 accounts and
    // create account 20 and 21.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('payledger:accounts:create'))");

    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM accounts WHERE NOT is_system",
    );
    const nonSystemCount = minorFromDb(countResult.rows[0]?.count ?? "0");
    if (nonSystemCount >= MAX_ACCOUNTS) {
      await client.query("ROLLBACK");
      return failure(
        409,
        "ACCOUNT_LIMIT_REACHED",
        `This demo supports at most ${MAX_ACCOUNTS} non-system accounts. Reset the demo to start over.`,
      );
    }

    const inserted = await client.query<AccountRow>(
      `INSERT INTO accounts (name)
       VALUES ($1)
       RETURNING id, name, currency, is_system, created_at`,
      [parsed.data.name],
    );
    const account = inserted.rows[0];
    if (!account) throw new Error("Account insert returned no row");

    await client.query("COMMIT");
    return {
      status: 201,
      body: { account: mapAccount({ ...account, balance_minor: "0" }) },
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Public entry point for POST /api/payments. Validates shape and key presence
 * before touching the database, then delegates to the transactional core.
 */
export async function createPayment(input: unknown, idempotencyKey: string | null): Promise<ServiceResult> {
  const key = idempotencyKey?.trim() ?? "";
  if (!key) {
    return failure(400, "MISSING_IDEMPOTENCY_KEY", "POST /api/payments requires an Idempotency-Key header.");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return failure(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }

  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    return failure(400, "VALIDATION_ERROR", formatValidationError(parsed.error));
  }

  return runTransfer({ ...parsed.data, idempotencyKey: key });
}

export async function depositToAccount(accountId: string, input: unknown): Promise<ServiceResult> {
  const parsedId = accountIdSchema.safeParse(accountId);
  if (!parsedId.success) {
    return failure(400, "VALIDATION_ERROR", formatValidationError(parsedId.error));
  }
  const parsedBody = depositSchema.safeParse(input);
  if (!parsedBody.success) {
    return failure(400, "VALIDATION_ERROR", formatValidationError(parsedBody.error));
  }

  const target = await getPool().query<{ id: string; is_system: boolean }>(
    "SELECT id, is_system FROM accounts WHERE id = $1",
    [parsedId.data],
  );
  const account = target.rows[0];
  if (!account) {
    return failure(404, "ACCOUNT_NOT_FOUND", "That account does not exist.");
  }
  if (account.is_system) {
    return failure(400, "CANNOT_DEPOSIT_TO_SYSTEM", "Deposits must target a non-system account.");
  }

  // Deposits are transfers from the system account, so they use the exact same
  // double-entry path (and transaction) as customer-to-customer payments.
  return runTransfer({
    from_account_id: SYSTEM_ACCOUNT_ID,
    to_account_id: account.id,
    amount_minor: parsedBody.data.amount_minor,
    idempotencyKey: `deposit:${randomUUID()}`,
  });
}

/**
 * The core money movement. Everything below happens in ONE transaction:
 * key claim -> account checks -> lock + balance check -> payment + two entries
 * -> store response -> commit. A failure at any point rolls back every write.
 */
async function runTransfer(input: ValidatedTransfer): Promise<ServiceResult> {
  // The hash covers only the meaningful request fields. Key order and JSON
  // whitespace cannot accidentally make a retry look like a different request.
  const requestHash = hashRequest({
    from_account_id: input.from_account_id,
    to_account_id: input.to_account_id,
    amount_minor: input.amount_minor,
  });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // ONE atomic statement claims the key. If another transaction owns it, the
    // unique index makes this INSERT wait and then return zero rows, so there is
    // no check-then-insert race between concurrent retries.
    const claim = await client.query(
      `INSERT INTO idempotency_keys (key, request_hash)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [input.idempotencyKey, requestHash],
    );

    if ((claim.rowCount ?? 0) === 0) {
      const existing = await client.query<IdempotencyRow>(
        "SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1",
        [input.idempotencyKey],
      );
      // Nothing was written in this branch, so there is nothing to roll back.
      await client.query("COMMIT");

      const row = existing.rows[0];
      if (!row) {
        return failure(
          409,
          "REQUEST_IN_PROGRESS",
          "A request with this Idempotency-Key is still being processed. Retry shortly.",
        );
      }
      if (row.request_hash !== requestHash) {
        return failure(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used for a different request body.",
        );
      }
      if (row.status_code !== null && row.response_body !== null) {
        return { status: row.status_code, body: row.response_body, replayed: true };
      }
      return failure(
        409,
        "REQUEST_IN_PROGRESS",
        "A request with this Idempotency-Key is still being processed. Retry shortly.",
      );
    }

    const accountsResult = await client.query<AccountRow>(
      `SELECT id, name, currency, is_system, created_at
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[input.from_account_id, input.to_account_id]],
    );
    const sender = accountsResult.rows.find((row) => row.id === input.from_account_id);
    const receiver = accountsResult.rows.find((row) => row.id === input.to_account_id);

    if (!sender || !receiver) {
      await client.query("ROLLBACK");
      return failure(404, "ACCOUNT_NOT_FOUND", "One or both accounts do not exist.");
    }
    if (sender.currency !== receiver.currency) {
      await client.query("ROLLBACK");
      return failure(422, "CURRENCY_MISMATCH", "Both accounts must use the same currency.");
    }

    let senderBalance = 0;
    // Lock non-system accounts in deterministic ascending UUID order to eliminate
    // deadlocks between concurrent bidirectional transfers (e.g. A->B and B->A).
    const lockIds = [sender.id, receiver.id]
      .filter((id) => id !== SYSTEM_ACCOUNT_ID)
      .sort();

    for (const accountId of lockIds) {
      await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
    }

    if (!sender.is_system) {
      const balanceResult = await client.query<{ balance_minor: string }>(
        `SELECT COALESCE(
           SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END),
           0
         )::text AS balance_minor
         FROM ledger_entries
         WHERE account_id = $1`,
        [sender.id],
      );
      senderBalance = minorFromDb(balanceResult.rows[0]?.balance_minor ?? "0");
    }

    if (!sender.is_system && senderBalance < input.amount_minor) {
      // Insufficient funds is a *final* answer for this key, so it is stored and
      // committed. A retry must replay the same 422 instead of re-evaluating the
      // balance and possibly succeeding after other activity.
      const body = errorBody(
        "INSUFFICIENT_FUNDS",
        `Insufficient funds: ${sender.name} has ${formatMinor(senderBalance)} available.`,
      );
      await storeIdempotentResponse(client, input.idempotencyKey, 422, body);
      await client.query("COMMIT");
      return { status: 422, body };
    }

    const paymentResult = await client.query<PaymentRow>(
      `INSERT INTO payments (from_account_id, to_account_id, amount_minor, currency, status)
       VALUES ($1, $2, $3, $4, 'completed')
       RETURNING id, from_account_id, to_account_id, amount_minor, currency, status, created_at`,
      [sender.id, receiver.id, input.amount_minor, sender.currency],
    );
    const payment = paymentResult.rows[0];
    if (!payment) throw new Error("Payment insert returned no row");

    // Atomicity test hook: if configured, inject a failure between payment and ledger entries
    if (postPaymentInsertHook) {
      await postPaymentInsertHook();
    }

    // Double-entry: exactly one debit and one equal credit, written together.
    await client.query(
      `INSERT INTO ledger_entries (payment_id, account_id, direction, amount_minor)
       VALUES ($1, $2, 'debit', $3), ($1, $4, 'credit', $3)`,
      [payment.id, sender.id, input.amount_minor, receiver.id],
    );

    const body = { payment: mapPayment(payment, sender.name, receiver.name) };
    // Persist the exact response before COMMIT so every later retry can replay
    // byte-for-byte the same status and body.
    await storeIdempotentResponse(client, input.idempotencyKey, 201, body);
    await client.query("COMMIT");
    return { status: 201, body };
  } catch (error) {
    await rollbackQuietly(client);
    console.error("[payments] transfer failed", error);
    throw error;
  } finally {
    client.release();
  }
}

async function storeIdempotentResponse(
  client: PoolClient,
  key: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
     SET status_code = $2, response_body = $3::jsonb
     WHERE key = $1`,
    [key, statusCode, JSON.stringify(body)],
  );
}

export async function listPayments(limitInput?: string | null): Promise<{ ok: true; payments: Payment[] } | { ok: false; message: string }> {
  const parsedLimit = parseLimit(limitInput ?? null);
  if (!parsedLimit.ok) return { ok: false, message: parsedLimit.message };

  const { rows } = await getPool().query<PaymentWithNamesRow>(
    `SELECT
       p.id,
       p.from_account_id,
       fa.name AS from_account_name,
       p.to_account_id,
       ta.name AS to_account_name,
       p.amount_minor,
       p.currency,
       p.status,
       p.created_at
     FROM payments p
     JOIN accounts fa ON fa.id = p.from_account_id
     JOIN accounts ta ON ta.id = p.to_account_id
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $1`,
    [parsedLimit.limit],
  );

  return {
    ok: true,
    payments: rows.map((row) => mapPayment(row, row.from_account_name, row.to_account_name)),
  };
}

export async function listLedger(
  limitInput?: string | null,
): Promise<{ ok: true; entries: LedgerEntry[] } | { ok: false; message: string }> {
  const parsedLimit = parseLimit(limitInput ?? null);
  if (!parsedLimit.ok) return { ok: false, message: parsedLimit.message };

  const { rows } = await getPool().query<LedgerRow>(
    `SELECT
       le.id,
       le.payment_id,
       le.account_id,
       a.name AS account_name,
       le.direction,
       le.amount_minor,
       le.created_at
     FROM ledger_entries le
     JOIN accounts a ON a.id = le.account_id
     ORDER BY le.id DESC
     LIMIT $1`,
    [parsedLimit.limit],
  );

  return {
    ok: true,
    entries: rows.map((row) => ({
      id: minorFromDb(row.id),
      payment_id: row.payment_id,
      account_id: row.account_id,
      account_name: row.account_name,
      direction: row.direction,
      amount_minor: minorFromDb(row.amount_minor),
      created_at: toIso(row.created_at),
    })),
  };
}

export async function getInvariant(): Promise<InvariantSummary> {
  const { rows } = await getPool().query<{ total_debits: string; total_credits: string }>(`
    SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0)::text AS total_debits,
      COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)::text AS total_credits
    FROM ledger_entries
  `);
  const totalDebits = minorFromDb(rows[0]?.total_debits ?? "0");
  const totalCredits = minorFromDb(rows[0]?.total_credits ?? "0");
  return {
    total_debits: totalDebits,
    total_credits: totalCredits,
    balanced: totalDebits === totalCredits,
  };
}

/**
 * Demo reset. The rate limit is deliberately per server instance (an in-memory
 * timestamp) because this is a public demo, not a security boundary.
 */
export async function resetDemoData(): Promise<ServiceResult> {
  const now = Date.now();
  const lastResetAt = dbGlobal.payledgerLastResetAt ?? 0;
  const elapsed = now - lastResetAt;
  if (elapsed < RESET_INTERVAL_MS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((RESET_INTERVAL_MS - elapsed) / 1000));
    return failure(429, "RATE_LIMITED", `Resets are limited to once every 2 seconds. Try again in ${retryAfterSeconds}s.`);
  }
  // Claim the gate synchronously before the first await so a double-click cannot
  // start two concurrent truncate-and-seed transactions.
  dbGlobal.payledgerLastResetAt = now;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await seedDemoData(client);
    await client.query("COMMIT");
    return {
      status: 200,
      body: { ok: true, accounts: await listAccounts(), seeded: DEMO_SEED.map((seed) => seed.name) },
    };
  } catch (error) {
    await rollbackQuietly(client);
    // Allow an immediate retry if the reset failed.
    dbGlobal.payledgerLastResetAt = 0;
    throw error;
  } finally {
    client.release();
  }
}
