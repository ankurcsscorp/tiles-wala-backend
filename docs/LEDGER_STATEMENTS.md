# Party ledger printing and PDF download

Open a customer or supplier, select **Ledger**, choose the store/date range, and use **Print Ledger** or **Download PDF**. Both actions are also available under Financial Reports → Customer / supplier ledger. The existing CSV export uses the same report model.

The supplied MyBillBook ledger was used as the layout reference: business name/address/contact details, party information, period summary, opening balance, chronological vouchers, payment mode, credit/debit, running balance, invoice due dates, closing balance and period totals. Existing transactions were not imported from the sample PDF.

## Balance rules

Opening balance is the signed sum of posted entries strictly before From date. With no From date, the statement starts at the beginning of available history and opening balance is zero; recorded opening adjustments appear as dated transactions. Closing balance includes all eligible posted entries through To date.

For customers, balance = debit − credit; positive is Dr (customer owes the store), negative is Cr (customer credit/advance). For suppliers, balance = credit − debit; positive is Cr (payable to supplier), negative is Dr (supplier owes the store). Period debit and credit totals exclude the synthetic opening/closing rows.

Posted allocated and unallocated receipt/payment portions are included exactly once. Returns and separately recorded refunds retain their existing ledger treatment. Reversed documents/payments stay excluded. No balance columns, original invoices or historical transaction values are rewritten.

All-store statements use one combined running balance in displayed date/store/type/source order. A separate `store_running_balance` remains in the API for store-specific analysis. Opening/closing totals, per-store bounds and transaction rows are read within a repeatable-read, read-only PostgreSQL snapshot. Default closing dates use Asia/Kolkata, including the period around local midnight. Dates are serialized as date-only strings.

## Screen and exports

Customer/supplier Ledger tabs now display date/store filters, opening/closing cards and rows, period totals, voucher/payment information, running balances and pagination. Financial Reports retains its transaction drill-down and CSV controls and adds print/PDF actions and opening/closing table rows.

Screen pages contain up to 100 rows. Print, PDF and CSV deliberately ignore screen limit/offset and include the entire selected period. More than 20,000 entries produces a clear request to choose a shorter period; the exporter does not silently truncate a statement. Empty periods still carry opening balance into closing balance and remain printable/downloadable.

PDF download generates an actual PDF attachment on the server. A4 output uses an embedded Noto Sans Devanagari font for Latin/Hindi names and rupee symbols, repeated table headers, wrapped cells and page numbers. Print opens a separate A4 HTML statement and waits for the embedded font before invoking the browser print dialog. If the browser blocks that window, the UI explains how to retry and keeps PDF download available. No remote font service is required during export.

Invoice due dates are shown as references. This change does not invent an overdue or paid status from the party's net balance, since advances/returns and per-invoice allocations are separate accounting facts.

## APIs and permissions

Existing reporting route:

- `GET /api/tiles/financial-reports/ledger/:partyType/:id` — paginated JSON, now with party/business metadata, period totals and date range.
- `GET .../:id/print` — full A4 HTML statement.
- `GET .../:id/pdf` — full downloadable PDF.
- `GET .../:id/export` — CSV with opening/closing and period totals.

Party profile routes:

- `GET /api/tiles/customers/:id/ledger/report`, `/print`, `/pdf`.
- `GET /api/tiles/suppliers/:id/ledger/report`, `/print`, `/pdf`.

`storeId`, `fromDate` and `toDate` apply consistently. Existing customer/supplier `/:id/ledger` array endpoints remain available for existing integrations. Reporting endpoints require `reports.view`; party-profile endpoints require the corresponding customer/supplier view permission. Every operation checks authorized store scope. Party search can be reused by report viewers without granting master editing. Export responses use `private, no-store` cache control; HTML fields are escaped and filenames sanitized.

## Implementation and deployment

Backend: `src/services/partyLedger.js` shares accounting queries across screen/export requests. `src/services/ledgerDocument.js` renders HTML/PDF and exact decimal labels. `src/controllers/financialReports.js` and financial/customer/supplier routes expose these operations. PDFKit is added to `package.json`/lockfile. Include `assets/fonts/NotoSansDevanagari.ttf` and `assets/fonts/OFL.txt` when deploying the backend; the font and license come from the [Google Fonts repository](https://github.com/google/fonts/tree/main/ofl/notosansdevanagari). Font embedding follows the [PDFKit font documentation](https://pdfkit.org/docs/text.html#fonts).

Frontend: shared `PartyLedger.jsx`, `LedgerActions.jsx`, `PartyLedger.css` and `utils/ledgerMoney.js`; customer/supplier pages embed the new ledger tab, and FinancialReporting exposes the same export actions. Monetary display preserves paise using integer decimal formatting.

No database migration is needed.

## Verification

Tests cover nonzero carried opening balances, period debit/credit reconciliation, allocated/unallocated payment portions, all-store running balances, supplier Dr/Cr conventions, empty periods, authorization, invalid dates, missing parties, full exports beyond the visible page, CSV totals, PDF generation/pagination, Hindi text, HTML escaping, large monetary values, filename safety, download/print behavior and browser pop-up errors. Database fixtures roll back.

The generated one-page PDF was rendered and visually reviewed against the reference. A long PDF was checked for repeated page headers, page counts and the final closing/totals rows. Physical printer output and browser-specific print dialogs remain manual acceptance checks.

Final verification: 160 backend tests passed with PostgreSQL access (zero skipped), 229 frontend tests passed across 40 suites, and the production build compiled successfully. Existing build advisories about bundle size and Browserslist remain.

Pagination correction: PDF ending space is measured from the actual closing/period-total rows and explanatory text. Short statements can keep that ending on their current page; when space is insufficient, the financial ending moves together to a continuation page instead of producing a page containing only notes. Regression coverage includes a ten-transaction one-page statement and several overflow boundaries. Verification: 162 backend tests passed; the corrected ten-entry PDF was rendered and visually checked.
