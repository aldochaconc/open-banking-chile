# Itaú fixtures

Synthetic pages that mirror the **structure** of the Itaú portal — table headers,
column order, the `name=` value bindings and the Dojo period picker — with invented
names, amounts, merchants, card numbers and reference codes. No real account data
is committed here.

The values are chosen to preserve the relationships the extractors depend on:

- `card-statement-nacional.html` — `Valor cuota` equals `Monto Operación / N` on
  every instalment row, so a mapper that reads the purchase column instead of the
  per-period charge fails loudly.
- `card-resumen.html` — `CupoTotalNacional − CupoDisponiblePesos = DeudaNacional`,
  and `TotalDeudaFacturadaPesos` equals the sum of the statement's charges.
- `account-*.html` — `Saldo` is a running balance consistent with the cargo/abono
  columns, and both columns are populated (`$ 0` rather than empty) as the portal
  does on the cartola.
- `card-statement-internacional.html` — a view the scraper does **not** support.
  Its `Monto Origen` writes decimals with a dot (`23.80`), which the Chilean amount
  parser would read as 2380, so the extractors must decline it entirely.

## Checking against real pages

To verify against your own account without committing anything, save the pages
with Ctrl+S → "Webpage, Single File (.mhtml)" and point the suite at them:

```bash
ITAU_FIXTURE_DIR=~/Downloads npx vitest run test/banks/itau.integration.test.ts
```

Those files contain real personal data. Keep them outside the repository.
