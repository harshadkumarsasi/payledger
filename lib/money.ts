/**
 * Money helpers shared by the API and the dashboard.
 *
 * Everything is an integer number of paise. Rupee input is parsed with string
 * arithmetic, not parseFloat, and output is assembled from integer parts so no
 * rounding error can ever enter the system or the UI.
 */

export const MAX_DEPOSIT_MINOR = 100_000_000; // ₹10,00,000

const INR_GROUPING = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function formatMinor(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) return "—";
  const negative = amountMinor < 0;
  const absolute = Math.abs(amountMinor);
  const rupees = Math.floor(absolute / 100);
  const paise = absolute % 100;
  const sign = negative ? "-" : "";
  return `${sign}₹${INR_GROUPING.format(rupees)}.${String(paise).padStart(2, "0")}`;
}

/**
 * Accepts "1234.5", "1,234.50", "0.99" and returns integer paise, or null for
 * anything malformed or too precise. Commas are only stripped; they are not
 * validated as grouping so users can paste either format.
 */
export function parseRupeesToMinor(input: string): number | null {
  const normalized = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null;

  const [wholePart = "", fractionPart = ""] = normalized.split(".");
  const paise = fractionPart.padEnd(2, "0");
  const whole = Number(wholePart);
  if (!Number.isSafeInteger(whole)) return null;

  const minor = whole * 100 + Number(paise || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Converts a Postgres bigint result (returned as a string) safely. */
export function minorFromDb(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Amount is outside the safe integer range: ${String(value)}`);
  }
  return parsed;
}
