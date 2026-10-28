# GST and Non-GST billing

## Sales invoice terms and payment instructions

Settings → Invoice Settings includes store-specific **Terms and conditions**, **Account holder name**, **Account number**, **Bank name**, optional **Branch**, **IFSC code**, and optional **UPI ID**. These print on sales invoices only. Purchase records do not show the store's receiving account as supplier payment instructions. No QR code or scanner is generated.

Bank details and UPI ID are independently optional. If any bank field is entered, the account holder, account number, bank name and IFSC must be complete. Account numbers stay as text to preserve leading zeros. IFSC is normalized to uppercase; UPI addresses are checked for a basic `name@handle` format. Clear all bank fields to remove a bank account; a UPI ID can remain on its own. Terms accept multiple lines, up to 10,000 characters. Nothing from the reference image is automatically entered into live store settings.

The existing `GET` / `PUT /api/tiles/stores/:id/invoice-settings` API adds `termsAndConditions` and `paymentDetails`. The latter replaces the optional payment-details object using keys `accountName`, `accountNumber`, `bankName`, `branch`, `ifscCode`, `upiId`; `{}` clears it. Omitted fields preserve current settings. Terms reuse `stores.terms_and_conditions`, kept in sync with the existing billing-config copy. Footer-only changes do not require changing or validating an unrelated incomplete GST setup. Existing store authorization, manager/owner restrictions, module permissions, store-row locking and before/after audit entries remain in effect.

Migration **034_invoice_payment_details.sql** adds `stores.invoice_payment_details` (JSONB, initially `{}`) and nullable `sales_invoices.payment_details_snapshot`. A posting trigger captures payment instructions on draft → posted; the existing billing trigger captures terms. Posted/reversed payment instructions and terms cannot be edited. Historical invoices are not backfilled from current settings, and existing drafts obtain these footer details when finalized. The paired down migration refuses to remove nonempty saved payment instructions from invoices.

Printing places bank details and UPI ID in adjacent panels, followed by terms and a blank authorized-signatory area. Empty panels are omitted. The isolated print container continues to handle A4 pagination and genuine multi-page invoices. The browser regression script `tiles-wala-frontend/scripts/check-invoice-print.cjs` includes saved bank, UPI and terms in sales fixtures and verifies their absence on purchases.

Current behavior, 28 October 2026. The two-mode workflow below replaces the earlier independent appearance/document selectors and automatic alternative-document selection.

## Choosing a mode

Settings → Invoice Settings has two choices and one Save Settings button:

| Mode | New sales | New purchases |
| --- | --- | --- |
| **Non-GST — Tiles Wala Simple Billing** (default) | Five product columns; zero GST | Five product columns; zero GST |
| **GST Billing** (explicit opt-in) | Detailed GST Tax Invoice workflow | Detailed supplier tax workflow |

Non-GST columns: **Product Name | Quantity | Unit | Rate | Line Total**. Line Total = Quantity × Rate, rounded to paise per line. Grand total is the sum of those lines. No HSN, GSTIN, registration declaration/category, product GST rate, classification/reference, or place-of-supply setup is required for this mode. Existing saved GST identifiers do not block it. Discounts, tax, and adjustments cannot be injected into a Simple sales invoice.

GST Billing requires a valid saved store GSTIN, actual Registered declaration, and Regular registration category for GST Tax Invoices. The settings page shows those controls only when GST is selected and explains why Save is blocked. GSTIN is maintained through Stores; registration is never inferred from the identifier. GST sales use catalog tax rates on the server and retain product checks, tax splitting, discounts/charges, and printed tax disclosures. Incomplete GST setup never automatically falls back to Non-GST.

A Non-GST save sends only the mode, preserving stored GSTINs, registration declarations, and product tax metadata. Changes apply to new documents. Start a **new invoice** to use updated settings: existing drafts keep their saved format and tax treatment, and finalized invoices retain their amounts, numbers, party snapshots, payments, and stock history.

## API and compatibility

- GET /api/tiles/stores/:id/invoice-settings returns billingMode (NON_GST or GST), invoiceType, invoiceLayout, defaultDocumentType, registrationStatus, registrationCategory, GSTIN, permissions, and compatibility document options.
- PUT on that endpoint accepts {billingMode:"NON_GST"} or {billingMode:"GST"}. GST setup changes may include registrationStatus and registrationCategory. The mode atomically sets invoice_type, invoice_layout, and default_document_type.
- NON_GST maps to NON_GST / SIMPLE_LAYOUT / NON_GST_COMMERCIAL.
- GST maps to GST / STANDARD_GST_LAYOUT / GST_TAX_INVOICE.
- Older partial layout/document requests remain compatible for existing clients. Bill of Supply and legacy Simple GST documents remain supported by their saved metadata and validation; they are not additional choices in the new settings screen.
- Store access, effective permissions, owner/manager/admin requirements, store-row locking, and before/after invoice_settings_audit history remain enforced.

Sales load the selected store's mode and no longer offer a separate tax-document selector in the current workflow. The server validates the saved/requested document without automatically selecting an alternative from product eligibility. Non-GST accepts products with missing GST data or saved nonzero catalog tax rates, records zero line GST, and leaves the catalog unchanged. Invalid quantities, units, prices, insufficient stock, and excessive payments remain blocked with actionable messages.

New Non-GST purchases default to NON_GST_COMMERCIAL and hide supplier GST evidence fields, even when the supplier has a saved GSTIN. GST purchases retain supplier document, GSTIN, jurisdiction, declared GST reconciliation, and posting evidence checks. Historical purchase drafts use their saved tax facts. Nonzero requested line tax or a nonzero declared GST total cannot be silently discarded by changing a document selector.

## Migration 026

Run npm run migrate before running the updated backend. 026_simple_non_gst_default.sql:

1. Changes store_billing_config defaults to NON_GST, SIMPLE_LAYOUT, and NON_GST_COMMERCIAL. The settings reader uses the same defaults for stores without a config row.
2. Converts incomplete/legacy billing defaults to Simple Non-GST. It preserves completed detailed GST configurations: Standard GST Layout + GST Tax Invoice + Registered + Regular. Registration fields and store identifiers are unchanged.
3. Logs changed defaults in audit_logs with action invoice_settings.simple_default_migration and before/after config data.
4. Replaces the old sales trigger's unregistered/no-GSTIN prerequisite and the purchase trigger's registered-supplier commercial restriction. Zero-tax/math, immutable document metadata, posting, stock, totals, and financial protections remain.
5. Updates no sales or purchase invoice rows, finalized amounts, numbers, payments, or inventory records.

The down migration restores previous defaults and guard functions without reconstructing preferences or rewriting history. It refuses rollback while records conflict with the older identifier restrictions; use a reviewed forward correction after financial use.

## Calculation, finalization, and printing

The backend uses PostgreSQL NUMERIC for totals. Non-GST is zero-tax quantity × rate. GST uses authoritative catalog rates and existing jurisdiction allocation; client-supplied zero GST cannot suppress it. Payment validation runs before numbering/posting. A failed finalization rolls back numbering, stock movements, payments, and invoice status; retry reuses the existing draft. Full, partial, and zero payment work through the same existing ledger/allocation flows.

Saved document metadata drives print/PDF, including historical GST and Bills of Supply. Non-GST sales print five product columns without GST collection columns. GST documents retain HSN, tax rates, taxable values, and CGST/SGST/IGST disclosures. Purchases print a Purchase Record. Existing round payment stamps remain: red Due, yellow Partially Paid, green Paid. Browser Print → Save as PDF uses the same A4 stylesheet.

## Why previous Simple Billing was blocked

Originally, frontend nonGstBlocker and backend taxTreatmentWarning required an Unregistered declaration with no saved stores.gstin or stores.tax_id. Migration 022 repeated that restriction at posting. Migration 023 separated appearance and document: selecting Simple changed appearance while leaving GST Tax Invoice or Bill of Supply as the actual document. Consequently, UNKNOWN registration blocked GST and UNKNOWN product classification blocked Bill of Supply. The later product-aware resolver could select a different eligible document, which added another implicit decision.

The current request changes that policy: Non-GST Simple Billing is now an explicit zero-tax mode without GST setup, and GST is an explicit opt-in. Backend/browser policy and database guards have been updated together. Registration data is preserved rather than cleared to satisfy older restrictions.

The earlier product-update HTTP 500 was a separate positional-parameter defect in controllers/products.js; its fixed classification/reference arguments remain in place.

## Implementation and checks

Backend: migration 026 and down migration; controllers/invoiceSettings.js, sales.js, purchases.js; services/invoicePolicy.js and purchaseTaxFacts.js; updated policy/settings/sales/purchase tests; simpleBilling.database.test.js.

Frontend: settings/InvoiceSettings.jsx and StoreTaxSetupDialog.jsx; hooks/useBillingSettings.js; sales/SalesBilling.jsx; purchases/PurchaseManagement.jsx; matching browser policy; regression tests for the settings, hook, sales, and purchases.

Database integration tests roll back fixtures. Coverage includes default Non-GST with saved GSTIN and no product GST setup; zero-tax sales/purchase posting; partial payment and stock; GST opt-in and authoritative tax calculation; migration auditing, independent stores, and unchanged historical snapshots; legacy drafts, returns, receipts, and ledgers. Real mobile/browser rendering and physical print/PDF review remain manual checks.

Final verification (27 October 2026): 120 backend tests passed with PostgreSQL and no skips; 190 frontend tests passed across 32 suites; production build compiled successfully. Migration 026 is applied to the configured local database. Existing bundle size/Browserslist advisories remain.
