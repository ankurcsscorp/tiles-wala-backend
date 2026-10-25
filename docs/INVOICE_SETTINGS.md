# Billing modes, invoice appearance, and tax documents

## Exact cause of the reported restriction

Before this change, `src/components/settings/InvoiceSettings.jsx` derived `nonGstBlocker` from selecting `NON_GST` plus a saved identifier, a registered declaration, or an unknown declaration. Save used `disabled={busy || !settings.canEdit || Boolean(nonGstBlocker)}`. This mixed a simplified appearance with permission to omit tax.

`src/controllers/invoiceSettings.js` independently called `taxTreatmentWarning(next)` and returned HTTP 422. `src/controllers/sales.js` used `invoice_type === 'NON_GST'` both to suppress taxes and select the simplified form. `migrations/022_invoice_type_settings.sql` also installed `guard_sales_invoice_type()` to reject Non-GST invoices without an unregistered declaration and absent identifiers. Removing only the button restriction would therefore not have resolved the underlying coupling.

Store 33, A & A Home Decor, has both `stores.gstin` and `stores.tax_id` populated with the same identifier. `src/controllers/stores.js` writes the GSTIN into both fields in store create/update/settings operations. Its `store_billing_config.gst_registration_status` is `UNKNOWN` (the migration 022 default); having an existing identifier did not establish a declaration. These values were confirmed read-only after migration 023. No registration declarations or identifiers were changed.

## New settings and migration

Migration `023_separate_invoice_layout_and_document.sql` was applied to the configured PostgreSQL database. It adds:

- `store_billing_config.invoice_layout`: `STANDARD_GST_LAYOUT` or `SIMPLE_LAYOUT`.
- `store_billing_config.default_document_type`: `GST_TAX_INVOICE`, `BILL_OF_SUPPLY`, or `NON_GST_COMMERCIAL`.
- `store_billing_config.gst_registration_category`: `UNKNOWN`, `REGULAR`, or `COMPOSITION`.
- Invoice snapshots: `sales_invoices.invoice_layout`, `document_type`, `registration_category_snapshot`, and `place_of_supply_state`.
- Product eligibility data: `products.gst_supply_classification` (`UNKNOWN`, `TAXABLE`, `EXEMPT`, `NON_TAXABLE`) and `gst_classification_reference`.

Existing store NON_GST defaults map to Simple Layout and Non-GST Commercial Invoice. Other store defaults map to Standard GST Layout and GST Tax Invoice. Registration declarations/categories are not inferred or changed. Existing sales rows are not updated: NULL new snapshots use the original `invoice_type` and existing display/print fallback. No existing tax amounts, invoice numbers, payments, or finalized data are rewritten.

The paired down migration removes the new metadata. Migration 022 and its Non-GST posting guards remain installed. A new trigger makes the new invoice appearance/document snapshots immutable and independently checks Bill of Supply posting eligibility and zero GST. Existing lifecycle and totals guards continue to operate.

## UI and APIs

Settings → Invoice Settings (`/settings/invoices`) starts with Preferred Billing Mode: GST Billing or Tiles Wala Simple Billing. This preference applies to Sales and Purchases. The primary Save Settings button submits only `invoiceLayout`, even if an incompatible tax configuration is being edited.

GST Registration and Default Tax Document Type are in a collapsed Advanced section with their own Save Tax Configuration button. GSTIN remains read-only, with a link to the existing Stores editor. Disabled document options show their exact reason. An incompatible tax change blocks only Save Tax Configuration. Role and busy states apply to both actions.

Appearance-only changes are allowed even if the existing registration declaration is incomplete. An incomplete tax configuration is displayed as information and remains a blocker for issuing a new tax document; it does not block saving appearance. In particular, store 33 can select Simple Layout without deleting identifiers or changing its declaration. Before issuing new tax documents, the actual registration declaration and category must be confirmed.

Existing endpoints remain:

- `GET /api/tiles/stores/:id/invoice-settings`: returns derived `billingMode` (`GST` or `SIMPLE`), layout, default document type, registration status/category, stored GSTIN, eligibility options/reasons, and permissions.
- `PUT /api/tiles/stores/:id/invoice-settings`: accepts partial changes to `invoiceLayout`, `defaultDocumentType`, `registrationStatus`, and `registrationCategory`. The UI sends changed fields only. Appearance-only updates preserve tax fields and do not run a tax-setting conversion. Tax-setting changes run document eligibility validation.
- Legacy `invoiceType: GST|NON_GST` requests retain their original tax meaning; they are not used as appearance selectors by the new UI.

Store access, owner/manager/admin authorization, before/after settings audit history, and store-row locking remain in use.

Sales create reads the saved layout. It defaults the document type from settings; a user can choose another eligible document for a new transaction. The backend validates that choice independently. Supplied layout is an expected-default check, not an override. Draft document/layout conversion remains unsupported. Existing drafts do not adopt later defaults.

## Tax treatment and calculations

`src/services/invoicePolicy.js` and its identical browser counterpart define document eligibility:

- GST Tax Invoice requires an actual Registered declaration, Regular category, and valid store GSTIN.
- Non-GST Commercial Invoice requires an actual Unregistered declaration and no saved GSTIN/tax ID.
- Bill of Supply requires Registered, a valid GSTIN, and Regular or Composition category. Regular businesses must use explicitly reviewed exempt/non-taxable products with classification references. Composition supports reviewed domestic intra-state supplies; place of supply must be known and match the store state. Unknown classifications and missing HSN are blocked. Zero product tax rate is not treated as exemption evidence.

Product classification/reference are configured through the existing administrator-only Products editor/API. Invoice lines snapshot this information. Eligibility is checked on save and again at posting, including registration/category changes after drafting. Explicit exempt/non-taxable products cannot be slipped into a GST Tax Invoice; separate Bills of Supply are required. Mixed-document supplies are outside this implementation's scope.

Simple Layout edits only Product Name, Quantity, Unit, Rate, and Line Total. Its displayed line total is rounded quantity × rate, before any applicable GST. Backend GST calculations and jurisdiction splitting remain on the existing PostgreSQL NUMERIC path. Simple GST uses authoritative product tax rates, so a client-supplied zero rate cannot suppress tax. Simple layout rejects nonzero discounts/adjustments to keep the five-column calculation consistent. GST is shown separately in the total summary. The browser preview uses integer decimal rounding for both amounts and GST.

Commercial invoices and eligible Bills of Supply collect no GST. Stock validation/conversion, posting, payments, balances, returns, commissions, and numbering use the existing shared workflows.

## Printing and PDF

Printed titles follow the invoice's saved document type. Simple editing does not remove tax disclosures from a GST tax invoice: printing retains HSN, rates, taxable values, CGST/SGST/IGST and total tax. Commercial printing remains a five-column layout. Bills of Supply retain HSN and registered party identifiers without tax collection columns, include saved exemption references where present, and include the composition declaration where applicable. Browser Print → Save as PDF uses the same A4 stylesheet. No separate PDF service is introduced.

Finalized store/customer data continue to come from invoice snapshots, not current settings.

## Scope and sources

This implements reviewed configuration and transaction validation, not automatic determination of every GST obligation. Registration declarations and product exemption references must reflect the business. Exports, special supply rules, mixed documents and other unsupported classifications need additional reviewed workflows. Existing numbering and other pre-existing statutory rules are not redesigned here.

Bill of Supply eligibility and required identifiers/disclosures were checked against [CBIC invoice rules](https://cbic-gst.gov.in/gst-invoice-rules.html) and [CBIC sectoral FAQs](https://cbic-gst.gov.in/sectoral-faq.html).

## Changed files

Backend:
- `migrations/023_separate_invoice_layout_and_document.sql` and `.down.sql`.
- `src/controllers/invoiceSettings.js`, `src/controllers/sales.js`, `src/controllers/products.js`.
- `src/services/invoicePolicy.js` and `.test.js`.
- `src/invoiceLayout.database.test.js`, updated `src/invoiceSettings.database.test.js` and `src/sales.database.test.js` fixtures.
- `docs/INVOICE_SETTINGS.md`.

Frontend:
- `src/components/settings/InvoiceSettings.jsx` and `.test.jsx`.
- `src/components/products/ProductManagement.jsx`.
- `src/components/sales/SalesBilling.jsx` and `.test.jsx`.
- `src/components/sales/SalesInvoicePrint.jsx` and `.test.jsx`.
- `src/utils/invoicePolicy.js`, `src/utils/invoiceMoney.js`, and `src/utils/invoiceMoney.test.js`.

Integration fixtures are rolled back. Tests cover registered Simple Layout saves/reload, independent stores, historical finalized snapshots, GST rate injection resistance and totals, commercial eligibility, composition and exempt Bills of Supply, incompatible document choices, changed registration, and existing payments/stock/returns. Browser/mobile visual review and physical print/PDF review remain manual checks.

Final verification for dual billing: 111 backend tests passed with PostgreSQL access; 140 frontend tests passed across 28 suites; production build compiled successfully. Existing build advisories about bundle size/Browserslist remain. Integration tests roll back their fixtures. No live store registration or default appearance was changed during investigation.

## Dual billing for Sales and Purchases

The shared React hook `src/hooks/useBillingSettings.js` loads the existing store invoice-settings endpoint on new entry/store change and normalizes `STANDARD_GST_LAYOUT` to `GST` and `SIMPLE_LAYOUT` to `SIMPLE`. Both Sales and Purchases use it. It handles loading, retry, and late responses from previous stores. Existing drafts use their stored layout, so a subsequent store preference change does not convert them. No redundant store billing-mode column was added.

Simple entries use Product, Quantity, Unit, Rate, and Line Total. GST Billing retains the detailed workflow. Sales retains its existing legal-document eligibility checks and authoritative product GST calculations. Changing the preferred mode never edits registration declarations, GSTINs, product tax data, or the default sales tax document.

### Purchase migration and supplier invoice facts

Migration `024_purchase_billing_mode_and_supplier_tax.sql` is applied to the configured database. Its down migration removes only the new purchase metadata/breakup fields and trigger. It adds:

- `purchase_invoices.invoice_layout`: a snapshot of the store preference at draft creation.
- `supplier_document_type`: GST_TAX_INVOICE, BILL_OF_SUPPLY, or NON_GST_COMMERCIAL, recorded from the supplier document independently of the buyer's sales document default.
- `supplier_tax_jurisdiction`: INTRA_STATE (CGST/SGST) or INTER_STATE (IGST), recorded from the supplier invoice.
- `supplier_tax_reason`: the exemption/composition basis shown on a supplier Bill of Supply.
- `declared_tax_total`: the GST total from the supplier invoice.
- Invoice CGST/SGST/IGST totals and item-level CGST/SGST/IGST amounts.

Existing rows are not rewritten or reclassified. Historical NULL layout/document metadata retains the existing detailed editor and print path. The new database trigger prevents layout conversion and validates supplier-document tax consistency on posting, in addition to existing immutable-document and NUMERIC totals guards.

### Purchase form and APIs

Existing purchase routes are reused. New draft creation reads the store's saved layout server-side and stores it on the purchase. An optional request `invoiceLayout` is an expected-default check; stale values return 409. Updates preserve the draft's saved layout and reject conversion.

New purchase drafts record the actual `supplierDocumentType`. GST invoices record explicit per-line rates, `supplierTaxJurisdiction`, and `declaredTaxTotal`. A draft may leave the declared GST total pending, but posting requires the supplier invoice number and declared total. If a supplied total does not match PostgreSQL's calculated tax, saving is rejected with a reconciliation message. GSTIN and tax treatment are checked against the supplier, not the buyer store's registration declaration.

In Simple Billing, tax rates are captured in a compact Supplier tax details section outside the five-field product entry cards. The calculated GST and breakup remain visible in the totals. Product GST rates may prefill input, but the entered rates must reflect the supplier's invoice. A document without GST cannot retain nonzero line rates or a nonzero declared GST total; the API rejects contradictions instead of silently clearing tax. Registered suppliers' no-GST documents use Bill of Supply with the actual document basis. Unregistered suppliers' commercial invoices use explicit zero GST. This records tax charged by the supplier; reverse-charge determination, ITC eligibility and other special tax assessments are not newly automated by this change.

Simple Billing omits adjustment controls and enforces zero item discounts/freight/adjustments for the quantity × rate workflow. Existing detailed purchase drafts retain those controls and their original calculations. Product HSN, default GST rate, supply classification, and references are preserved and snapshotted; zero supplier GST does not overwrite product master metadata.

### Inventory, ledgers, printing, and verification

Purchase posting records the supplier liability; stock continues to move only through explicit goods receipts. Unit conversion, partial receipts, receiving idempotency, supplier payments/retries, outstanding balances, and purchase returns use their existing workflows. Integration coverage verifies a GST purchase at ₹236, a ₹100 payment, a ₹59 purchase return, and the resulting ₹77 outstanding supplier balance, including stock conversion and ledger entries. Invoice counters are not reset or renumbered.

New purchase records print through `PurchaseRecordPrint.jsx`. Simple mode prints five product columns and, for GST invoices, a separate HSN/rate/tax breakup table. Detailed mode retains a detailed tax table. Printed supplier identity comes from the finalized supplier snapshot, not the current supplier master. The title identifies a Purchase Record and the actual supplier document type; it does not issue a new tax invoice on behalf of the supplier. Browser Print → Save as PDF uses the A4 stylesheet. Historical records retain their existing renderer.

Purchase return integration exposed an existing query that joined purchase returns to the sales-only `approved_by` field. The join now uses that field only for sales returns, restoring purchase-return retrieval/posting without changing approval rules.

Files changed for dual billing:

Backend:
- `migrations/024_purchase_billing_mode_and_supplier_tax.sql` and `.down.sql`.
- `src/controllers/invoiceSettings.js`, `src/controllers/purchases.js`, `src/controllers/returns.js`.
- `src/services/purchaseTaxFacts.js` and `.test.js`.
- `src/purchaseBilling.database.test.js` and this document.

Frontend:
- `src/hooks/useBillingSettings.js` and `.test.js`.
- `src/components/settings/InvoiceSettings.jsx` and `.test.jsx`.
- `src/components/sales/SalesBilling.jsx` and `.test.jsx`.
- `src/components/purchases/PurchaseManagement.jsx`, `.css`, and `.test.jsx`.
- `src/components/purchases/PurchaseRecordPrint.jsx` and `.test.jsx`.
- `src/utils/invoiceMoney.js` and `.test.js`.

All transactional integration fixtures are rolled back. Current verification covers both saved modes, store isolation, independent appearance saves, both entry forms, supplier GST/no-GST records, decimal totals, draft/history preservation, printing, permissions, receiving, payments, returns, and supplier ledgers. Responsive media/container rules are implemented; actual mobile/tablet visual inspection and physical print/PDF review remain manual release checks.

## Completing tax setup from an in-progress sale

Simple Billing can be selected while registration is UNKNOWN, but it does not establish eligibility for a GST Tax Invoice. The reported sales form disabled Save draft and Finalize because its selected tax document still required the store's actual registration declaration/category.

The sales warning now offers **Complete tax setup** to users with store-management permission. `StoreTaxSetupDialog.jsx` shows the existing GSTIN read-only and requires the user to select the actual registration status, category, and eligible default document. Nothing is automatically declared or inferred. It saves through the existing authorized/audited invoice-settings PUT endpoint; it does not send or modify `invoiceLayout` or GSTIN.

After a successful save, Sales reloads settings while keeping the invoice component mounted, preserving customer, products, quantities, rates, and other entered fields. Cancellation and API errors leave the invoice intact and keep invalid finalization blocked. Users without permission see a specific instruction to contact a store owner, manager, or administrator. The selected document label no longer repeats the long validation reason, and Simple Billing omits unused discount/charge/round-off summary rows.

This fix changes `SalesBilling.jsx`, adds `components/settings/StoreTaxSetupDialog.jsx`, and adds sales UI regression tests. No backend policy, database schema, tax calculations, existing invoice data, or live registration declarations were changed.

Verification for the inline sales setup fix: all 144 frontend tests pass across 28 suites, including setup completion without losing line data, cancellation, permissions, and API rejection. Production build compiles successfully. The initial full run had a supplier-dialog timing failure; the full rerun passed without changing that unrelated test or component.

## Finalize action when store tax setup is incomplete

The repeated disabled-button report was confirmed against store 33: its saved layout was STANDARD_GST_LAYOUT, with registration status and category both UNKNOWN and a saved GSTIN. Both appearances shared the same GST Tax Invoice eligibility check. The form used that check to disable Finalize, while its explanation appeared above the visible footer. Changing appearance could not resolve the missing declaration.

Sales now keeps Finalize actionable once a store, loaded settings, and a product are present. If tax setup is required, clicking Finalize opens the existing authorized setup dialog directly. After the user confirms valid actual details and settings reload successfully, the payment/finalization confirmation opens automatically. Saving the declaration alone does not post an invoice. Cancellation, rejected saves, and invalid configurations cannot finalize; backend validation remains unchanged. The warning and setup action appear next to the footer buttons, and missing store/products, loading, and request failures have explicit nearby explanations.

This follow-up changes SalesBilling.jsx and SalesBilling.test.jsx only, plus this documentation. No database migration or live store/invoice modification is involved. Regression tests exercise both detailed GST and Simple appearances from UNKNOWN setup through the sales create and finalize requests, preserving quantity, rate, layout, and applicable charges.

Verification for the Finalize action follow-up: all 146 frontend tests pass across 28 suites; the focused Sales suite passes all 12 tests; the production build compiles successfully.

## Sales document resolution and payment refactor — 24 October 2026

### Confirmed root cause

Read-only PostgreSQL inspection found store 33 configured with `SIMPLE_LAYOUT`, `default_document_type=BILL_OF_SUPPLY`, `gst_registration_status=REGISTERED`, and `gst_registration_category=REGULAR`. The audit entry at 05:13:07 UTC on 24 October records the default changing from GST Tax Invoice to Bill of Supply; later appearance saves retained it. The backend was honoring that saved document default, not deriving Bill of Supply from Simple Layout. The frontend copied the default into its new-document state and sent it explicitly to sales creation. Legacy store `invoice_type=GST` did not override that explicit document. No recent draft explained this failure: the inspected store had only a historical posted invoice with NULL new snapshots.

Costa Blue (product 43, SKU ALASKA01) had a stored HSN, `gst_supply_classification=UNKNOWN`, no classification reference, and NULL catalog GST rate. The reported classification error came from `checkBillProduct` in `controllers/sales.js` during draft item validation, before the create-draft transaction committed. A genuine Bill of Supply also has independent posting protection in migration 023's `guard_invoice_document_metadata()`. Migration 022's `guard_sales_invoice_type()` remains installed for commercial invoices. Neither trigger selects Bill of Supply from appearance.

The payment modal separately accepted ₹25,550 against ₹2,550 because it had no amount/balance validation. The backend already rolled back overpayment, but checked it after attempting the posted status transition. A failed finalization following successful draft creation also retried by creating another draft in the previous frontend flow.

### Implementation

- Shared `resolveSalesDocumentType` in backend/browser invoice policy validates registration, requested/saved document, actual products, and the supported place-of-supply rule. Appearance and lifecycle status are not inputs to the decision. It never silently replaces an explicit document or fabricates a product exemption/rate. The existing parity test verifies browser/server policy equality.
- Simple Billing keeps five product columns in `SalesInvoiceItems.jsx`. Tax totals remain separate when applicable. Detailed entry shows the configured product GST rate read-only. All new GST documents use catalog tax rates on the server; client tax-rate overrides cannot change them. Detailed invoice-discount previews now allocate discounts before GST using decimal rounding consistent with the backend.
- Product eligibility errors identify the product, stable code, item field, and product ID. Authorized administrators can open `/products?edit=<id>` in a separate tab, then refresh product details without losing sale quantities/prices. Other users are directed to an administrator. For a new Regular Bill of Supply sale, an explicit GST Tax Invoice action changes only this sale's requested document, with GST eligibility/rate validation retained. Store defaults and registration are not changed by this action.
- New invoices load current store defaults. Explicit per-sale document choices survive same-store settings reloads. Legacy `invoice_type` no longer overrides a saved explicit document in the entry/print paths. Existing drafts visibly retain saved layout/document and cannot convert; create a replacement draft to use another configuration.
- `SalesFinalizeDialog.jsx` displays invoice number (assigned on posting), customer, document, total, amount, balance, payment method, and reference. Blank/zero/partial/full payments are supported. Negative, malformed, overprecision, and excessive payments have inline explanations and block confirmation. This modal does not record advances; the existing receipts workflow remains separate.
- Finalization locks the draft, revalidates active customer/store/document/products, recalculates new-document totals from saved quantities/prices and current catalog rates, and validates initial payment before numbering or stock posting. Catalog rows are share-locked during calculation. Existing stock locks, transaction boundaries, numbering, posting triggers, payments, bonus hooks, and audit writes remain. Failures roll back the draft recalculation and all posting effects. A changed authoritative total is returned with a payment error for review in the modal.
- The frontend retains a successfully saved draft after failed posting and reuses it on retry, guarded against concurrent submit clicks. Duplicate server finalization remains blocked with `INVOICE_ALREADY_FINALIZED`; no second stock/payment posting occurs.
- Printing uses the saved explicit document before any legacy fallback and preserves GST/Bill of Supply disclosures. There is no rewrite of finalized invoices.

Structured business errors retain the existing `message` field and add relevant `code`, `field`, `productId`, `lineNumber`, or `invoiceTotal`: `INVALID_DOCUMENT_TYPE`, `DOCUMENT_NOT_ELIGIBLE`, `GST_REGISTRATION_INCOMPLETE`, `PRODUCT_TAX_CLASSIFICATION_REQUIRED`, `PRODUCT_TAX_RATE_REQUIRED`, `INVALID_PAYMENT_AMOUNT`, `INVALID_PAYMENT_METHOD`, `INVALID_PAYMENT_KEY`, `INSUFFICIENT_STOCK`, and `INVOICE_ALREADY_FINALIZED`.

### Using Simple Billing for the reported store

Keep Tiles Wala Simple Billing selected. Review Costa Blue's actual HSN, supply classification, and applicable GST rate in Products; no values are inferred by this fix. For taxable supplies by the saved Regular registration, choose GST Tax Invoice in the new sale (or explicitly save that default in advanced Invoice Settings). The form remains Simple, and GST is calculated/disclosed separately. If the supply is genuinely exempt/non-taxable, keep Bill of Supply and configure its reviewed classification/reference instead. An eligible unregistered business without GST identifiers can use Non-GST Commercial Invoice. Composition retains its reviewed Bill of Supply and intra-state requirements.

For an eligible no-tax sale of 3 × ₹850, total is ₹2,550; receiving ₹1,000 leaves ₹1,550. ₹25,550 is rejected. A GST-applicable sale adds the configured applicable tax; Simple appearance does not make ₹2,550 the tax-inclusive final amount automatically.

### Files and database

Backend changes: `src/services/invoicePolicy.js`, its test, `src/controllers/sales.js`, `src/controllers/invoiceSettings.js` (store state in settings response), and new `src/salesFinalization.database.test.js`.

Frontend changes: `SalesBilling.jsx`, `.css`, and its test; new `SalesInvoiceItems.jsx`, `SalesFinalizeDialog.jsx`, and `SalesValidationAlert.jsx`; `SalesInvoicePrint.jsx` and its test; `ProductManagement.jsx` and its test; `utils/invoicePolicy.js`, `invoiceMoney.js` and its test; new `salesPayment.js` and its test. Documentation changes: this guide and root `cloud.md`.

No new database migration is required. Migrations 022/023 and all existing guards remain unchanged. No live registration declarations, GST identifiers, product classifications/rates, defaults, or historical invoice records were modified. Integration fixtures are rolled back.

Verification: complete backend suite passed 115 tests with PostgreSQL access and no skips; complete frontend suite passed 165 tests across 29 suites; production build compiled successfully. Tests include both appearances, GST/commercial/Bill of Supply eligibility, the reported incomplete product, overpayment and malformed/negative amounts, zero/partial/full payments, derived customer ledger balance, rollback and unchanged numbering on failure, catalog-rate revalidation, single stock posting under retries, saved draft preservation, store isolation, historical snapshots, repair links, and print document precedence. Browser/physical print review remains manual; existing bundle size/Browserslist advisories remain.

### Product update follow-up

The reported `PUT /api/tiles/products/43` HTTP 500 came from `controllers/products.js`: the UPDATE referenced `$23` and `$24` for GST supply classification/reference, but its parameter array ended at `$22`. The controller now supplies both values. Requests that omit classification preserve existing classification/reference through the existing SQL conditional; explicit reviewed classification changes persist normally. Validation still rejects exempt/non-taxable classifications without references. No migration or live product data change was needed.

`src/products.database.test.js` exercises real PostgreSQL creation/update/read-back, taxable/exempt changes, omitted metadata preservation, conversion preservation, and rejected-update rollback using rolled-back fixtures. All five focused product tests passed, including this integration test and the four existing controller tests.

### Product-aware defaults for new sales

The follow-up screenshot shows Costa Blue with a configured 18% catalog rate but still `UNKNOWN` supply classification. The previous UI continued to request the store's saved Bill of Supply default as though it were an explicit transaction choice. That unnecessarily required a manual document change even when the transaction policy permitted exactly one alternative.

New sales now validate the preferred default against the selected products. If it is incompatible and exactly one other document passes the existing registration/product/supply checks, `resolveSalesDocumentType` returns that eligible document with an explanation. The sales form displays the explanation and recalculates the appropriate tax totals while preserving Simple appearance. This behavior applies to either appearance and is driven by transaction eligibility, not by selecting Simple. The backend uses the same resolution for new draft requests that omit both an explicit document and the legacy invoice type, loading actual catalog data under a share lock.

For the screenshot's Regular registered store and unclassified product with an explicit positive 18% rate, the unique eligible alternative is GST Tax Invoice; Bill of Supply still requires reviewed classification. No classification, registration declaration, product rate, or store default is changed. An unclassified zero/null rate does not enable automatic fallback to GST. No valid alternative, mixed incompatible supplies, or incomplete registration still produces an actionable blocker.

Explicit per-sale document choices and saved draft documents never use this fallback. Manually selecting Bill of Supply continues to enforce its classification requirements. Document choice is now React state so choosing the same underlying default after an automatic resolution correctly renders and validates the user's explicit selection. New-document snapshots store the resolved document; printing/finalization use those snapshots.

Changed files for this follow-up: backend/browser invoice policy, sales creation controller, sales policy/integration tests, SalesBilling and its tests, this guide, and root cloud.md. No schema migration or live configuration update is required. Backend regression suite passed 117 tests with no skips. The screenshot scenario is covered in both browser tests and rolled-back PostgreSQL posting tests.

Final verification for product-aware defaults: 117 backend tests and 167 frontend tests across 29 suites passed; production build compiled successfully. No live product data or store configuration was changed.
