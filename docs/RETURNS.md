# Sales and purchase return invoices

The return modules reuse the existing return, invoice, payments, stock movements, invoice sequences, party adjustments and audit tables. No second accounting system or editable outstanding-balance field is introduced.

## Entry and review

- Sales Return: `/returns/sales/new`.
- Purchase Return: `/returns/purchase/new`.
- History: `/returns`.
- Details: `/returns/:type/:id`; draft editing: `/returns/:type/:id/edit`.

Choose an authorized store and customer/supplier. Sales returns can select several original posted bills for that customer in the same store; purchase returns keep their original single-invoice selection. Party search reuses the existing name/mobile search components; authorized users can open the existing Add Customer form. The party balance includes posted invoices, allocated and unapplied payments, effective returns and balance adjustments.

Invoice lookup shows invoice number, date, amount and remaining returnable amount. Sales product lookup spans all selected bills, includes the source bill and rate, and keeps identical products from different bills as separate original-item rows. Purchase lookup remains restricted to its invoice's saved lines and shows SKU, name, size, unit and remaining quantity. This store policy does not authorize unlinked returns: the interface explains the requirement and the server rejects missing original references. It does not assume a catalog product was sold by this store.

The responsive entry rows show Product Name, Quantity, Unit, Rate, Line Total and Remove. Sales rows include Sellable, Damaged and Pending Inspection; new rows default to Pending Inspection. Purchase rows select Sellable or Damaged stock. Original quantities, previous returns, remaining quantities and relevant stock balances appear with the rows.

Saving a draft does not post stock, credit or a refund. The number is assigned from the existing store-specific return sequence when a draft is saved. An unapproved version-2 draft can be edited; a sales draft can add/remove source bills while retaining the same customer and store. A purchase draft retains its original invoice. Finalize opens a review showing party, original invoice, quantities, amounts, stock disposition, outstanding adjustment, refund and retained credit. Confirm performs posting. A stable request key allows retry after a lost response without a second draft or posting.

History supports return type, search, party, dates, status and the workspace store selector. It shows settlement amounts and links to details. Details include original references, allocations, actual refund payment references, inspection balances, ledger links and printing. Finalized documents are immutable.

## Calculations

All authoritative amounts use PostgreSQL `NUMERIC`, with currency rounded to paise and inventory quantities to four decimal places. The browser displays server-calculated previews and never supplies trusted totals.

For an undiscounted non-tax original line, line total is quantity × rate. For a discounted or GST original, the credit uses the saved original taxable value and tax amounts in proportion to quantity and any authorized reduced rate. This preserves the original discount rather than refunding the undiscounted catalog amount. The last original-rate return absorbs remaining eligible rounding cents, without exceeding the original line value. CGST/SGST/IGST components are bounded by the original component budgets; repeated tiny returns cannot create additional tax through rounding.

Rates default to the saved original price. Only store managers/owners or Admin can lower a rate, and a reason is required. Rates above the original are rejected. The original invoice price and total never change. Product-master GST rate changes and later store billing defaults do not change historical return tax calculations.

Quantity must be positive, respect the original unit's permitted decimal precision, and fit the remaining posted returnable quantity. Original conversion factors are snapshotted into return lines; changes to catalog conversions do not change return stock quantities. Purchase eligibility is limited to quantities actually received, capped by the invoice quantity. Discontinued/inactive products remain returnable through their original invoice; foreign keys preserve referenced product records.

A price concession may leave part of the original monetary value uncredited after all physical quantity is returned; the application does not create an extra financial-only return automatically. Freight, miscellaneous invoice charges and rounding adjustments are not silently refunded as products.

## Settlement

Each new return chooses one of:

| Mode | Result |
| --- | --- |
| Adjust Against Outstanding | Apply up to the party's positive net outstanding, oldest due invoice first in this store; retain any remainder. |
| Keep as Customer/Supplier Credit | Make no invoice allocation; retain the full eligible return credit. |
| Refund Now / Refund Received | First apply against outstanding, then record the entered actual refund from remaining credit; retain any remainder. |

Invoice allocation order is invoice date then ID. Credit cannot exceed the target invoice's due amount, the available return credit or the party/store boundary. Existing advances already reduce net outstanding; the return does not consume the same outstanding twice. Amounts not allocatable to invoices, including opening-balance-related credit, remain explicit party credit.

Example: outstanding ₹2,000 and return ₹5,000 allocates ₹2,000 and retains ₹3,000. A fully paid invoice returning ₹4,000 creates ₹4,000 credit unless an actual refund is entered. No cash entry is fabricated simply because a credit exists.

Retained credit can subsequently be applied from return details to future due invoices. This appends allocations and leaves the party's net balance unchanged. Cash refunds are separate rows in the existing `payments` table, linked to the return, with actual method, amount, date and reference. Customer refunds are cash out; supplier refunds are cash in. These payments cannot be allocated as ordinary receipts/payments. Payment history and daily collections distinguish refunds from regular customer collections and supplier payments.

Effective return credit is return total less the actual posted refund. Reversing a refund reopens that credit without editing the original return. Party ledgers show the gross return and refund separately; invoice due balances use applied return credits. Reporting therefore counts each return/refund once.

## Stock, transactions and correction

Sellable sales returns increase the existing `stock_movements` ledger only after the operator declares goods physically received and accepted. Damaged and Pending Inspection enter an append-only non-sellable ledger, `return_inventory_movements`, and do not increase available sellable stock. Pending inspection can subsequently be moved to sellable or damaged with reason, actor, original conversion and idempotency key. Quantities are tracked in base units.

Purchase returns remove stock from the selected store's sellable or damaged bucket. Preview checks stock; posting locks and checks it again. Negative bucket balances are blocked in PostgreSQL. There is no warehouse/reservation subsystem to invent or bypass in this application.

Finalization uses one transaction: authorize; lock return and party invoices in deterministic order; recheck original eligibility and saved values; lock bucket and sellable balances in product order; validate settlement and refund method; append credit allocations and actual refund; update status/approval; run inventory and bonus hooks; audit; commit. Any failure rolls everything back. Concurrent finalizations lock the original invoice, so competing drafts cannot return the same quantity twice.

Cancellation closes a draft without posting. Reversing a posted return requires a reason and manager authorization. Recorded refunds must first be reversed in Payments. Return reversal appends stock/bucket compensations, including inspection movements in reverse event order; active return credit disappears from invoice/party projections while its allocation evidence remains immutable. Related sales bonus deductions receive compensating adjustments. If dependent stock has already been used, reversal fails atomically instead of creating a negative balance.

Original invoices with active originating returns or applied credits cannot be reversed first. Goods receipts required by posted purchase returns cannot be reversed until the dependent returns are reversed. Database triggers enforce these dependencies as well as API checks.

## GST and print documents

The original document type and saved tax facts control the return, even when the store has since selected Simple Billing. The main entry remains simple; print includes original HSN, taxable value, rate and available CGST/SGST/IGST components when relevant. Unknown historical component splits are shown as unknown, not inferred from today's jurisdiction. Simple non-tax originals have commercial return documents with no invented GST.

Sales titles distinguish credit notes from commercial credit notes. Purchase printing is explicitly an internal Purchase Return Record, with supplier credit-note reference/date fields for GST purchases. It does not automatically issue a supplier's statutory document or assert an input-tax-credit reversal. Draft/status labels remain visible. Printed data comes from saved invoice/return snapshots, with legacy fallbacks where snapshots did not exist.

The A4 stylesheet supports browser Print → Save as PDF and includes branding, addresses/contact details, document/source references, items, tax, settlement, actual refund references, remarks and signature space. No independent PDF backend is added.

Document scope was checked against [CGST Act section 34](https://taxinformation.cbic.gov.in/content-page/explore-act/1000304/1000001) and [CGST Rules rule 53](https://taxinformation.cbic.gov.in/content-page/explore-rules/1000144/1000001). Return recording is not an automatic GST filing or ITC determination service.

## Authorization and audit

Existing `returns.view` / `returns.manage` module permissions apply to the existing returns router. Store scope comes from active assignments, with Admin access. Finalize, rate overrides, credit application and reversal require store owner/manager authorization. Actual refunds additionally require `payments.manage`; stock inspections additionally require `inventory.manage`. The UI uses server-returned capabilities and explains unavailable finalization. Add Customer uses the existing customer-management permission.

Audit entries record draft creation/update, approval/posting, refunds, credit application, inspection, cancellation and reversal. Request keys and fingerprints protect retries and reject changed payloads using an existing creation/inspection key. Stock movements and credit allocations are immutable evidence.

## APIs

Base: `/api/tiles/returns`; `type` is `sales` or `purchase`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Filtered history; type, storeId, partyId, status, q, fromDate, toDate; maximum 200. |
| GET | `/summary` | Authorized gross invoices, returns, net totals and credit metrics. |
| GET | `/party-balance` | Store/party-scoped net balance for return entry. |
| GET | `/eligible-invoices` | Posted original invoice choices and remaining quantities/values. |
| GET | `/invoice/:type/:id` | Original saved header, eligible lines, stock and capabilities. |
| GET | `/:id?type=sales` | Detail, lines, effective credit, allocations, refunds and buckets. |
| POST | `/:type/preview` | Authoritative calculation/validation; optional returnId while editing. |
| POST | `/:type` | Create draft; idempotencyKey required. |
| PUT | `/:type/:id` | Edit a new unapproved draft. |
| POST | `/:type/:id/finalize` | Atomic manager approval/posting; idempotencyKey required. |
| POST | `/:type/:id/apply-credit` | Apply retained credit oldest first; idempotencyKey required. |
| POST | `/sales/:id/inspection` | Resolve pending stock; itemId, quantity, decision, reason, idempotencyKey. |
| POST | `/:type/:id/cancel` | Cancel draft with reason. |
| POST | `/:type/:id/reverse` | Reverse posted return with reason. |
| POST | `/sales/:id/approve` | Existing separate approval API retained. |
| POST | `/:type/:id/post` | Existing posting API retained with legacy approval/retry behavior. |

Draft bodies contain invoiceId, storeId, partyId, returnDate, reason, notes, settlementMode, items, optional refund fields and purchase supplier-credit-note fields. Items reference invoiceItemId and quantity; optional returnRate plus rateChangeReason; sales stockCondition or purchase stockBucket. Linked source metadata is validated independently.

Summary gross/return/net figures use document totals including tax and the selected document dates. Retained return credit shows the current allocation/refund state for qualifying returns through the selected end date; it is not a reconstruction of historical allocation changes. Net party-credit metrics are grouped per store and party. Detailed financial ledgers remain the source for transaction tracing.

## Migrations and historical compatibility

All six incremental migrations were applied to the configured local PostgreSQL database with `npm run migrate`:

| Migration | Changes |
| --- | --- |
| 028_return_invoice_workflows | Versioned return metadata, saved tax/component/conversion data, immutable credit allocations, refund-payment relationships, non-sellable ledger, effective accounting/credit views and corrected posting hooks. |
| 029_return_credit_application | Allow later immutable allocations from posted retained credit; enforce capacity, invoice due and party/store boundaries. |
| 030_return_refund_and_posting_guards | Posted totals/refund reconciliation, configured method FKs, block refund allocations, deduct applied return credits from payment capacity. |
| 031_inspected_return_reversal | Compensate inspection stock/bucket events in safe order and support sales-bonus reversal evidence. |
| 032_return_dependency_guards | Block reversal of invoices/receipts still supporting active returns or return credits. |
| 033_multi_invoice_sales_returns | Validate and lock every sales source invoice, preserve same-customer/store boundaries, and block secondary source reversal. No historical data rewrite or new accounting tables. |

Existing return rows retain workflow_version=1 and original amounts, references, approval and refund semantics. New rows use version 2. Original invoice totals, invoice numbers, historical payments and posted return amounts are not rewritten. Legacy drafts can use their original approval/post flow; they are not silently converted into editable version-2 drafts. Version-1 invoice credits retain the prior implicit source-invoice behavior.

Paired down scripts exist. Read their guards before use: rollback is refused once new financial/stock evidence would be lost. Production corrections should retain immutable evidence and normally roll forward.

## Changed files for this task

Backend:

- `src/services/returnInvoices.js` — shared source validation, calculation, stock locks, sequence, settlement and refund helpers.
- `src/controllers/returns.js`, `src/routes/returns.js` — entry/detail/history/preview, drafts, finalization, credit, inspection, corrections and reports.
- `src/controllers/sales.js`, `purchases.js` — invoice due/payment capacity and reversal dependencies.
- `src/controllers/payments.js`, `src/services/customerReceiptAllocation.js` — return-aware capacity, refund display/history and daily collections.
- `src/controllers/customers.js`, `suppliers.js`, `financialReports.js`, `dashboard.js` — effective return accounting, separate refunds and applied invoice credits; the financial ledger's pre-existing optional-date SQL parameter error was also repaired.
- `src/routes/customers.js`, `suppliers.js` — allow authorized return users to reuse party search.
- `src/returnWorkflows.database.test.js`, `src/returnConcurrency.database.test.js` — integration and genuine concurrent posting coverage.
- Migrations 028–033 and paired down scripts; this document; `migrations/README.md`, `migrations/SCHEMA.md`.

Frontend:

- `src/components/returns/ReturnManagement.jsx`, `.css`, `.test.jsx`.
- `src/components/returns/ReturnInvoiceItems.jsx`, `ReturnFinalizeDialog.jsx`, `ReturnDocument.jsx`, `ReturnDocument.test.jsx`.
- `src/components/payments/PaymentManagement.jsx` — refund details and actual cash-flow labels.
- `src/App.js`, `src/components/layout/navigation.js` — dedicated new/edit routes and direct return navigation.
- Workspace `cloud.md` — application reference updates.

## Verification

Backend: 148 tests passed with PostgreSQL access (zero skipped), including the true concurrent-posting test. Frontend: 216 tests passed across 36 suites; production build compiled successfully. Existing bundle-size and Browserslist advisories remain.

Return integration fixtures run in rolled-back transactions. The true concurrency test uses two independent transactions and users in a temporary isolated schema, then drops only that schema. It verifies one competing return posts, the other receives a conflict, and the winner's retry posts no additional stock or credit. No business records are copied into that schema.

Coverage includes partial/paid/excess-credit settlements, future credit application, actual refunds and refund reversal, stock failure rollback, inactive method failure, sellable/damaged/pending stock, inspection and reversal, purchase bucket deductions/receipt dependencies, original GST after catalog/default changes, tiny component rounding, original conversions, inactive original products, cancellation, quantity competition, rate authority, unlinked policy, store boundaries, report totals, draft UI, multiple items, modal review/retry and print snapshots.

Browser/mobile visual inspection and physical A4/PDF output remain manual checks; automated compilation and DOM tests are not represented as completed visual review.

## Returning products from multiple sales bills

In Sales Return, choose the customer, select multiple entries in **Original sales invoices**, and search products from those bills. Each row shows its source bill and original rate. Changing the selected bills retains edited rows from bills still selected; removing a bill removes only its rows. Draft reload restores every source and each quantity/rate. One return number, finalization, party settlement and optional actual refund cover the entire visit.

The server derives source invoices from original item IDs and verifies all sources belong to the same customer and store and remain posted. It rejects forged per-line invoice IDs, over-returned secondary lines and dates earlier than any source. The existing header retains an anchor invoice for party/accounting compatibility; the authoritative source for each product is its existing sales_invoice_item_id. New return item snapshots contain the original invoice reference, and document_snapshot.invoices contains each saved source document. Existing records are not rewritten.

Finalization locks all involved original invoices and validates each quantity/value/tax budget, stock, settlement and refund in the same transaction. Bonus deductions follow each original line's invoice. Source references appear in details, history search and dashboard return reports. All source invoices are protected from reversal while the combined return is active. Return reversal restores every affected line and its stock/credit evidence.

Printing groups products by original bill and preserves each group's saved GST/commercial treatment, rates and references. Mixed GST/non-tax sources produce a Sales Return Statement with distinct original-tax and commercial sections, plus one settlement total; a Simple bill does not remove another source's saved tax. This does not add automatic statutory filing.

Existing return API paths remain in use. A sales body still has invoiceId as an anchor; its items may reference original item IDs from several bills, with optional invoiceId on each item (validated when supplied). Detail responses add original_invoices and source_invoice_number/original_invoice_id per line; preview lines include invoiceId/invoiceNumber. Purchase APIs remain single-source.

The additional tests cover five original bills with different rates and GST treatments, combined draft editing, retained credit, one refund across paid bills, source reversal, customer/store boundaries, secondary-line quantity limits, dates, grouped printing, and two real concurrent finalizations overlapping on a secondary invoice. Final regression verification: 148 backend tests, 216 frontend tests across 36 suites, and a successful production build. Browser/mobile visual and physical print checks remain manual.

Files added/updated for this extension: migration 033 and its down script; src/services/returnInvoices.js; src/controllers/returns.js, sales.js, dashboard.js, salesBonusIntegration.js; returnWorkflows.database.test.js and returnConcurrency.database.test.js; frontend ReturnManagement.jsx, ReturnInvoiceItems.jsx, ReturnDocument.jsx, ReturnManagement.css and the two return UI/print test files; schema/migration notes and workspace cloud.md.
