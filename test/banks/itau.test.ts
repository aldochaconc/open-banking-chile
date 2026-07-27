/**
 * Unit tests for every regex and pure mapper in src/banks/itau.ts. Each block
 * documents what the pattern must reject, because in this scraper the damage came
 * from patterns that matched too much, not too little.
 */
import { describe, it, expect } from "vitest";
import { MOVEMENT_SOURCE } from "../../src/types.js";
import type { ItauCardSummary } from "../../src/banks/itau.js";
import {
  buildCreditCard,
  extractFromTables,
  formatPeriod,
  isRowDate,
  mapAccountRow,
  mapBilledRow,
  mapUnbilledRow,
  mayHaveMorePages,
  maskedCardLabel,
  normalizeHeader,
  parseAvailableBalance,
  parseShownPeriod,
  parseUsd,
  periodInputMatches,
  previousPeriod,
  resolveAccountColumns,
  resolveBilledColumns,
  resolveUnbilledColumns,
} from "../../src/banks/itau.js";

describe("ROW_DATE_RE / isRowDate", () => {
  it("matches a bare dd/mm/yyyy cell", () => {
    expect(isRowDate("27/07/2026")).toBe(true);
    expect(isRowDate("1/4/2026")).toBe(true);
  });

  it("tolerates surrounding whitespace from the cell text", () => {
    expect(isRowDate("  27/07/2026\n")).toBe(true);
  });

  it("rejects a cell that merely contains a date", () => {
    // Summary blocks on the statement read like this; unanchored matching pulled
    // them into the movement list.
    expect(isRowDate("Pagar hasta 07/07/2026")).toBe(false);
    expect(isRowDate("Período facturado 27/05/2026")).toBe(false);
  });

  it("rejects partial and over-long dates", () => {
    expect(isRowDate("27/07")).toBe(false);
    expect(isRowDate("27/07/26")).toBe(false);
    expect(isRowDate("27/07/20261")).toBe(false);
    expect(isRowDate("")).toBe(false);
  });

  it("gives the same answer on repeated calls", () => {
    expect(isRowDate("27/07/2026")).toBe(true);
    expect(isRowDate("27/07/2026")).toBe(true);
  });
});

describe("PAGE_INFO_RE / mayHaveMorePages", () => {
  it("allows another page while the counter has room", () => {
    expect(mayHaveMorePages("Página 1 de 4")).toBe(true);
  });

  it("stops on the last page", () => {
    expect(mayHaveMorePages("Página 4 de 4")).toBe(false);
  });

  it("stops when the counter is past the total", () => {
    expect(mayHaveMorePages("Página 5 de 4")).toBe(false);
  });

  it("reads the counter without the accent and in any case", () => {
    expect(mayHaveMorePages("PAGINA 3 DE 3")).toBe(false);
    expect(mayHaveMorePages("pagina 1 de 3")).toBe(true);
  });

  it("finds the counter inside a full page of text", () => {
    expect(mayHaveMorePages("Movimientos\n\nPágina 4 de 4\n\nSiguiente")).toBe(false);
  });

  it("assumes more pages when the page has no counter, leaving the next button to decide", () => {
    // The statement view paginates without printing a counter.
    expect(mayHaveMorePages("Estado de cuenta nacional")).toBe(true);
    expect(mayHaveMorePages("")).toBe(true);
    expect(mayHaveMorePages("Página siguiente")).toBe(true);
  });

  it("treats a zero counter as unusable instead of stopping on page 0", () => {
    expect(mayHaveMorePages("Página 0 de 0")).toBe(true);
  });

  it("gives the same answer on repeated calls", () => {
    expect(mayHaveMorePages("Página 1 de 2")).toBe(true);
    expect(mayHaveMorePages("Página 1 de 2")).toBe(true);
  });
});

describe("PERIOD_LABEL_RE / parseShownPeriod", () => {
  it("parses the picker's spaced label", () => {
    expect(parseShownPeriod("06 / 2026")).toEqual({ month: 6, year: 2026 });
  });

  it("parses it without spaces", () => {
    expect(parseShownPeriod("12/2025")).toEqual({ month: 12, year: 2025 });
  });

  it("parses a single-digit month", () => {
    expect(parseShownPeriod("4 / 2026")).toEqual({ month: 4, year: 2026 });
  });

  it("returns null when no period is present", () => {
    expect(parseShownPeriod("")).toBeNull();
    expect(parseShownPeriod("Mes / año :")).toBeNull();
  });

  it("rejects an out-of-range month instead of steering the picker to it", () => {
    expect(parseShownPeriod("13 / 2026")).toBeNull();
    expect(parseShownPeriod("00 / 2026")).toBeNull();
  });

  it("does not accept a dd/mm/yyyy date as a period", () => {
    // A day-first date would otherwise read as month 27.
    expect(parseShownPeriod("27/07/2026")).toBeNull();
  });

  it("gives the same answer on repeated calls", () => {
    expect(parseShownPeriod("06 / 2026")).toEqual({ month: 6, year: 2026 });
    expect(parseShownPeriod("06 / 2026")).toEqual({ month: 6, year: 2026 });
  });
});

describe("previousPeriod / formatPeriod", () => {
  it("steps back one month", () => {
    expect(previousPeriod({ month: 6, year: 2026 })).toEqual({ month: 5, year: 2026 });
  });

  it("rolls into the previous year at January", () => {
    expect(previousPeriod({ month: 1, year: 2026 })).toEqual({ month: 12, year: 2025 });
  });

  it("walks a full year back without skipping or repeating a period", () => {
    let period = { month: 6, year: 2026 };
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      period = previousPeriod(period);
      seen.push(formatPeriod(period));
    }
    expect(seen).toEqual([
      "05/2026", "04/2026", "03/2026", "02/2026", "01/2026",
      "12/2025", "11/2025", "10/2025", "09/2025", "08/2025", "07/2025", "06/2025",
    ]);
    expect(new Set(seen).size).toBe(12);
  });

  it("zero-pads the month to match the picker input", () => {
    expect(formatPeriod({ month: 6, year: 2026 })).toBe("06/2026");
    expect(formatPeriod({ month: 12, year: 2026 })).toBe("12/2026");
  });
});

describe("periodInputMatches", () => {
  it("accepts the spaced form the widget writes", () => {
    expect(periodInputMatches("06 / 2026", { month: 6, year: 2026 })).toBe(true);
  });

  it("accepts it unspaced", () => {
    expect(periodInputMatches("06/2026", { month: 6, year: 2026 })).toBe(true);
  });

  it("rejects a different period, so a failed requery is caught", () => {
    expect(periodInputMatches("06 / 2026", { month: 5, year: 2026 })).toBe(false);
    expect(periodInputMatches("06 / 2026", { month: 6, year: 2025 })).toBe(false);
  });

  it("rejects an empty input", () => {
    expect(periodInputMatches("", { month: 6, year: 2026 })).toBe(false);
  });

  it("requires the zero-padded month the widget uses", () => {
    expect(periodInputMatches("6 / 2026", { month: 6, year: 2026 })).toBe(false);
  });
});

describe("AVAILABLE_BALANCE_RE / parseAvailableBalance", () => {
  it("reads the balance from the saldos page text", () => {
    expect(parseAvailableBalance("Saldo disponible para uso $ 1.234.567")).toBe(1234567);
  });

  it("reads it without the peso sign", () => {
    expect(parseAvailableBalance("Saldo disponible para uso 1.234.567")).toBe(1234567);
  });

  it("finds it inside a full page of text", () => {
    expect(parseAvailableBalance("Cuenta corriente\nSaldo disponible para uso $ 500\nOtros")).toBe(500);
  });

  it("keeps a negative balance negative", () => {
    // Stripping every non-digit dropped the sign and reported an overdrawn
    // account as if it held money.
    expect(parseAvailableBalance("Saldo disponible para uso $ -45.000")).toBe(-45000);
  });

  it("returns a real zero balance rather than undefined", () => {
    expect(parseAvailableBalance("Saldo disponible para uso $ 0")).toBe(0);
  });

  it("returns undefined when the label is absent", () => {
    expect(parseAvailableBalance("")).toBeUndefined();
    expect(parseAvailableBalance("Saldo contable $ 1.000")).toBeUndefined();
  });

  it("matches regardless of label casing", () => {
    expect(parseAvailableBalance("SALDO DISPONIBLE PARA USO $ 10")).toBe(10);
    expect(parseAvailableBalance("saldo disponible para uso $ 10")).toBe(10);
  });
});

describe("normalizeHeader", () => {
  it("lowercases and collapses the whitespace markup adds", () => {
    expect(normalizeHeader("  Fecha\n\t\tOperación ")).toBe("fecha operación");
  });
});

// ─── Column resolution ────────────────────────────────────────────

const ACCOUNT_LAST = ["Fecha", "Movimientos", "Observa Vale", "Cargos", "Abonos", "Saldo", "Montos"];
const ACCOUNT_CARTOLA = ["Fecha", "Nº Operación", "Movimientos", "Cargos", "Abonos", "Saldo"];
const BILLED = [
  "Lugar de operación", "Fecha operación", "Código referencia", "Descripción operación o cobro",
  "Monto Operación", "Monto total a pagar", "N° cuota", "Valor cuota",
];
const UNBILLED = ["Fecha compra", "Fecha proceso", "Descripción", "Ciudad", "Monto"];
const UNBILLED_CUOTAS = ["Fecha compra", "Fecha proceso", "Descripción", "Ciudad", "Cuotas", "Monto"];
const INTERNATIONAL = [
  "N° referencia internacional", "Fecha operación", "Descripción operación o cobro",
  "Ciudad", "País", "Monto Origen", "Monto USD",
];

describe("resolveAccountColumns", () => {
  it("maps the seven-column last-movements layout", () => {
    expect(resolveAccountColumns(ACCOUNT_LAST)).toEqual({
      date: 0, description: 1, cargo: 3, abono: 4, balance: 5,
    });
  });

  it("maps the six-column cartola layout, where the description moved", () => {
    // The regression that returned zero movements: fixed indices assumed one of
    // these two layouts and silently dropped the other.
    expect(resolveAccountColumns(ACCOUNT_CARTOLA)).toEqual({
      date: 0, description: 2, cargo: 3, abono: 4, balance: 5,
    });
  });

  it("survives a further column being inserted", () => {
    const headers = ["Fecha", "Nuevo", "Movimientos", "Otro", "Cargos", "Abonos", "Saldo"];
    expect(resolveAccountColumns(headers)).toEqual({
      date: 0, description: 2, cargo: 4, abono: 5, balance: 6,
    });
  });

  it("declines tables without both amount columns", () => {
    expect(resolveAccountColumns(BILLED)).toBeNull();
    expect(resolveAccountColumns(UNBILLED)).toBeNull();
    expect(resolveAccountColumns(INTERNATIONAL)).toBeNull();
    expect(resolveAccountColumns([])).toBeNull();
  });

  it("reports a missing description as -1 rather than defaulting to a real column", () => {
    const cols = resolveAccountColumns(["Fecha", "Cargos", "Abonos"]);
    expect(cols).not.toBeNull();
    expect(cols!.description).toBe(-1);
    expect(cols!.balance).toBe(-1);
  });
});

describe("resolveBilledColumns", () => {
  it("charges the period from Valor cuota and keeps Monto Operación apart", () => {
    expect(resolveBilledColumns(BILLED)).toEqual({
      date: 1, description: 3, amount: 7, operation: 4, installmentNumber: 6,
    });
  });

  it("does not confuse N° cuota with Valor cuota", () => {
    const cols = resolveBilledColumns(BILLED)!;
    expect(cols.amount).not.toBe(cols.installmentNumber);
  });

  it("falls back to Monto Operación only when Valor cuota is absent", () => {
    const headers = ["Fecha operación", "Descripción", "Monto Operación", "N° cuota"];
    expect(resolveBilledColumns(headers)).toEqual({
      date: 0, description: 1, amount: 2, operation: 2, installmentNumber: 3,
    });
  });

  it("refuses the international statement instead of reading Monto Origen", () => {
    // Its amounts are USD with dot decimals; parseChileanAmount would inflate
    // 23.80 to 2380, so there is no generic "monto" fallback.
    expect(resolveBilledColumns(INTERNATIONAL)).toBeNull();
  });

  it("refuses the unbilled table, whose Monto is not a statement charge", () => {
    expect(resolveBilledColumns(UNBILLED)).toBeNull();
  });

  it("refuses a table with no amount column at all", () => {
    expect(resolveBilledColumns(["Fecha operación", "Descripción"])).toBeNull();
  });
});

describe("resolveUnbilledColumns", () => {
  it("maps the compras-pesos layout", () => {
    expect(resolveUnbilledColumns(UNBILLED)).toEqual({ date: 0, description: 2, amount: 4 });
  });

  it("maps the resumen layout with its extra Cuotas column", () => {
    expect(resolveUnbilledColumns(UNBILLED_CUOTAS)).toEqual({ date: 0, description: 2, amount: 5 });
  });

  it("takes Fecha compra and never Fecha proceso, even when reordered", () => {
    const cols = resolveUnbilledColumns(["Fecha proceso", "Fecha compra", "Descripción", "Monto"])!;
    expect(cols.date).toBe(1);
  });

  it("declines the statement and the international views", () => {
    expect(resolveUnbilledColumns(BILLED)).toBeNull();
    expect(resolveUnbilledColumns(INTERNATIONAL)).toBeNull();
  });

  it("does not accept Monto total a pagar as the amount column", () => {
    expect(resolveUnbilledColumns(["Fecha compra", "Descripción"])).toBeNull();
  });
});

// ─── Row mapping ──────────────────────────────────────────────────

describe("mapAccountRow", () => {
  const cols = resolveAccountColumns(ACCOUNT_CARTOLA)!;

  it("reads a cargo as a debit", () => {
    const row = ["01/04/2026", "000000000", "Comercio uno", "$ 20.000", "$ 0", "$ -20.000"];
    expect(mapAccountRow(row, cols)).toEqual({
      date: "01-04-2026",
      description: "Comercio uno",
      amount: -20000,
      balance: -20000,
      source: MOVEMENT_SOURCE.account,
    });
  });

  it("reads an abono as a credit even though the cargo cell says $ 0", () => {
    const row = ["01/04/2026", "000000000", "Abono", "$ 0", "$ 20.000", "$ 0"];
    expect(mapAccountRow(row, cols)?.amount).toBe(20000);
  });

  it("handles an empty cargo cell as well as $ 0", () => {
    const lastCols = resolveAccountColumns(ACCOUNT_LAST)!;
    const row = ["27/07/2026", "Abono", "Abono", "", "$ 3.000", "$ 0", "$ 3.000"];
    expect(mapAccountRow(row, lastCols)?.amount).toBe(3000);
  });

  it("skips a row whose date cell is a label", () => {
    expect(mapAccountRow(["Total del periodo", "", "", "$ 1", "$ 0", "$ 0"], cols)).toBeNull();
  });

  it("skips a row with no movement in either column", () => {
    expect(mapAccountRow(["01/04/2026", "0", "Sin monto", "$ 0", "$ 0", "$ 0"], cols)).toBeNull();
  });

  it("does not throw when the row is shorter than the header", () => {
    expect(mapAccountRow(["01/04/2026"], cols)).toBeNull();
  });

  it("keeps a negative running balance", () => {
    const row = ["02/04/2026", "0", "Comercio", "$ 5.000", "$ 0", "$ -1.234.567"];
    expect(mapAccountRow(row, cols)?.balance).toBe(-1234567);
  });
});

describe("mapBilledRow", () => {
  const cols = resolveBilledColumns(BILLED)!;
  const row = (over: Partial<Record<number, string>> = {}) => {
    const base = ["Santiago", "24/03/2026", "1000000000000004", "Comercio tres", "$ 360.000", "$ 360.000", "02/3", "$ 120.000"];
    for (const [i, v] of Object.entries(over)) base[Number(i)] = v!;
    return base;
  };

  it("charges the instalment and records the purchase total separately", () => {
    expect(mapBilledRow(row(), cols)).toEqual({
      date: "24-03-2026",
      description: "Comercio tres",
      amount: -120000,
      balance: 0,
      source: MOVEMENT_SOURCE.credit_card_billed,
      installments: "02/03",
      totalAmount: 360000,
    });
  });

  it("never reports the whole purchase as this period's charge", () => {
    const movement = mapBilledRow(row(), cols)!;
    expect(Math.abs(movement.amount)).toBeLessThan(movement.totalAmount!);
  });

  it("omits totalAmount for a single-instalment purchase", () => {
    const single = row({ 4: "$ 12.000", 5: "$ 12.000", 6: "01/1", 7: "$ 12.000" });
    const movement = mapBilledRow(single, cols)!;
    expect(movement.amount).toBe(-12000);
    expect(movement.totalAmount).toBeUndefined();
    expect(movement.installments).toBe("01/01");
  });

  it("turns a negative page amount into a credit", () => {
    const payment = row({ 0: "", 3: "Monto cancelado", 4: "$ -50.000", 5: "$ -50.000", 6: "01/1", 7: "$ -50.000" });
    expect(mapBilledRow(payment, cols)?.amount).toBe(50000);
  });

  it("skips the subtotal row that carries no date", () => {
    expect(mapBilledRow(["Subtotal operaciones"], cols)).toBeNull();
  });

  it("skips a zero amount", () => {
    expect(mapBilledRow(row({ 7: "$ 0" }), cols)).toBeNull();
  });
});

describe("mapUnbilledRow", () => {
  const cols = resolveUnbilledColumns(UNBILLED)!;

  it("turns a purchase into a debit", () => {
    const row = ["26/07/2026", "27/07/2026", "Comercio uno compras", "Santiago", "$ 10.000"];
    expect(mapUnbilledRow(row, cols)).toEqual({
      date: "26-07-2026",
      description: "Comercio uno compras",
      amount: -10000,
      balance: 0,
      source: MOVEMENT_SOURCE.credit_card_unbilled,
    });
  });

  it("dates the movement by the purchase, not by when it posted", () => {
    const row = ["26/07/2026", "31/07/2026", "Comercio", "Santiago", "$ 10.000"];
    expect(mapUnbilledRow(row, cols)?.date).toBe("26-07-2026");
  });

  it("turns a reversal into a credit", () => {
    const row = ["24/07/2026", "24/07/2026", "Abono canje compra tc", "", "$ -4.000"];
    expect(mapUnbilledRow(row, cols)?.amount).toBe(4000);
  });
});

describe("extractFromTables", () => {
  const billedTable = { headers: BILLED, rows: [["Santiago", "14/06/2026", "1", "Comercio", "$ 12.000", "$ 12.000", "01/1", "$ 12.000"]] };

  it("skips tables whose headers do not resolve", () => {
    const tables = [
      { headers: ["Desde", "Hasta"], rows: [["Período facturado", "27/05/2026", "24/06/2026"]] },
      billedTable,
    ];
    const movements = extractFromTables(tables, resolveBilledColumns, mapBilledRow);
    expect(movements).toHaveLength(1);
    expect(movements[0].amount).toBe(-12000);
  });

  it("skips a resolving table that yields no rows and keeps looking", () => {
    const empty = { headers: BILLED, rows: [["Subtotal"]] };
    expect(extractFromTables([empty, billedTable], resolveBilledColumns, mapBilledRow)).toHaveLength(1);
  });

  it("returns nothing for a page with no usable table", () => {
    const tables = [{ headers: INTERNATIONAL, rows: [["X", "04/02/2026", "Servicio", "C", "US", "23.80", "23,80"]] }];
    expect(extractFromTables(tables, resolveBilledColumns, mapBilledRow)).toEqual([]);
    expect(extractFromTables([], resolveBilledColumns, mapBilledRow)).toEqual([]);
  });
});

// ─── Card summary ─────────────────────────────────────────────────

describe("parseUsd", () => {
  it("reads a dot as a thousand separator", () => {
    expect(parseUsd("USD 2.872")).toBe(2872);
  });

  it("reads a comma as the decimal separator", () => {
    expect(parseUsd("USD 68,78")).toBeCloseTo(68.78, 2);
  });

  it("keeps a negative sign", () => {
    expect(parseUsd("USD -68,78")).toBeCloseTo(-68.78, 2);
  });

  it("returns 0 for empty or non-numeric input instead of NaN", () => {
    expect(parseUsd("")).toBe(0);
    expect(parseUsd("USD")).toBe(0);
    expect(parseUsd("—")).toBe(0);
  });
});

describe("maskedCardLabel", () => {
  it("compresses the masked number to the last four digits", () => {
    expect(maskedCardLabel("Mastercard Gold", "**** **** **** 0000")).toBe("Mastercard Gold ****0000");
  });

  it("handles the dashed form used on the international statement", () => {
    expect(maskedCardLabel("Visa", "XXXX-XXXX-XXXX-1234")).toBe("Visa ****1234");
  });

  it("returns just the type when no digits are present", () => {
    expect(maskedCardLabel("Mastercard Gold", "**** **** **** ****")).toBe("Mastercard Gold");
  });

  it("returns an empty string when the page gave nothing", () => {
    expect(maskedCardLabel("", "")).toBe("");
  });
});

describe("buildCreditCard", () => {
  const summary: ItauCardSummary = {
    cardType: "Mastercard Gold",
    cardNumber: "**** **** **** 0000",
    nacTotal: "$ 2.000.000",
    nacAvailable: "$ 800.000",
    nacDebt: "$ 1.200.000",
    intTotal: "USD 2.000",
    intAvailable: "USD 2.000",
    intDebt: "USD 0",
    nextBillingDate: "28/07/2026",
    statementDate: "24/06/2026",
    statementAmount: "$ 262.000",
    statementDueDate: "07/07/2026",
    minimumPayment: "$ 0",
  };

  it("reads the stated quota rather than deriving any of it", () => {
    const card = buildCreditCard(summary, [])!;
    expect(card.national).toEqual({ used: 1200000, available: 800000, total: 2000000 });
  });

  it("records the statement with the due date, not the date of the last payment", () => {
    const card = buildCreditCard(summary, [])!;
    expect(card.lastStatement).toEqual({
      billingDate: "24-06-2026",
      billedAmount: 262000,
      dueDate: "07-07-2026",
      minimumPayment: 0,
    });
    expect(card.nextDueDate).toBe("07-07-2026");
    expect(card.nextBillingDate).toBe("28-07-2026");
  });

  it("reports the international quota in USD", () => {
    const card = buildCreditCard(summary, [])!;
    expect(card.international).toEqual({ used: 0, available: 2000, total: 2000, currency: "USD" });
  });

  it("omits the international block when the page shows no dollar quota", () => {
    const card = buildCreditCard({ ...summary, intTotal: "", intAvailable: "", intDebt: "" }, [])!;
    expect(card.international).toBeUndefined();
  });

  it("falls back to a generic label rather than dropping the movements", () => {
    const movements = [
      { date: "01-06-2026", description: "Comercio", amount: -1000, balance: 0, source: MOVEMENT_SOURCE.credit_card_billed },
    ];
    const card = buildCreditCard({ ...summary, cardType: "", cardNumber: "" }, movements)!;
    expect(card.label).toBe("Tarjeta Itaú");
    expect(card.movements).toHaveLength(1);
  });

  it("returns null when there is neither a card nor a movement", () => {
    const blank = Object.fromEntries(Object.keys(summary).map((k) => [k, ""])) as unknown as ItauCardSummary;
    expect(buildCreditCard(blank, [])).toBeNull();
  });

  it("keeps the movements it was handed", () => {
    const movements = [
      { date: "14-06-2026", description: "Comercio", amount: -12000, balance: 0, source: MOVEMENT_SOURCE.credit_card_billed },
    ];
    expect(buildCreditCard(summary, movements)!.movements).toBe(movements);
  });
});
