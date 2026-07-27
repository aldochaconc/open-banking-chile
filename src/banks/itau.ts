import type { Page } from "puppeteer-core";
import type { AccountBalance, BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import {
  closePopups,
  deduplicateMovements,
  delay,
  formatRut,
  normalizeDate,
  normalizeInstallments,
  parseChileanAmount,
} from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";

// ─── Itaú-specific constants ─────────────────────────────────────

const LOGIN_URL = "https://banco.itau.cl/wps/portal/newolb/web/login";
const PORTAL_BASE = "https://banco.itau.cl/wps/myportal/newolb/web";

const TWO_FACTOR_CONFIG = {
  keywords: ["itaú key", "aprueba", "segundo factor", "autoriza"],
  timeoutEnvVar: "ITAU_2FA_TIMEOUT_SEC",
};

/** Pages to walk per movement table before giving up on the paginator. */
const MAX_PAGES = 10;

/** Extra historical periods to fetch beyond the current one (0 = current only). */
function historicMonths(): number {
  return Math.min(Math.max(parseInt(process.env.ITAU_MONTHS || "0", 10) || 0, 0), 12);
}

// ─── Parsing (pure: regexes, column mapping, row mapping) ─────────
//
// Kept free of DOM access so every pattern is unit-testable without a
// browser and nothing here has to run inside page.evaluate.

/** A table harvested from the DOM as plain text. */
interface TableData {
  headers: string[];
  rows: string[][];
}

/** Lowercase and collapse whitespace so header matching survives markup padding. */
export function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

// ─── Dates ────────────────────────────────────────────────────────

/**
 * A movement row's date cell. Anchored on purpose: cells like
 * "Pagar hasta 07/07/2026" or "Período facturado" also contain dates, and
 * treating them as rows pulled summary blocks into the movement list.
 */
const ROW_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

export function isRowDate(cell: string): boolean {
  return ROW_DATE_RE.test(cell.trim());
}

// ─── Paginator ────────────────────────────────────────────────────

/** "Página 2 de 5" under the portal's movement tables. */
const PAGE_INFO_RE = /P[áa]gina\s+(\d+)\s+de\s+(\d+)/i;

/**
 * Whether the paginator leaves room for another page. Pages without a usable
 * counter return true so the caller falls through to looking for a next button.
 */
export function mayHaveMorePages(text: string): boolean {
  const match = text.match(PAGE_INFO_RE);
  if (!match) return true;
  const current = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  if (!current || !total) return true;
  return current < total;
}

// ─── Period picker ────────────────────────────────────────────────

interface Period {
  month: number;
  year: number;
}

/** "Saldo disponible para uso $ 1.234.567" on the cuenta corriente saldos page. */
const AVAILABLE_BALANCE_RE = /Saldo disponible para uso\s*\$?\s*(-?[\d.,]+)/i;

/**
 * Available balance from the saldos page text, or undefined when absent. Uses the
 * shared amount parser rather than stripping every non-digit, which discarded the
 * minus sign and reported an overdrawn account as a positive balance.
 */
export function parseAvailableBalance(pageText: string): number | undefined {
  const match = pageText.match(AVAILABLE_BALANCE_RE);
  if (!match) return undefined;
  return parseChileanAmount(match[1]);
}

/**
 * "06 / 2026" as shown in the picker's readonly input. Anchored: unanchored, it
 * matched the tail of a dd/mm/yyyy date, so "27/07/2026" read as month 7 and the
 * picker would have been steered to a period nobody selected.
 */
const PERIOD_LABEL_RE = /^(\d{1,2})\s*\/\s*(\d{4})$/;

export function parseShownPeriod(shown: string): Period | null {
  const match = shown.trim().match(PERIOD_LABEL_RE);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  const year = parseInt(match[2], 10);
  if (month < 1 || month > 12) return null;
  return { month, year };
}

/** Step back one month, rolling the year over at January. */
export function previousPeriod(period: Period): Period {
  return period.month === 1
    ? { month: 12, year: period.year - 1 }
    : { month: period.month - 1, year: period.year };
}

/** "06/2026" — the form the picker's input holds once whitespace is stripped. */
export function formatPeriod(period: Period): string {
  return `${String(period.month).padStart(2, "0")}/${period.year}`;
}

/** Whether the picker's input now shows `period`, used to confirm it requeried. */
export function periodInputMatches(inputValue: string, period: Period): boolean {
  return inputValue.replace(/\s/g, "") === formatPeriod(period);
}

// ─── Account / cartola table ──────────────────────────────────────

interface AccountColumns {
  date: number;
  description: number;
  cargo: number;
  abono: number;
  balance: number;
}

/**
 * Resolve the account table by header. Two layouts exist in the portal:
 *   Saldos y últimos movimientos: Fecha | Movimientos | Observa Vale | Cargos | Abonos | Saldo | Montos
 *   Cartola histórica:            Fecha | Nº Operación | Movimientos | Cargos | Abonos | Saldo
 * Fixed indices assumed the first layout without "Observa Vale" and silently
 * dropped every row once the column appeared, so nothing is positional here.
 */
export function resolveAccountColumns(headers: string[]): AccountColumns | null {
  const normalized = headers.map(normalizeHeader);
  const date = normalized.findIndex((h) => h.startsWith("fecha"));
  const cargo = normalized.findIndex((h) => h.startsWith("cargo"));
  const abono = normalized.findIndex((h) => h.startsWith("abono"));
  if (date < 0 || cargo < 0 || abono < 0) return null;
  return {
    date,
    description: normalized.findIndex(
      (h) => h.includes("movimiento") || h.includes("descrip") || h.includes("glosa"),
    ),
    cargo,
    abono,
    balance: normalized.findIndex((h) => h.startsWith("saldo")),
  };
}

/**
 * Cargo/abono row to a signed movement. Both columns are always present — the
 * unused side reads "$ 0" rather than empty — so the abono decides the sign.
 */
export function mapAccountRow(cells: string[], cols: AccountColumns): BankMovement | null {
  const date = cells[cols.date] ?? "";
  if (!isRowDate(date)) return null;
  const abono = parseChileanAmount(cells[cols.abono] ?? "");
  const cargo = parseChileanAmount(cells[cols.cargo] ?? "");
  const amount = abono > 0 ? abono : -cargo;
  if (amount === 0) return null;
  return {
    date: normalizeDate(date),
    description: cols.description >= 0 ? (cells[cols.description] ?? "").trim() : "",
    amount,
    balance: cols.balance >= 0 ? parseChileanAmount(cells[cols.balance] ?? "") : 0,
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── Billed statement table ───────────────────────────────────────

interface BilledColumns {
  date: number;
  description: number;
  /** Column charged in this period. */
  amount: number;
  /** Full purchase amount, when the table separates it. */
  operation: number;
  installmentNumber: number;
}

/**
 * Resolve the national statement table:
 *   Lugar | Fecha operación | Código referencia | Descripción | Monto Operación |
 *   Monto total a pagar | N° cuota | Valor cuota
 *
 * There is deliberately no generic "monto" fallback. It matched "Monto Origen" on
 * the international statement, whose USD amounts write decimals with a dot
 * ("23.80"); the Chilean amount parser strips dots and would have read 2380.
 */
export function resolveBilledColumns(headers: string[]): BilledColumns | null {
  const normalized = headers.map(normalizeHeader);
  const date = normalized.findIndex((h) => h.includes("fecha"));
  const description = normalized.findIndex((h) => h.includes("descrip") || h.includes("glosa"));
  if (date < 0 || description < 0) return null;
  const installmentValue = normalized.findIndex((h) => h.includes("valor cuota"));
  const operation = normalized.findIndex((h) => h.includes("monto operaci"));
  const amount = installmentValue >= 0 ? installmentValue : operation;
  if (amount < 0) return null;
  return {
    date,
    description,
    amount,
    operation,
    installmentNumber: normalized.findIndex((h) => h.includes("cuota") && !h.includes("valor")),
  };
}

/**
 * Statement row to the movement charged in this period. "Valor cuota" is the
 * monthly instalment and "Monto Operación" the whole purchase, so a $1.093.285
 * buy at 03/12 records −$91.107 with totalAmount $1.093.285. Reading the purchase
 * column instead overstated a statement roughly threefold.
 */
export function mapBilledRow(cells: string[], cols: BilledColumns): BankMovement | null {
  const date = cells[cols.date] ?? "";
  if (!isRowDate(date)) return null;
  const raw = parseChileanAmount(cells[cols.amount] ?? "");
  if (raw === 0) return null;

  // The page shows charges positive and credits (payments, reversals) negative.
  const movement: BankMovement = {
    date: normalizeDate(date),
    description: (cells[cols.description] ?? "").trim(),
    amount: raw > 0 ? -raw : Math.abs(raw),
    balance: 0,
    source: MOVEMENT_SOURCE.credit_card_billed,
  };

  if (cols.installmentNumber >= 0) {
    const installments = normalizeInstallments(cells[cols.installmentNumber]);
    if (installments) movement.installments = installments;
  }
  if (cols.operation >= 0 && cols.operation !== cols.amount) {
    const total = Math.abs(parseChileanAmount(cells[cols.operation] ?? ""));
    if (total > 0 && total !== Math.abs(movement.amount)) movement.totalAmount = total;
  }
  return movement;
}

// ─── Unbilled purchases table ─────────────────────────────────────

interface UnbilledColumns {
  date: number;
  description: number;
  amount: number;
}

/**
 * Resolve "Últimos movimientos en pesos":
 *   Fecha compra | Fecha proceso | Descripción | Ciudad | [Cuotas] | Monto
 * "fecha compra" is required so the "fecha proceso" column is never taken as the
 * transaction date, and so the billed statement cannot match this shape.
 */
export function resolveUnbilledColumns(headers: string[]): UnbilledColumns | null {
  const normalized = headers.map(normalizeHeader);
  const date = normalized.findIndex((h) => h.includes("fecha compra"));
  const description = normalized.findIndex((h) => h.includes("descrip"));
  const amount = normalized.findIndex((h) => h === "monto" || h.startsWith("monto "));
  if (date < 0 || description < 0 || amount < 0) return null;
  return { date, description, amount };
}

/** Unbilled row. Purchases print positive and credits negative, both flipped. */
export function mapUnbilledRow(cells: string[], cols: UnbilledColumns): BankMovement | null {
  const date = cells[cols.date] ?? "";
  if (!isRowDate(date)) return null;
  const raw = parseChileanAmount(cells[cols.amount] ?? "");
  if (raw === 0) return null;
  return {
    date: normalizeDate(date),
    description: (cells[cols.description] ?? "").trim(),
    amount: raw > 0 ? -raw : Math.abs(raw),
    balance: 0,
    source: MOVEMENT_SOURCE.credit_card_unbilled,
  };
}

// ─── Table driver ─────────────────────────────────────────────────

/**
 * Movements from the first table whose headers resolve and that yields rows.
 * Tables that do not resolve are skipped, which is how unsupported views such as
 * the international statement end up returning nothing instead of noise.
 */
export function extractFromTables<C>(
  tables: TableData[],
  resolve: (headers: string[]) => C | null,
  map: (cells: string[], cols: C) => BankMovement | null,
): BankMovement[] {
  for (const table of tables) {
    const cols = resolve(table.headers);
    if (!cols) continue;
    const movements: BankMovement[] = [];
    for (const row of table.rows) {
      const movement = map(row, cols);
      if (movement) movements.push(movement);
    }
    if (movements.length > 0) return movements;
  }
  return [];
}

// ─── Credit card summary ──────────────────────────────────────────

/** Figures the resumen page publishes through its own name= bindings. */
export interface ItauCardSummary {
  cardType: string;
  cardNumber: string;
  nacTotal: string;
  nacAvailable: string;
  nacDebt: string;
  intTotal: string;
  intAvailable: string;
  intDebt: string;
  nextBillingDate: string;
  statementDate: string;
  statementAmount: string;
  statementDueDate: string;
  minimumPayment: string;
}

/** USD amounts use Chilean punctuation: "2.872" is 2872, "68,78" is 68.78. */
export function parseUsd(text: string): number {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", ".");
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

/** "Mastercard Gold" + "**** **** **** 7929" → "Mastercard Gold ****7929". */
export function maskedCardLabel(cardType: string, cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, "").slice(-4);
  return [cardType.trim(), digits && `****${digits}`].filter(Boolean).join(" ").trim();
}

/** Assemble a CreditCardBalance, or null when the page yielded nothing usable. */
export function buildCreditCard(
  summary: ItauCardSummary,
  movements: BankMovement[],
): CreditCardBalance | null {
  const label = maskedCardLabel(summary.cardType, summary.cardNumber);
  if (!label && movements.length === 0) return null;

  const card: CreditCardBalance = { label: label || "Tarjeta Itaú", movements };

  const available = parseChileanAmount(summary.nacAvailable);
  const used = parseChileanAmount(summary.nacDebt);
  const total = parseChileanAmount(summary.nacTotal);
  // The resumen page always publishes CupoTotalNacional, so the total is read,
  // never derived.
  if (available || used || total) card.national = { used, available, total };

  if (summary.intAvailable || summary.intTotal) {
    const intAvailable = parseUsd(summary.intAvailable);
    const intTotal = parseUsd(summary.intTotal);
    card.international = {
      used: Math.abs(parseUsd(summary.intDebt)),
      available: intAvailable,
      total: intTotal || intAvailable,
      currency: "USD",
    };
  }

  if (summary.nextBillingDate) card.nextBillingDate = normalizeDate(summary.nextBillingDate);
  if (summary.statementDueDate) card.nextDueDate = normalizeDate(summary.statementDueDate);

  const billed = parseChileanAmount(summary.statementAmount);
  if (billed !== 0 && summary.statementDate) {
    card.lastStatement = {
      billingDate: normalizeDate(summary.statementDate),
      billedAmount: billed,
      dueDate: summary.statementDueDate ? normalizeDate(summary.statementDueDate) : "",
      ...(summary.minimumPayment
        ? { minimumPayment: parseChileanAmount(summary.minimumPayment) }
        : {}),
    };
  }

  return card;
}

// ─── Period picker (#boxMonthYear Dojo widget) ────────────────────
//
// Itaú has no <select> for periods. Both the credit card statement and the
// cartola use a Dojo month/year widget:
//   #calendarIcon opens it, #currentYear with #pre / #next steps the year,
//   #m1..#m12 are the months (class "disableMonth" = unavailable,
//   "selectedMonth" = current), and #resultShow shows "MM / YYYY".
// History is only ever walked backwards, so #pre is the only arrow used.

async function readShownPeriod(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    if (!document.querySelector("#boxMonthYear")) return null;
    const input = document.querySelector("#resultShow") as HTMLInputElement | null;
    return input?.value?.trim() || "";
  });
}

/**
 * Point the picker at `month`/`year` and wait for the portlet to requery.
 * Returns false when that period is not offered (future or beyond history).
 */
async function selectPickerPeriod(
  page: Page,
  month: number,
  year: number,
  debugLog: string[],
): Promise<boolean> {
  await page.evaluate(() => (document.querySelector("#calendarIcon") as HTMLElement | null)?.click());
  await delay(600);

  // Step the year arrows until the picker shows the target year. Verified after the
  // loop as well: a dead arrow would otherwise leave us clicking the right month in
  // the wrong year, silently returning another period's movements.
  const readYear = () => page.evaluate(() =>
    parseInt((document.querySelector("#currentYear") as HTMLElement | null)?.innerText?.trim() || "0", 10),
  );
  for (let hop = 0; hop < 14; hop++) {
    const shownYear = await readYear();
    if (shownYear === year) break;
    if (shownYear === 0) { debugLog.push("  picker: #currentYear not readable"); return false; }
    const moved = await page.evaluate(() => {
      const el = document.querySelector("#pre") as HTMLElement | null;
      if (!el || el.className.toLowerCase().includes("disable")) return false;
      el.click();
      return true;
    });
    if (!moved) { debugLog.push(`  picker: cannot reach year ${year}`); return false; }
    await delay(500);
  }
  if (await readYear() !== year) {
    debugLog.push(`  picker: year stuck, ${year} not reachable`);
    return false;
  }

  const clicked = await page.evaluate((m: number) => {
    const el = document.querySelector(`#m${m}`) as HTMLElement | null;
    if (!el || el.classList.contains("disableMonth")) return false;
    el.click();
    return true;
  }, month);
  if (!clicked) return false;
  await delay(3000);

  // The month click normally submits; fall back to the widget's hidden button.
  const applied = await page.evaluate(() => {
    const input = document.querySelector("#resultShow") as HTMLInputElement | null;
    return input?.value || "";
  });
  if (!periodInputMatches(applied, { month, year })) {
    await page.evaluate(() => (document.querySelector("#btn_hidden_cal") as HTMLElement | null)?.click());
    await delay(3000);
  }
  return true;
}

/**
 * Walk the picker backwards from the selected period, extracting each one.
 * Returns [] and logs why when the widget is not on the page.
 */
async function extractHistoricPeriods(
  page: Page,
  extract: (page: Page) => Promise<BankMovement[]>,
  months: number,
  label: string,
  debugLog: string[],
): Promise<BankMovement[]> {
  const shown = await readShownPeriod(page);
  if (shown === null) {
    debugLog.push(`  ${label}: no #boxMonthYear picker on this page`);
    return [];
  }
  const current = parseShownPeriod(shown);
  if (!current) {
    debugLog.push(`  ${label}: could not read period from "${shown}"`);
    return [];
  }
  debugLog.push(`  ${label}: current period ${shown}`);

  const all: BankMovement[] = [];
  let period: Period = current;
  for (let i = 0; i < months; i++) {
    period = previousPeriod(period);
    const tag = formatPeriod(period);
    if (!(await selectPickerPeriod(page, period.month, period.year, debugLog))) {
      debugLog.push(`  ${label}: period ${tag} unavailable, stopping`);
      break;
    }
    all.push(...(await itauPaginate(page, extract, debugLog, `${label} ${tag}`)));
  }
  return all;
}

/** Iterate the portal paginator (a[name="nextbtn"] + "Página N de M"), extracting each page. */
async function itauPaginate(
  page: Page,
  extract: (page: Page) => Promise<BankMovement[]>,
  debugLog: string[],
  label: string,
): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const batch = await extract(page);
    all.push(...batch);
    debugLog.push(`  ${label} page ${pageNum}: ${batch.length} movements`);

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    if (!mayHaveMorePages(bodyText)) break;
    const clicked = await page.evaluate(() => {
      const next = document.querySelector('a[name="nextbtn"]') as HTMLElement | null;
      if (!next) return false;
      next.click();
      return true;
    });
    if (!clicked) break;
    await delay(3000);
  }
  return all;
}

// ─── Itaú-specific helpers ───────────────────────────────────────

async function itauLogin(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to login page...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await doSave(page, "01-login");

  debugLog.push("2. Filling RUT...");
  const rutEl = await page.$("#loginNameID");
  if (!rutEl) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de RUT (#loginNameID)", screenshot: ss as string };
  }
  await rutEl.click({ count: 3 });
  await rutEl.type(formatRut(rut), { delay: 45 });

  debugLog.push("3. Filling password...");
  const passEl = await page.$("#pswdId");
  if (!passEl) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de clave (#pswdId)", screenshot: ss as string };
  }
  await passEl.click();
  await passEl.type(password, { delay: 45 });

  debugLog.push("4. Submitting login...");
  await doSave(page, "02-pre-submit");
  await page.evaluate(() => { const btn = document.getElementById("btnLoginRecaptchaV3"); if (btn) btn.click(); });
  try { await page.waitForNavigation({ timeout: 20000 }); } catch { /* SPA */ }
  await delay(3000);
  await doSave(page, "03-after-submit");

  // Login error check
  const errorText = await page.evaluate(() => {
    const sels = ['[class*="error"]', '[class*="alert"]', '[role="alert"]', ".msg-error-input"];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const t = (el as HTMLElement).innerText?.trim();
        if (t && t.length > 3 && t.length < 300 && (el as HTMLElement).offsetParent !== null) {
          const lower = t.toLowerCase();
          if (lower.includes("incorrecto") || lower.includes("bloqueada") || lower.includes("suspendida") || lower.includes("inválido")) return t;
        }
      }
    }
    return null;
  });
  if (errorText) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${errorText}`, screenshot: ss as string };
  }

  // 2FA
  if (await detect2FA(page, TWO_FACTOR_CONFIG)) {
    debugLog.push("5. 2FA detected...");
    await doSave(page, "04-2fa");
    const approved = await waitFor2FA(page, debugLog, TWO_FACTOR_CONFIG);
    if (!approved) {
      const ss = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "2FA no fue aprobado a tiempo (Itaú Key)", screenshot: ss as string };
    }
    await delay(3000);
  }

  debugLog.push("5. Login OK!");
  return { success: true };
}

async function extractBalance(page: Page, debugLog: string[]): Promise<number | undefined> {
  debugLog.push("6. Extracting balance...");
  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(2000);
  const pageText = await page.evaluate(() => document.body?.innerText || "");
  const balance = parseAvailableBalance(pageText);
  if (balance !== undefined) debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
  return balance;
}

/**
 * Every table on the page as plain text. The only DOM step in extraction —
 * resolving columns and mapping rows happens in itau-parsing.ts, where it is
 * unit-tested without a browser.
 */
async function harvestTables(page: Page): Promise<TableData[]> {
  return page.evaluate(() => {
    const text = (el: Element) => (el as HTMLElement).innerText?.trim() || "";
    return Array.from(document.querySelectorAll("table")).map((table) => ({
      headers: Array.from(table.querySelectorAll("th")).map(text),
      rows: Array.from(table.querySelectorAll("tr")).map((row) =>
        Array.from(row.querySelectorAll("td")).map(text),
      ),
    }));
  });
}

/** One page of the account / cartola movements table. */
export async function extractAccountPage(page: Page): Promise<BankMovement[]> {
  return extractFromTables(await harvestTables(page), resolveAccountColumns, mapAccountRow);
}

/** One page of "Últimos movimientos en pesos" (unbilled card activity). */
export async function extractUnbilledPage(page: Page): Promise<BankMovement[]> {
  return extractFromTables(await harvestTables(page), resolveUnbilledColumns, mapUnbilledRow);
}

/** One page of the national statement table. */
export async function extractBilledPage(page: Page): Promise<BankMovement[]> {
  return extractFromTables(await harvestTables(page), resolveBilledColumns, mapBilledRow);
}

async function extractMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("7. Extracting movements...");
  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const allMovements = await itauPaginate(page, extractAccountPage, debugLog, "cuenta");

  const months = historicMonths();
  if (months > 0) {
    // "Saldos y últimos movimientos" carries no period picker; the history lives
    // behind Cartola histórica (sidebar link linkCcCartolaHistorica_a).
    debugLog.push(`7b. Fetching up to ${months} historical period(s) from Cartola histórica...`);
    await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/cartola-historica`, { waitUntil: "networkidle2", timeout: 20000 });
    await delay(3000);
    allMovements.push(...(await extractHistoricPeriods(page, extractAccountPage, months, "cartola", debugLog)));
  }

  return allMovements;
}

// ─── Credit card summary ("Resumen tarjeta de crédito") ───────────

/**
 * Read the resumen page's figures by their name attributes. The portal tags every
 * value ("CupoTotalNacional", "DeudaNacional", …), which beats matching labels in
 * innerText where marketing copy repeats phrases like "cupo disponible".
 */
export async function extractCardSummary(page: Page): Promise<ItauCardSummary> {
  return page.evaluate(() => {
    const read = (name: string) =>
      (document.querySelector(`[name="${name}"]`) as HTMLElement | null)?.innerText?.trim() || "";
    return {
      cardType: read("descTarjeta"),
      cardNumber: read("numTarjeta"),
      nacTotal: read("CupoTotalNacional"),
      nacAvailable: read("CupoDisponiblePesos"),
      nacDebt: read("DeudaNacional"),
      intTotal: read("CupoTotalInternacional"),
      intAvailable: read("CupoDisponibleDolar"),
      intDebt: read("DeudaInternacional"),
      nextBillingDate: read("FechaProximaFacturacion"),
      statementDate: read("FechaFinPeriodoFacturacion"),
      statementAmount: read("TotalDeudaFacturadaPesos"),
      // Last date to pay the current statement, not the date the client last paid
      // (that one is fechaUltimoPagoNacional).
      statementDueDate: read("FechaUltimoPago"),
      minimumPayment: read("PagoMinimo"),
    };
  });
}


async function extractCreditCardData(page: Page, debugLog: string[]): Promise<CreditCardBalance[]> {
  debugLog.push("8. Extracting credit card data...");
  const movements: BankMovement[] = [];

  await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/deuda`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const summary = await extractCardSummary(page);
  debugLog.push(`  Card: ${summary.cardType || "?"} | cupo total ${summary.nacTotal || "?"} | disponible ${summary.nacAvailable || "?"}`);

  // No facturados — from the dedicated "Últimos movimientos en pesos" view rather
  // than the summary page, where the rows had to be found by guessing which table
  // followed a heading containing "no facturad".
  await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/compras-pesos`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);
  const noFacturados = await itauPaginate(page, extractUnbilledPage, debugLog, "no facturados");
  movements.push(...noFacturados);
  debugLog.push(`  No-facturados: ${noFacturados.length}`);

  // Facturados — current statement, then earlier ones when ITAU_MONTHS is set
  await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/cuenta-nacional`, { waitUntil: "networkidle2", timeout: 20000 });
  await delay(3000);

  const facturados = await itauPaginate(page, extractBilledPage, debugLog, "facturados");
  movements.push(...facturados);
  debugLog.push(`  Facturados: ${facturados.length}`);

  const months = historicMonths();
  if (months > 0) {
    debugLog.push(`8b. Fetching up to ${months} historical statement(s)...`);
    const historic = await extractHistoricPeriods(page, extractBilledPage, months, "estado de cuenta", debugLog);
    movements.push(...historic);
    debugLog.push(`  Historical statements: ${historic.length} movements`);
  }

  const cardMovements = deduplicateMovements(movements);
  const card = buildCreditCard(summary, cardMovements);
  if (!card) {
    debugLog.push("  No credit card found");
    return [];
  }

  // Dollar purchases live on resumen/cuenta-internacional, which this scraper does
  // not read: its amounts are USD with dot decimals ("23.80") and the Chilean parser
  // would inflate them 100x. Warn rather than guess.
  const intDebt = card.international?.used ?? 0;
  debugLog.push(
    intDebt > 0
      ? `  WARN: deuda internacional de USD ${intDebt} detectada, pero los movimientos internacionales NO se extraen (resumen/cuenta-internacional sin soporte)`
      : "  WARN: movimientos internacionales no soportados (resumen/cuenta-internacional). Sin deuda internacional en este periodo.",
  );

  debugLog.push(`  TC total: ${cardMovements.length} movements`);
  return [card];
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeItau(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots } = options;
  const { onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "itau";
  const progress = onProgress || (() => {});

  progress("Abriendo sitio del banco...");
  const loginResult = await itauLogin(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return { success: false, bank, accounts: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  await closePopups(page);

  progress("Extrayendo saldo...");
  const balance = await extractBalance(page, debugLog);

  progress("Extrayendo movimientos de cuenta...");
  const accountMovements = await extractMovements(page, debugLog);
  progress(`Cuenta: ${accountMovements.length} movimientos`);

  progress("Extrayendo datos de tarjeta de crédito...");
  const creditCards = await extractCreditCardData(page, debugLog);

  const deduplicatedAccount = deduplicateMovements(accountMovements);
  const tcCount = creditCards.reduce((n, c) => n + (c.movements?.length ?? 0), 0);

  debugLog.push(`9. Total: ${deduplicatedAccount.length} account + ${tcCount} credit card movements`);
  progress(`Listo — ${deduplicatedAccount.length + tcCount} movimientos totales`);
  await doSave(page, "05-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64" })) as string : undefined;

  const accounts: AccountBalance[] = [{ balance, movements: deduplicatedAccount }];
  return { success: true, bank, accounts, creditCards: creditCards.length > 0 ? creditCards : undefined, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const itau: BankScraper = {
  id: "itau",
  name: "Itaú",
  url: "https://banco.itau.cl",
  scrape: (options) => runScraper("itau", options, {}, scrapeItau),
};

export default itau;
