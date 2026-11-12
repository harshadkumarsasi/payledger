-- PayLedger schema.
-- Money is stored exclusively as integer minor units (paise). Balances are
-- never stored: they are derived from the ledger, which makes it impossible
-- for a balance and its history to disagree.

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id uuid NOT NULL REFERENCES accounts (id),
  to_account_id uuid NOT NULL REFERENCES accounts (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);

-- Append-only journal. Each payment produces exactly one debit and one credit.
CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The idempotency key is the primary key: a single atomic INSERT decides which
-- request "owns" a retry, without a separate check-then-insert race.
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  status_code int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_id_idx ON ledger_entries (account_id);
CREATE INDEX payments_created_at_idx ON payments (created_at DESC);

-- Funding source for deposits. The fixed UUID lets the demo reset recreate the
-- exact same system account. This account is the only one allowed to go
-- negative, because it represents money entering the closed demo economy.
INSERT INTO accounts (id, name, currency, is_system)
VALUES ('00000000-0000-4000-8000-000000000001', 'External Funding', 'INR', true)
ON CONFLICT (id) DO NOTHING;
