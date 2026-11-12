export type Account = {
  id: string;
  name: string;
  currency: string;
  is_system: boolean;
  balance_minor: number;
  created_at: string;
};

export type Payment = {
  id: string;
  from_account_id: string;
  from_account_name: string;
  to_account_id: string;
  to_account_name: string;
  amount_minor: number;
  currency: string;
  status: string;
  created_at: string;
};

export type LedgerEntry = {
  id: number;
  payment_id: string;
  account_id: string;
  account_name: string;
  direction: "debit" | "credit";
  amount_minor: number;
  created_at: string;
};

export type InvariantSummary = {
  total_debits: number;
  total_credits: number;
  balanced: boolean;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};
