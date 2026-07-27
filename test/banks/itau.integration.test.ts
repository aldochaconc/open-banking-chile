/**
 * Runs the Itaú DOM extractors in a real browser against the fixtures in
 * test/fixtures/itau. Those are synthetic pages mirroring the portal's structure,
 * so this covers the part unit tests cannot: that the harvester reads the tables
 * and the summary bindings the way the parsers expect.
 *
 * To check against your own saved pages instead, without committing them:
 *   ITAU_FIXTURE_DIR=~/Downloads npx vitest run test/banks/itau.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BankMovement } from "../../src/types.js";
import {
  extractAccountPage,
  extractBilledPage,
  extractCardSummary,
  extractUnbilledPage,
} from "../../src/banks/itau.js";
import { findChrome } from "../../src/utils.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "itau");
const REAL_DIR = process.env.ITAU_FIXTURE_DIR?.replace(/^~/, process.env.HOME ?? "~");

const chrome = findChrome();

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** Decode the single quoted-printable HTML part of a page saved as .mhtml. */
function readMhtml(path: string): string {
  const raw = readFileSync(path, "latin1");
  const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  const decoded = body
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(decoded, "binary").toString("utf8");
}

// ─── Invariants asserted for both fixtures and real pages ─────────

function assertAccountInvariants(movements: BankMovement[]): void {
  expect(movements.length).toBeGreaterThan(0);
  for (const m of movements) {
    expect(m.date).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(m.amount).not.toBe(0);
    expect(m.source).toBe("account");
  }
  // Cargos must land as debits and abonos as credits, not all one sign.
  expect(movements.some((m) => m.amount < 0)).toBe(true);
  expect(movements.some((m) => m.amount > 0)).toBe(true);
}

function assertBilledInvariants(movements: BankMovement[]): void {
  expect(movements.length).toBeGreaterThan(0);
  // An instalment is a fraction of the purchase total the statement also shows.
  for (const m of movements.filter((x) => x.installments && x.installments !== "01/01")) {
    expect(m.totalAmount).toBeDefined();
    expect(m.totalAmount!).toBeGreaterThan(Math.abs(m.amount));
  }
  // Payments are credits. Matched on "cancelado" alone — "pago" would also hit
  // merchant names like "Mercadopago".
  for (const p of movements.filter((x) => /\bcancelado\b/i.test(x.description))) {
    expect(p.amount).toBeGreaterThan(0);
  }
  expect(movements.some((m) => m.amount < 0)).toBe(true);
}

function assertUnbilledInvariants(movements: BankMovement[]): void {
  expect(movements.length).toBeGreaterThan(0);
  for (const m of movements) {
    expect(m.date).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(m.source).toBe("credit_card_unbilled");
  }
  expect(movements.some((m) => m.amount < 0)).toBe(true);
}

async function assertUnsupported(page: Page): Promise<void> {
  // The international statement prices in USD with dot decimals ("23.80"), which
  // parseChileanAmount would read as 2380. Reading it by accident is worse than
  // not reading it, so every extractor must decline.
  expect(await extractBilledPage(page)).toEqual([]);
  expect(await extractAccountPage(page)).toEqual([]);
  expect(await extractUnbilledPage(page)).toEqual([]);
}

describe.skipIf(!chrome)("Itaú DOM extraction", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: chrome!, headless: true });
    page = await browser.newPage();
  }, 60000);

  afterAll(async () => { await browser?.close(); });

  it("reads the seven-column last-movements table", async () => {
    await page.setContent(fixture("account-ultimos-movimientos.html"));
    const movements = await extractAccountPage(page);

    assertAccountInvariants(movements);
    // The dateless total row must not have become a movement.
    expect(movements).toHaveLength(4);
    expect(movements[0]).toEqual({
      date: "27-07-2026",
      description: "Abono desde linea de credito",
      amount: 3000,
      balance: 0,
      source: "account",
    });
    expect(movements[1].amount).toBe(-3000);
  }, 30000);

  it("reads the six-column cartola table with the same extractor", async () => {
    await page.setContent(fixture("account-cartola-historica.html"));
    const movements = await extractAccountPage(page);

    assertAccountInvariants(movements);
    expect(movements).toHaveLength(4);
    expect(movements.map((m) => m.amount)).toEqual([-20000, 20000, 500000, -5000]);
    // Description sits in a different column here than in the other layout.
    expect(movements[0].description).toBe("Comercio uno santiago");
    expect(movements[2].balance).toBe(500000);
  }, 30000);

  it("charges the statement at the instalment, matching the stated total", async () => {
    await page.setContent(fixture("card-statement-nacional.html"));
    const movements = await extractBilledPage(page);

    assertBilledInvariants(movements);
    expect(movements).toHaveLength(5);
    // Charges only, excluding the payment, equal the statement total.
    const charges = movements.filter((m) => m.amount < 0).reduce((sum, m) => sum - m.amount, 0);
    expect(charges).toBe(262000);
    // Net including the payment.
    expect(movements.reduce((sum, m) => sum + m.amount, 0)).toBe(-212000);

    const twelve = movements.find((m) => m.installments === "03/12")!;
    expect(twelve.amount).toBe(-100000);
    expect(twelve.totalAmount).toBe(1200000);

    expect(movements.find((m) => m.description === "Monto cancelado")!.amount).toBe(50000);
  }, 30000);

  it("ignores the statement's summary tables, which also hold dates", async () => {
    await page.setContent(fixture("card-statement-nacional.html"));
    const movements = await extractBilledPage(page);
    expect(movements.some((m) => /período|pagar hasta/i.test(m.description))).toBe(false);
  }, 30000);

  it("signs unbilled purchases and credits", async () => {
    await page.setContent(fixture("card-unbilled-pesos.html"));
    const movements = await extractUnbilledPage(page);

    assertUnbilledInvariants(movements);
    expect(movements).toHaveLength(4);
    expect(movements.map((m) => m.amount)).toEqual([-10000, -25000, 4000, 262000]);
    // Dated by the purchase, not by when it posted.
    expect(movements[0].date).toBe("26-07-2026");
  }, 30000);

  it("reads the unbilled table on the resumen page too, past its extra Cuotas column", async () => {
    await page.setContent(fixture("card-resumen.html"));
    const movements = await extractUnbilledPage(page);
    expect(movements.map((m) => m.amount)).toEqual([-10000, 4000]);
  }, 30000);

  it("reads the resumen figures from their name bindings", async () => {
    await page.setContent(fixture("card-resumen.html"));
    const summary = await extractCardSummary(page);

    expect(summary).toEqual({
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
    });
    // The quotas must be internally consistent, proving the right spans were read.
    expect(2000000 - 800000).toBe(1200000);
  }, 30000);

  it("extracts nothing from the unsupported international statement", async () => {
    await page.setContent(fixture("card-statement-internacional.html"));
    await assertUnsupported(page);
  }, 30000);
});

// ─── Optional pass over real saved pages ──────────────────────────

interface RealPage { name: string; html: string }

/** The joined <th> labels of each table, lowercased. */
function tableHeaders(html: string): string[] {
  return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(([, body]) =>
    [...body.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
      .map(([, cell]) => cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .join(" | ")
      .toLowerCase(),
  );
}

function loadRealPages(): { account: RealPage[]; billed: RealPage[]; unbilled: RealPage[]; other: RealPage[] } {
  const found = { account: [] as RealPage[], billed: [] as RealPage[], unbilled: [] as RealPage[], other: [] as RealPage[] };
  if (!REAL_DIR) return found;
  for (const name of readdirSync(REAL_DIR).filter((n) => n.toLowerCase().endsWith(".mhtml"))) {
    const html = readMhtml(join(REAL_DIR, name));
    const headers = tableHeaders(html);
    const has = (pred: (h: string) => boolean) => headers.some(pred);
    if (has((h) => h.includes("valor cuota"))) found.billed.push({ name, html });
    else if (has((h) => h.includes("fecha compra"))) found.unbilled.push({ name, html });
    else if (has((h) => h.includes("cargos") && h.includes("abonos"))) found.account.push({ name, html });
    else found.other.push({ name, html });
  }
  return found;
}

describe.skipIf(!REAL_DIR || !chrome)("Itaú extraction against real saved pages", () => {
  let browser: Browser;
  let page: Page;
  const pages = loadRealPages();

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: chrome!, headless: true });
    page = await browser.newPage();
  }, 60000);

  afterAll(async () => { await browser?.close(); });

  it("found saved pages to check", () => {
    const total = pages.account.length + pages.billed.length + pages.unbilled.length;
    expect(total).toBeGreaterThan(0);
  });

  it.each(pages.account)("reads $name", async ({ html }) => {
    await page.setContent(html);
    assertAccountInvariants(await extractAccountPage(page));
  }, 30000);

  it.each(pages.billed)("bills $name at the instalment", async ({ html }) => {
    await page.setContent(html);
    assertBilledInvariants(await extractBilledPage(page));
  }, 30000);

  it.each(pages.unbilled)("signs $name", async ({ html }) => {
    await page.setContent(html);
    assertUnbilledInvariants(await extractUnbilledPage(page));
  }, 30000);

  it.each(pages.other)("extracts nothing from the unsupported $name", async ({ html }) => {
    await page.setContent(html);
    await assertUnsupported(page);
  }, 30000);
});
