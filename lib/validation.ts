import { z } from "zod";

import { MAX_DEPOSIT_MINOR } from "./money";

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(80, "Name must be 80 characters or fewer."),
});

export const accountIdSchema = z.uuid("Account id must be a valid UUID.");

const amountMinorSchema = z
  .number()
  .int("amount_minor must be a whole number of minor units.")
  .positive("amount_minor must be greater than zero.")
  .max(Number.MAX_SAFE_INTEGER, "amount_minor is too large.");

export const transferSchema = z
  .object({
    from_account_id: z.uuid("from_account_id must be a valid UUID."),
    to_account_id: z.uuid("to_account_id must be a valid UUID."),
    amount_minor: amountMinorSchema,
  })
  .refine((value) => value.from_account_id !== value.to_account_id, {
    message: "from_account_id and to_account_id must be different accounts.",
    path: ["to_account_id"],
  });

export const depositSchema = z.object({
  amount_minor: z
    .number()
    .int("amount_minor must be a whole number of minor units.")
    .positive("amount_minor must be greater than zero.")
    .max(MAX_DEPOSIT_MINOR, `amount_minor must be at most ${MAX_DEPOSIT_MINOR} (the per-deposit limit).`),
});

export const DEFAULT_PAGE_LIMIT = 25;
export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 100;

export const limitSchema = z.coerce
  .number()
  .int("limit must be a whole number.")
  .min(1, "limit must be at least 1.")
  .max(100, "limit must be at most 100.");

export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(" ");
}

export function parseLimit(value: string | null): { ok: true; limit: number } | { ok: false; message: string } {
  if (value === null || value === "") return { ok: true, limit: DEFAULT_PAGE_LIMIT };
  const num = Number(value);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return { ok: false, message: "limit must be a valid number." };
  }
  const intVal = Math.trunc(num);
  const clamped = Math.max(MIN_PAGE_LIMIT, Math.min(MAX_PAGE_LIMIT, intVal));
  return { ok: true, limit: clamped };
}
