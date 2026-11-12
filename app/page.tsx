"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { MAX_DEPOSIT_MINOR, formatMinor, parseRupeesToMinor } from "@/lib/money";
import type { Account, InvariantSummary, LedgerEntry, Payment } from "@/lib/types";

type Feedback = {
  tone: "success" | "error" | "info";
  message: string;
};

type ApiResult = {
  status: number;
  body: unknown;
  replayed: boolean;
};

type Snapshot = {
  accounts: Account[];
  payments: Payment[];
  entries: LedgerEntry[];
  invariant: InvariantSummary;
};

type BalanceAfter = {
  name: string;
  balanceMinor: number;
};

type StormResult = {
  created: number;
  replayed: number;
  failed: number;
  failureCodes: string[];
  amountMinor: number;
  key: string;
  fromName: string;
  toName: string;
  balances: BalanceAfter[];
};

type RaceAttempt = {
  label: string;
  status: number;
  outcome: string;
  code: string | null;
};

type RaceResult = {
  amountMinor: number;
  attempts: RaceAttempt[];
  successCount: number;
  insufficientCount: number;
  otherCodes: string[];
  fromName: string;
  toName: string;
  balances: BalanceAfter[];
};

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const STORM_DEFAULT_MINOR = 10_000; // ₹100.00

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : TIME_FORMAT.format(date);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

function errorCode(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { code?: unknown } }).error;
    if (error && typeof error.code === "string") return error.code;
  }
  return null;
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(body, `Request failed (${response.status}).`));
  return body as T;
}

async function apiPost(path: string, payload?: unknown, headers?: Record<string, string>): Promise<ApiResult> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  return {
    status: response.status,
    body: await readJson(response),
    replayed: response.headers.get("Idempotent-Replayed") === "true",
  };
}

function Panel({
  children,
  className = "",
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`rounded-2xl border border-line bg-panel/80 p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] backdrop-blur ${className}`}
    >
      {children}
    </section>
  );
}

function FeedbackLine({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  const tone =
    feedback.tone === "success"
      ? "border-mint/30 bg-mint-soft/60 text-mint"
      : feedback.tone === "error"
        ? "border-danger/30 bg-danger/10 text-rose-200"
        : "border-line bg-panel-soft text-slate-300";
  return (
    <p
      role={feedback.tone === "error" ? "alert" : "status"}
      className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${tone}`}
    >
      {feedback.message}
    </p>
  );
}

function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="mt-4 space-y-2" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="h-10 animate-pulse rounded-lg bg-panel-soft" />
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-mint/80">{children}</span>
  );
}

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [invariant, setInvariant] = useState<InvariantSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendPending, setSendPending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<Feedback | null>(null);

  const [newAccountName, setNewAccountName] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [createFeedback, setCreateFeedback] = useState<Feedback | null>(null);

  const [depositDrafts, setDepositDrafts] = useState<Record<string, string>>({});
  const [depositPendingId, setDepositPendingId] = useState<string | null>(null);
  const [depositFeedback, setDepositFeedback] = useState<Feedback | null>(null);

  const [stormPending, setStormPending] = useState(false);
  const [stormResult, setStormResult] = useState<StormResult | null>(null);
  const [stormError, setStormError] = useState<string | null>(null);

  const [racePending, setRacePending] = useState(false);
  const [raceResult, setRaceResult] = useState<RaceResult | null>(null);
  const [raceError, setRaceError] = useState<string | null>(null);

  const [resetPending, setResetPending] = useState(false);
  const [resetFeedback, setResetFeedback] = useState<Feedback | null>(null);

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    setAccounts(snapshot.accounts);
    setPayments(snapshot.payments);
    setEntries(snapshot.entries);
    setInvariant(snapshot.invariant);
  }, []);

  const loadSnapshot = useCallback(async (): Promise<Snapshot> => {
    const [accountsResponse, paymentsResponse, ledgerResponse, invariantResponse] = await Promise.all([
      apiGet<{ accounts: Account[] }>("/api/accounts"),
      apiGet<{ payments: Payment[] }>("/api/payments?limit=25"),
      apiGet<{ entries: LedgerEntry[] }>("/api/ledger?limit=40"),
      apiGet<InvariantSummary>("/api/invariant"),
    ]);
    return {
      accounts: accountsResponse.accounts,
      payments: paymentsResponse.payments,
      entries: ledgerResponse.entries,
      invariant: invariantResponse,
    };
  }, []);

  const refresh = useCallback(
    async (silent = false): Promise<Snapshot | null> => {
      if (!silent) setIsLoading(true);
      try {
        const snapshot = await loadSnapshot();
        applySnapshot(snapshot);
        setLoadError(null);
        setLastUpdated(new Date());
        return snapshot;
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Could not load the dashboard.");
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [applySnapshot, loadSnapshot],
  );

  useEffect(() => {
    let cancelled = false;
    // State is only updated from promise callbacks, never synchronously in the
    // effect body, which keeps the initial load free of cascading renders.
    void loadSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        applySnapshot(snapshot);
        setLoadError(null);
        setLastUpdated(new Date());
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Could not load the dashboard.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, loadSnapshot]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 4_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const customerAccounts = useMemo(() => accounts.filter((account) => !account.is_system), [accounts]);
  const systemAccount = useMemo(() => accounts.find((account) => account.is_system) ?? null, [accounts]);

  const fromAccount =
    customerAccounts.find((account) => account.id === fromId) ?? customerAccounts[0] ?? null;
  const toAccount =
    customerAccounts.find((account) => account.id === toId && account.id !== fromAccount?.id) ??
    customerAccounts.find((account) => account.id !== fromAccount?.id) ??
    null;
  const effectiveFrom = fromAccount?.id ?? "";
  const effectiveTo = toAccount?.id ?? "";

  function balancesAfter(snapshot: Snapshot | null, ids: string[]): BalanceAfter[] {
    if (!snapshot) return [];
    return snapshot.accounts
      .filter((account) => ids.includes(account.id))
      .map((account) => ({ name: account.name, balanceMinor: account.balance_minor }));
  }

  async function handleCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newAccountName.trim();
    if (!name) {
      setCreateFeedback({ tone: "error", message: "Give the account a name first." });
      return;
    }

    setCreatePending(true);
    setCreateFeedback(null);
    try {
      const result = await apiPost("/api/accounts", { name });
      if (result.status === 201) {
        setNewAccountName("");
        setCreateFeedback({ tone: "success", message: `Created ${name}.` });
        await refresh(true);
      } else {
        setCreateFeedback({
          tone: "error",
          message: errorMessage(result.body, "Could not create the account."),
        });
      }
    } catch {
      setCreateFeedback({ tone: "error", message: "Network error — could not reach the API." });
    } finally {
      setCreatePending(false);
    }
  }

  async function handleDeposit(account: Account) {
    const amountMinor = parseRupeesToMinor(depositDrafts[account.id] ?? "");
    if (amountMinor === null || amountMinor <= 0) {
      setDepositFeedback({
        tone: "error",
        message: "Enter a positive rupee amount, e.g. 500 or 250.50.",
      });
      return;
    }
    if (amountMinor > MAX_DEPOSIT_MINOR) {
      setDepositFeedback({
        tone: "error",
        message: `The per-deposit limit is ${formatMinor(MAX_DEPOSIT_MINOR)}.`,
      });
      return;
    }

    setDepositPendingId(account.id);
    setDepositFeedback(null);
    try {
      const result = await apiPost(`/api/accounts/${account.id}/deposit`, { amount_minor: amountMinor });
      if (result.status === 201) {
        setDepositDrafts((previous) => ({ ...previous, [account.id]: "" }));
        setDepositFeedback({
          tone: "success",
          message: `Deposited ${formatMinor(amountMinor)} into ${account.name}.`,
        });
        await refresh(true);
      } else {
        setDepositFeedback({
          tone: "error",
          message: errorMessage(result.body, "The deposit could not be completed."),
        });
      }
    } catch {
      setDepositFeedback({ tone: "error", message: "Network error — could not reach the API." });
    } finally {
      setDepositPendingId(null);
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fromAccount || !toAccount) {
      setSendFeedback({ tone: "error", message: "You need two accounts to send money." });
      return;
    }
    const amountMinor = parseRupeesToMinor(sendAmount);
    if (amountMinor === null || amountMinor <= 0) {
      setSendFeedback({ tone: "error", message: "Enter a positive rupee amount, e.g. 100 or 42.50." });
      return;
    }

    // A fresh key per submit. A retry of this exact request with the same key
    // would replay the stored response instead of moving money twice.
    const idempotencyKey = crypto.randomUUID();
    setSendPending(true);
    setSendFeedback(null);
    try {
      const result = await apiPost(
        "/api/payments",
        { from_account_id: fromAccount.id, to_account_id: toAccount.id, amount_minor: amountMinor },
        { "Idempotency-Key": idempotencyKey },
      );

      if (result.status === 201) {
        setSendAmount("");
        setSendFeedback({
          tone: "success",
          message: `Sent ${formatMinor(amountMinor)} from ${fromAccount.name} to ${toAccount.name}. Key ${idempotencyKey.slice(0, 8)}…`,
        });
        await refresh(true);
      } else {
        setSendFeedback({
          tone: "error",
          message: errorMessage(result.body, "The payment could not be completed."),
        });
      }
    } catch {
      setSendFeedback({ tone: "error", message: "Network error — could not reach the API." });
    } finally {
      setSendPending(false);
    }
  }

  async function handleRetryStorm() {
    if (stormPending) return;
    if (customerAccounts.length < 2) {
      setStormError("You need at least two customer accounts to run the retry storm.");
      return;
    }

    const parsed = parseRupeesToMinor(sendAmount);
    const amountMinor = parsed !== null && parsed > 0 ? parsed : STORM_DEFAULT_MINOR;

    // Pick a funded sender (at least amountMinor), or automatically top up
    let sender =
      (fromAccount && fromAccount.balance_minor >= amountMinor ? fromAccount : null) ??
      customerAccounts.find((account) => account.balance_minor >= amountMinor) ??
      null;

    if (!sender) {
      const topUpTarget = fromAccount ?? customerAccounts[0];
      if (!topUpTarget) {
        setStormError("No customer account available.");
        return;
      }
      setStormPending(true);
      setStormError(null);
      try {
        const topUpResult = await apiPost(`/api/accounts/${topUpTarget.id}/deposit`, {
          amount_minor: Math.max(100_000, amountMinor * 2),
        });
        if (topUpResult.status !== 201) {
          setStormError("Could not top up account balance for the retry storm.");
          setStormPending(false);
          return;
        }
        await refresh(true);
        sender = {
          ...topUpTarget,
          balance_minor: topUpTarget.balance_minor + Math.max(100_000, amountMinor * 2),
        };
      } catch {
        setStormError("Network error while topping up sender.");
        setStormPending(false);
        return;
      }
    }

    const receiver =
      customerAccounts.find((account) => account.id !== sender.id && account.id === toId) ??
      customerAccounts.find((account) => account.id !== sender.id) ??
      null;

    if (!receiver) {
      setStormError("You need a second account to receive the transfers.");
      setStormPending(false);
      return;
    }

    const key = crypto.randomUUID();

    setStormPending(true);
    setStormError(null);
    setStormResult(null);
    try {
      // 20 genuinely parallel requests, all with the same key and body.
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          apiPost(
            "/api/payments",
            { from_account_id: sender.id, to_account_id: receiver.id, amount_minor: amountMinor },
            { "Idempotency-Key": key },
          ),
        ),
      );

      const created = results.filter((result) => result.status === 201 && !result.replayed).length;
      const replayed = results.filter((result) => result.replayed).length;
      const failures = results.filter(
        (result) => !((result.status === 201 && !result.replayed) || result.replayed),
      );
      const failureCodes = Array.from(
        new Set(failures.map((result) => errorCode(result.body) ?? `HTTP ${result.status}`)),
      );

      const snapshot = await refresh(true);
      setStormResult({
        created,
        replayed,
        failed: failures.length,
        failureCodes,
        amountMinor,
        key,
        fromName: sender.name,
        toName: receiver.name,
        balances: balancesAfter(snapshot, [sender.id, receiver.id]),
      });
    } catch {
      setStormError("Network error while firing the retry storm.");
    } finally {
      setStormPending(false);
    }
  }

  async function handleOverdraftRace() {
    if (racePending) return;
    if (customerAccounts.length < 2) {
      setRaceError("You need at least two customer accounts to run the race.");
      return;
    }

    // Pick a funded sender with at least ₹100 (10,000 minor) so 70% is substantial,
    // or automatically top up if drained or tiny
    let sender =
      (fromAccount && fromAccount.balance_minor >= 10_000 ? fromAccount : null) ??
      customerAccounts.find((account) => account.balance_minor >= 10_000) ??
      null;

    if (!sender) {
      const topUpTarget = fromAccount ?? customerAccounts[0];
      if (!topUpTarget) {
        setRaceError("No customer account available.");
        return;
      }
      setRacePending(true);
      setRaceError(null);
      try {
        const topUpResult = await apiPost(`/api/accounts/${topUpTarget.id}/deposit`, {
          amount_minor: 500_000, // ₹5,000.00
        });
        if (topUpResult.status !== 201) {
          setRaceError("Could not top up account balance for the overdraft race.");
          setRacePending(false);
          return;
        }
        await refresh(true);
        sender = { ...topUpTarget, balance_minor: topUpTarget.balance_minor + 500_000 };
      } catch {
        setRaceError("Network error while topping up sender.");
        setRacePending(false);
        return;
      }
    }

    const receiver =
      customerAccounts.find((account) => account.id !== sender.id && account.id === toId) ??
      customerAccounts.find((account) => account.id !== sender.id) ??
      null;

    if (!receiver) {
      setRaceError("You need a second account to receive the transfers.");
      setRacePending(false);
      return;
    }

    // 70% in integer paise. The multiplication stays well inside the safe
    // integer range, so no fractional money ever reaches the API.
    const amountMinor = Math.floor((sender.balance_minor * 70) / 100);
    if (amountMinor <= 0) {
      setRaceError("The sender needs a positive balance to race.");
      return;
    }

    setRacePending(true);
    setRaceError(null);
    setRaceResult(null);
    try {
      // Different keys means both requests are real payments racing each other.
      const results = await Promise.all(
        [0, 1].map(() =>
          apiPost(
            "/api/payments",
            { from_account_id: sender.id, to_account_id: receiver.id, amount_minor: amountMinor },
            { "Idempotency-Key": crypto.randomUUID() },
          ),
        ),
      );

      const attempts: RaceAttempt[] = results.map((result, index) => {
        const code = errorCode(result.body);
        const outcome =
          result.status === 201
            ? result.replayed
              ? "replayed"
              : "created"
            : code === "INSUFFICIENT_FUNDS"
              ? "insufficient funds"
              : (code ?? `HTTP ${result.status}`);
        return {
          label: index === 0 ? "Request A" : "Request B",
          status: result.status,
          outcome,
          code,
        };
      });

      const snapshot = await refresh(true);
      setRaceResult({
        amountMinor,
        attempts,
        successCount: results.filter((result) => result.status === 201).length,
        insufficientCount: attempts.filter((attempt) => attempt.code === "INSUFFICIENT_FUNDS").length,
        otherCodes: attempts
          .filter((attempt) => attempt.status !== 201 && attempt.code !== "INSUFFICIENT_FUNDS")
          .map((attempt) => attempt.code ?? `HTTP ${attempt.status}`),
        fromName: sender.name,
        toName: receiver.name,
        balances: balancesAfter(snapshot, [sender.id, receiver.id]),
      });
    } catch {
      setRaceError("Network error while racing the two payments.");
    } finally {
      setRacePending(false);
    }
  }

  async function handleReset() {
    if (resetPending) return;
    setResetPending(true);
    setResetFeedback(null);
    try {
      const result = await apiPost("/api/demo/reset");
      if (result.status === 200) {
        setResetFeedback({
          tone: "success",
          message: "Demo reset: Alice, Bob and Carol are funded again.",
        });
        setSendAmount("");
        setSendFeedback(null);
        setDepositDrafts({});
        setDepositFeedback(null);
        setStormResult(null);
        setStormError(null);
        setRaceResult(null);
        setRaceError(null);
        await refresh(true);
      } else {
        setResetFeedback({
          tone: "error",
          message: errorMessage(result.body, "The demo could not be reset."),
        });
      }
    } catch {
      setResetFeedback({ tone: "error", message: "Network error — could not reach the API." });
    } finally {
      setResetPending(false);
    }
  }

  const busy = sendPending || stormPending || racePending || resetPending || createPending;
  const isLoadingFirstPaint = isLoading && accounts.length === 0;

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-48 left-1/2 h-[34rem] w-[54rem] -translate-x-1/2 rounded-full bg-mint/10 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-sky-500/5 blur-3xl" />
      </div>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <header className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div
                aria-hidden="true"
                className="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-mint/30 bg-mint-soft font-mono text-xl font-semibold text-mint shadow-[0_0_40px_-8px_rgba(55,224,160,0.7)]"
              >
                ₹
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">PayLedger</h1>
                  <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                    Demo only · fake money
                  </span>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
                  A miniature payments core with idempotent transfers, concurrency-safe balances, and a
                  double-entry ledger. No login — the demo is already funded.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-mint" />
                </span>
                Live
              </span>
              <span className="hidden text-slate-600 sm:inline">·</span>
              <span className="hidden sm:inline">
                Updated {lastUpdated ? TIME_FORMAT.format(lastUpdated) : "—"}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-line bg-panel px-2.5 py-1.5 font-medium text-slate-300 transition hover:border-line-bright hover:text-white"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel/60 px-4 py-3">
            {invariant ? (
              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ${
                  invariant.balanced
                    ? "border-mint/30 bg-mint-soft text-mint"
                    : "border-danger/40 bg-danger/10 text-rose-200"
                }`}
              >
                <span aria-hidden="true">{invariant.balanced ? "✔" : "!"}</span>
                {invariant.balanced ? "Debits = Credits" : "Ledger is out of balance"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 text-sm text-slate-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-slate-500" />
                Checking ledger invariant…
              </span>
            )}
            {invariant ? (
              <span className="font-mono text-xs tabular-nums text-slate-500">
                Σ debits {formatMinor(invariant.total_debits)} · Σ credits{" "}
                {formatMinor(invariant.total_credits)}
              </span>
            ) : null}
            {systemAccount ? (
              <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
                <span>{systemAccount.name} (system):</span>{" "}
                <span className={`font-mono tabular-nums ${systemAccount.balance_minor < 0 ? "text-amber-200" : "text-slate-300"}`}>
                  {formatMinor(systemAccount.balance_minor)}
                </span>
                <span
                  tabIndex={0}
                  role="note"
                  aria-label="Why is External Funding negative? In a double-entry ledger, all debits must equal credits. External Funding represents outside money entering the system: funding customer accounts credits them and debits External Funding, keeping the total ledger sum balanced at zero."
                  title="Why is External Funding negative? In a double-entry ledger, all debits must equal credits. External Funding represents outside money entering the system: funding customer accounts credits them and debits External Funding, keeping the total ledger sum balanced at zero."
                  className="group relative inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600 font-mono text-[10px] text-slate-400 hover:border-mint hover:text-mint focus:outline-none focus:ring-1 focus:ring-mint"
                >
                  ?
                  <span className="pointer-events-none absolute bottom-full right-0 mb-2 hidden w-64 rounded-lg border border-line bg-panel p-2.5 text-left text-[11px] leading-relaxed text-slate-300 shadow-xl group-hover:block group-focus:block z-50">
                    <strong className="block text-slate-100 font-semibold mb-1">Why is this balance negative?</strong>
                    In a closed double-entry ledger, total debits equal total credits. External Funding represents capital injected into the system: crediting customer accounts requires an equal debit to this system account.
                  </span>
                </span>
              </span>
            ) : null}
          </div>

          {loadError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-rose-200"
            >
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-medium text-rose-100 transition hover:bg-danger/20"
              >
                Try again
              </button>
            </div>
          ) : null}
        </header>

        <div className="grid gap-4 lg:grid-cols-5">
          <Panel className="lg:col-span-3" labelledBy="accounts-heading">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="accounts-heading" className="text-lg font-semibold">
                  Accounts
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  Balances are computed from the ledger, never stored.
                </p>
              </div>
              <span className="whitespace-nowrap rounded-full border border-line bg-panel-soft px-2.5 py-1 font-mono text-xs text-slate-400">
                {customerAccounts.length} / 20
              </span>
            </div>

            {isLoadingFirstPaint ? (
              <SkeletonRows count={3} />
            ) : customerAccounts.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-slate-500">
                No accounts yet. Create one below to get started.
              </p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {customerAccounts.map((account) => (
                  <div
                    key={account.id}
                    className="rounded-xl border border-line bg-panel-soft/60 p-4 transition hover:border-line-bright"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-100">{account.name}</p>
                        <p className="mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">
                          {account.currency} account
                        </p>
                      </div>
                      <p className="font-mono text-lg tabular-nums text-slate-100">
                        {formatMinor(account.balance_minor)}
                      </p>
                    </div>

                    <form
                      className="mt-4 flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleDeposit(account);
                      }}
                    >
                      <label htmlFor={`deposit-${account.id}`} className="sr-only">
                        Deposit amount in rupees for {account.name}
                      </label>
                      <div className="relative flex-1">
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-500"
                        >
                          ₹
                        </span>
                        <input
                          id={`deposit-${account.id}`}
                          value={depositDrafts[account.id] ?? ""}
                          onChange={(event) => {
                            setDepositDrafts((previous) => ({
                              ...previous,
                              [account.id]: event.target.value,
                            }));
                            setDepositFeedback(null);
                          }}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="500.00"
                          className="w-full rounded-lg border border-line bg-canvas/60 py-2 pl-7 pr-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-mint/50 focus:outline-none"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={depositPendingId === account.id || busy}
                        className="rounded-lg border border-line bg-panel px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-mint/40 hover:text-mint disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {depositPendingId === account.id ? "Depositing…" : "Deposit"}
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            )}

            <FeedbackLine feedback={depositFeedback} />

            <div className="mt-5 border-t border-line/70 pt-4">
              <h3 className="text-sm font-medium text-slate-200">Create an account</h3>
              <form className="mt-2 flex flex-col gap-2 sm:flex-row" onSubmit={handleCreateAccount}>
                <label htmlFor="new-account-name" className="sr-only">
                  New account name
                </label>
                <input
                  id="new-account-name"
                  value={newAccountName}
                  onChange={(event) => {
                    setNewAccountName(event.target.value);
                    setCreateFeedback(null);
                  }}
                  maxLength={80}
                  autoComplete="off"
                  placeholder="e.g. Dave"
                  className="flex-1 rounded-lg border border-line bg-canvas/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-mint/50 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={createPending || busy}
                  className="rounded-lg border border-mint/30 bg-mint-soft px-3 py-2 text-xs font-semibold text-mint transition hover:border-mint/60 hover:bg-mint/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createPending ? "Creating…" : "Create account"}
                </button>
              </form>
              <FeedbackLine feedback={createFeedback} />
            </div>
          </Panel>

          <Panel className="lg:col-span-2" labelledBy="send-heading">
            <h2 id="send-heading" className="text-lg font-semibold">
              Send money
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              One transaction. One debit. One credit. All or nothing.
            </p>

            <form className="mt-5 space-y-4" onSubmit={handleSend}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="from-account" className="text-xs font-medium text-slate-400">
                    From
                  </label>
                  <select
                    id="from-account"
                    value={effectiveFrom}
                    onChange={(event) => {
                      setFromId(event.target.value);
                      setSendFeedback(null);
                    }}
                    disabled={customerAccounts.length === 0}
                    className="mt-1.5 w-full rounded-lg border border-line bg-canvas/60 px-2.5 py-2 text-sm text-slate-100 focus:border-mint/50 focus:outline-none disabled:opacity-50"
                  >
                    {customerAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="to-account" className="text-xs font-medium text-slate-400">
                    To
                  </label>
                  <select
                    id="to-account"
                    value={effectiveTo}
                    onChange={(event) => {
                      setToId(event.target.value);
                      setSendFeedback(null);
                    }}
                    disabled={customerAccounts.length < 2}
                    className="mt-1.5 w-full rounded-lg border border-line bg-canvas/60 px-2.5 py-2 text-sm text-slate-100 focus:border-mint/50 focus:outline-none disabled:opacity-50"
                  >
                    {customerAccounts
                      .filter((account) => account.id !== effectiveFrom)
                      .map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="send-amount" className="text-xs font-medium text-slate-400">
                  Amount (₹)
                </label>
                <div className="relative mt-1.5">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500"
                  >
                    ₹
                  </span>
                  <input
                    id="send-amount"
                    value={sendAmount}
                    onChange={(event) => {
                      setSendAmount(event.target.value);
                      setSendFeedback(null);
                    }}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="100.00"
                    className="w-full rounded-lg border border-line bg-canvas/60 py-2.5 pl-7 pr-3 font-mono text-base text-slate-100 placeholder:text-slate-600 focus:border-mint/50 focus:outline-none"
                  />
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
                  Converted to integer paise in code. A fresh Idempotency-Key is generated per submit.
                </p>
              </div>

              <button
                type="submit"
                disabled={sendPending || !fromAccount || !toAccount || busy}
                className="w-full rounded-lg bg-mint px-4 py-2.5 text-sm font-semibold text-[#04110c] transition hover:bg-[#5cebb4] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sendPending ? "Sending…" : "Send payment"}
              </button>
            </form>

            <FeedbackLine feedback={sendFeedback} />

            <p className="mt-4 border-t border-line/70 pt-3 text-[11px] leading-5 text-slate-500">
              Retrying an identical request with the same key replays the stored response — it never creates
              a second payment.
            </p>
          </Panel>
        </div>

        <section aria-labelledby="demos-heading" className="space-y-4">
          <div>
            <h2 id="demos-heading" className="text-lg font-semibold">
              Proof, not promises
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Two buttons that stress the guarantees with real concurrent requests.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-2xl border border-line bg-panel/80 p-5">
              <SectionLabel>Idempotency</SectionLabel>
              <div className="mt-2 flex items-start justify-between gap-3">
                <h3 className="text-lg font-semibold">Retry Storm</h3>
                <span className="rounded-full border border-line bg-panel-soft px-2 py-0.5 font-mono text-[11px] text-slate-400">
                  20 × parallel
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Fires 20 identical payments at once with the <em>same</em> Idempotency-Key. Exactly one should
                create a payment; the other 19 should replay the stored response.
              </p>
              <button
                type="button"
                onClick={() => void handleRetryStorm()}
                disabled={stormPending || !fromAccount || !toAccount || busy}
                className="mt-4 w-full rounded-lg border border-mint/30 bg-mint-soft px-4 py-2.5 text-sm font-semibold text-mint transition hover:border-mint/60 hover:bg-mint/15 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                {stormPending ? "Firing 20 requests…" : "Run retry storm"}
              </button>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                Uses the amount in Send Money (default {formatMinor(STORM_DEFAULT_MINOR)}). Replays keep the
                original 201 status and are marked with <code className="font-mono">Idempotent-Replayed: true</code>.
              </p>

              {stormError ? (
                <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-rose-200">
                  {stormError}
                </p>
              ) : null}

              {stormResult ? (
                <div role="status" className="mt-4 rounded-xl border border-line bg-black/20 p-4">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="font-mono text-2xl font-semibold text-mint">{stormResult.created}</p>
                      <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-500">created</p>
                    </div>
                    <div>
                      <p className="font-mono text-2xl font-semibold text-sky-300">{stormResult.replayed}</p>
                      <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-500">replayed</p>
                    </div>
                    <div>
                      <p
                        className={`font-mono text-2xl font-semibold ${stormResult.failed > 0 ? "text-rose-300" : "text-slate-500"}`}
                      >
                        {stormResult.failed}
                      </p>
                      <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-500">failed</p>
                    </div>
                  </div>
                  <p
                    className={`mt-3 text-xs leading-5 ${
                      stormResult.created === 1 && stormResult.replayed === 19
                        ? "text-mint"
                        : "text-amber-200"
                    }`}
                  >
                    {stormResult.created === 1 && stormResult.replayed === 19
                      ? `✔ 1 created, 19 replayed — ${formatMinor(stormResult.amountMinor)} moved once.`
                      : `Expected 1 created and 19 replayed. ${
                          stormResult.failureCodes.length > 0
                            ? `Failures: ${stormResult.failureCodes.join(", ")}.`
                            : "Balances may be too low for this amount."
                        }`}
                  </p>
                  <p className="mt-2 break-all font-mono text-[11px] text-slate-500">
                    key {stormResult.key}
                  </p>
                  {stormResult.balances.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                      {stormResult.balances.map((balance) => (
                        <span key={balance.name}>
                          {balance.name}:{" "}
                          <span className="font-mono tabular-nums text-slate-200">
                            {formatMinor(balance.balanceMinor)}
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </article>

            <article className="rounded-2xl border border-line bg-panel/80 p-5">
              <SectionLabel>Concurrency</SectionLabel>
              <div className="mt-2 flex items-start justify-between gap-3">
                <h3 className="text-lg font-semibold">Overdraft Race</h3>
                <span className="rounded-full border border-line bg-panel-soft px-2 py-0.5 font-mono text-[11px] text-slate-400">
                  2 × 70%
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Sends two simultaneous payments with <em>different</em> keys, each for 70% of the sender&apos;s
                balance. Exactly one can win; the balance must never go negative.
              </p>
              <button
                type="button"
                onClick={() => void handleOverdraftRace()}
                disabled={racePending || !fromAccount || !toAccount || busy}
                className="mt-4 w-full rounded-lg border border-sky-400/30 bg-sky-400/10 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:border-sky-400/60 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                {racePending ? "Racing two payments…" : "Run overdraft race"}
              </button>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                Sender: {fromAccount ? fromAccount.name : "—"} · 70% of the current computed balance. The
                sender row is locked with <code className="font-mono">FOR UPDATE</code>.
              </p>

              {raceError ? (
                <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-rose-200">
                  {raceError}
                </p>
              ) : null}

              {raceResult ? (
                <div role="status" className="mt-4 rounded-xl border border-line bg-black/20 p-4">
                  <ul className="space-y-2 text-xs">
                    {raceResult.attempts.map((attempt) => (
                      <li key={attempt.label} className="flex items-center justify-between gap-3">
                        <span className="text-slate-400">{attempt.label}</span>
                        <span
                          className={`font-mono ${
                            attempt.status === 201
                              ? "text-mint"
                              : attempt.code === "INSUFFICIENT_FUNDS"
                                ? "text-rose-300"
                                : "text-amber-200"
                          }`}
                        >
                          {attempt.status} · {attempt.outcome}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p
                    className={`mt-3 text-xs leading-5 ${
                      raceResult.successCount === 1 && raceResult.insufficientCount === 1
                        ? "text-mint"
                        : "text-amber-200"
                    }`}
                  >
                    {raceResult.successCount === 1 && raceResult.insufficientCount === 1
                      ? `✔ Exactly one succeeded; the other was rejected with INSUFFICIENT_FUNDS. ${formatMinor(raceResult.amountMinor)} moved once.`
                      : `Expected 1 success and 1 INSUFFICIENT_FUNDS. Got ${raceResult.successCount} success / ${raceResult.insufficientCount} insufficient${raceResult.otherCodes.length > 0 ? ` / ${raceResult.otherCodes.join(", ")}` : ""}.`}
                  </p>
                  {raceResult.balances.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                      {raceResult.balances.map((balance) => (
                        <span key={balance.name}>
                          {balance.name}:{" "}
                          <span className="font-mono tabular-nums text-slate-200">
                            {formatMinor(balance.balanceMinor)}
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </article>
          </div>
        </section>

        <section aria-labelledby="activity-heading" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="activity-heading" className="text-lg font-semibold">
                Live activity
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Refreshes every 4 seconds. Every payment has exactly two ledger entries.
              </p>
            </div>
            <span className="inline-flex items-center gap-2 text-[11px] text-slate-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-mint" />
              auto-refreshing
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel labelledBy="payments-heading" className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <h3 id="payments-heading" className="text-sm font-semibold text-slate-200">
                  Recent payments
                </h3>
                <span className="font-mono text-[11px] text-slate-500">{payments.length} shown</span>
              </div>
              {isLoadingFirstPaint ? (
                <SkeletonRows count={4} />
              ) : payments.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">No payments yet.</p>
              ) : (
                <div className="-mx-1 mt-3 overflow-x-auto">
                  <table className="w-full min-w-[19rem] text-left text-xs sm:min-w-[30rem]">
                    <caption className="sr-only">Recent payments, newest first</caption>
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                        <th scope="col" className="hidden px-1 py-2 font-medium sm:table-cell">Time</th>
                        <th scope="col" className="px-1 py-2 font-medium">Transfer</th>
                        <th scope="col" className="px-1 py-2 text-right font-medium">Amount</th>
                        <th scope="col" className="hidden px-1 py-2 text-right font-medium sm:table-cell">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment) => (
                        <tr key={payment.id} className="border-t border-line/60">
                          <td className="hidden whitespace-nowrap px-1 py-2.5 font-mono text-[11px] text-slate-500 sm:table-cell">
                            {formatTime(payment.created_at)}
                          </td>
                          <td className="px-1 py-2.5 text-slate-300">
                            {payment.from_account_name}{" "}
                            <span aria-hidden="true" className="text-slate-600">→</span>{" "}
                            {payment.to_account_name}
                          </td>
                          <td className="whitespace-nowrap px-1 py-2.5 text-right font-mono tabular-nums text-slate-200">
                            {formatMinor(payment.amount_minor)}
                          </td>
                          <td className="hidden px-1 py-2.5 text-right sm:table-cell">
                            <span className="rounded-full border border-mint/20 bg-mint-soft/60 px-2 py-0.5 text-[10px] text-mint">
                              {payment.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel labelledBy="ledger-heading" className="min-w-0">
              <div className="flex items-center justify-between gap-3">
                <h3 id="ledger-heading" className="text-sm font-semibold text-slate-200">
                  Recent ledger entries
                </h3>
                <span className="font-mono text-[11px] text-slate-500">{entries.length} shown</span>
              </div>
              {isLoadingFirstPaint ? (
                <SkeletonRows count={4} />
              ) : entries.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">The ledger is empty.</p>
              ) : (
                <div className="-mx-1 mt-3 overflow-x-auto">
                  <table className="w-full min-w-[17rem] text-left text-xs sm:min-w-[30rem]">
                    <caption className="sr-only">Recent ledger entries, newest first</caption>
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                        <th scope="col" className="hidden px-1 py-2 font-medium sm:table-cell">Time</th>
                        <th scope="col" className="px-1 py-2 font-medium">Account</th>
                        <th scope="col" className="px-1 py-2 font-medium">Direction</th>
                        <th scope="col" className="px-1 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => (
                        <tr key={entry.id} className="border-t border-line/60">
                          <td className="hidden whitespace-nowrap px-1 py-2.5 font-mono text-[11px] text-slate-500 sm:table-cell">
                            {formatTime(entry.created_at)}
                          </td>
                          <td className="px-1 py-2.5 text-slate-300">{entry.account_name}</td>
                          <td className="px-1 py-2.5">
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                                entry.direction === "debit"
                                  ? "border-rose-400/20 bg-rose-400/10 text-rose-200"
                                  : "border-mint/20 bg-mint-soft/60 text-mint"
                              }`}
                            >
                              {entry.direction}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-1 py-2.5 text-right font-mono tabular-nums text-slate-200">
                            {entry.direction === "debit" ? "−" : "+"}
                            {formatMinor(entry.amount_minor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        </section>

        <section
          aria-labelledby="reset-heading"
          className="flex flex-col gap-3 rounded-2xl border border-line bg-panel/60 p-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h2 id="reset-heading" className="text-sm font-semibold text-slate-200">
              Reset demo
            </h2>
            <p className="mt-1 max-w-xl text-xs leading-5 text-slate-500">
              Truncates every payment, ledger entry and idempotency key, then reseeds Alice, Bob and Carol
              from the External Funding account. Limited to one reset every 2 seconds per instance.
            </p>
          </div>
          <div className="sm:text-right">
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={resetPending || busy}
              className="rounded-lg border border-line bg-panel px-4 py-2 text-xs font-medium text-slate-300 transition hover:border-rose-400/40 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resetPending ? "Resetting…" : "Reset demo"}
            </button>
            <div className="sm:max-w-xs">
              <FeedbackLine feedback={resetFeedback} />
            </div>
          </div>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pb-2 pt-4 text-[11px] text-slate-600">
          <span>PayLedger · Next.js, Postgres, plain SQL. No real money, no auth, no floats.</span>
          <span className="font-mono">idempotent · concurrency-safe · double-entry</span>
        </footer>
      </main>
    </div>
  );
}
