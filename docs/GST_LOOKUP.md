# GSTIN lookup and business autofill

## Integration decision and remaining onboarding

Research checked on 22 October 2026:

- [GSTN's GSP ecosystem](https://gstn.org.in/gsp-ecosystem) describes the authorized API channel and lists selected providers, including FinAGG in its fifth batch. Confirm production entitlement with the provider before enabling production calls.
- [FinAGG's primary API documentation](https://developer.gsp.finagg.in/) documents API-key authentication, the Common GST Search endpoint, `action=SEARCHGSTIN`, sandbox/production hosts, and HTTP error statuses. Obtain the key and supported version segments from its GSP team. Confirm the GSTIN query parameter, response schema and product entitlement during sandbox acceptance; this integration has not been exercised against a live account.
- FinAGG's linked reference does not publish a per-call price or a numeric account quota. Obtain a written quote, throughput limits, retry policy, data-retention permission, IP requirements and production enablement during onboarding. The application limit of 10 lookups per authenticated user per minute is an application limit, not a provider quota.
- [MasterGST's developer portal](https://mastergst.com/gst/gst-developer-api-portal.html) is an alternative GSP integration with account credentials and sales-quoted pricing. Its API shape differs; add another adapter behind `createGSTProvider` if selected.

This implementation uses FinAGG's documented Common GST Search service, not taxpayer return/filing APIs. It does not scrape the GST portal, bypass CAPTCHA, obtain OTP consent or read private return data. An account and explicit product permissions are required; no credentials or configuration means HTTP 503 `GST_CONFIGURATION_REQUIRED`. No provider requests are made by ordinary mock tests.

## Backend environment

Copy these settings into the backend's deployment environment; `.env.example` contains blank placeholders. Never put them in a React `REACT_APP_*` variable.

```dotenv
GST_PROVIDER=finagg
GST_ENVIRONMENT=production
GST_API_KEY=<provider-issued key>
GST_FINAGG_VERSION=<onboarding version>
GST_GSP_VERSION=<onboarding version>
GST_TIMEOUT_MS=8000
```

The existing `JWT_SECRET` is required for application authentication and short-lived lookup proofs. Existing `DB_*` settings remain unchanged. Restart the backend after setting credentials. Use `GST_ENVIRONMENT=sandbox` only for provider acceptance tests; the UI identifies sandbox results and saves their source as `finagg-sandbox`.

Timeout is bounded to 1–20 seconds per attempt. Only HTTP 502/503/504 receives one additional attempt. Timeouts, 401/403, 404 and 429 are not retried. Upstream rate-limit responses return a bounded `Retry-After`; browser calls never retry automatically. The provider host is fixed to FinAGG HTTPS hosts and redirects are rejected.

## Migrations and existing records

Run from `tiles-wala-backend` after reviewing pending migrations and taking the usual database backup:

```sh
npm run migrate
```

- `019_gst_business_details.sql`: reuses `tax_id` as GSTIN, existing address/city/state/PIN columns, and adds `gst_details` JSONB, `gst_verified_at`, `gst_data_source` to both masters. JSON metadata stores legal/trade names, status, type, constitution, registration date, district, state code and business activities. No raw provider payload is stored.
- GSTIN uniqueness is case/space-insensitive across the shared customer master, and independently across the shared supplier master. A party can be both a customer and supplier. Blank/null GSTIN values remain allowed, including multiple unregistered parties.
- Migration 019 stops transactionally if historical duplicates exist. It does not merge, delete or normalize existing rows. Review duplicates first:

```sql
SELECT upper(trim(tax_id)) AS gstin, array_agg(id) AS ids
FROM customers WHERE NULLIF(trim(tax_id), '') IS NOT NULL
GROUP BY upper(trim(tax_id)) HAVING count(*) > 1;
-- Repeat with suppliers.
```

- `020_purchase_supplier_gst_snapshot.sql`: snapshots supplier name, GSTIN, address and extended GST details when a draft purchase first posts. Existing posted invoices retain null snapshots and display a historical-data notice; present-day master data is never presented as historical supplier data. Existing sales snapshots, store invoice configuration, stock posting and tax rules are unchanged.
- Down migrations are supplied. Rolling them back removes new metadata/snapshots; export anything needed before rollback.

Migrations 019 and 020 have been applied to the configured local application database. The remaining billing migrations through 021 were applied while fixing sales draft creation and finalization. Other environments must check their own migration status before deployment. Automated database checks use temporary tables or a transaction-scoped test schema and roll back all changes.

## API contract

```http
GET /api/gst/lookup/27AAPFU0939F1ZV
Authorization: Bearer <application-login-token>
```

The GSTIN above is used only as a checksum-valid input in mock tests; examples below are response shapes, not real taxpayer records.

```json
{
  "success": true,
  "data": {
    "gstin": "27AAPFU0939F1ZV",
    "legalName": "<provider legal name>",
    "tradeName": "<provider trade name>",
    "registrationStatus": "Active",
    "taxpayerType": "Regular",
    "constitutionOfBusiness": "<provider constitution>",
    "registrationDate": null,
    "address": {
      "addressLine1": "<provider address>", "addressLine2": "",
      "city": "", "district": "", "state": "", "stateCode": "27", "pincode": ""
    },
    "natureOfBusiness": [],
    "source": "finagg",
    "fetchedAt": "<server ISO timestamp>"
  },
  "lookupToken": "<short-lived signed proof>"
}
```

```json
{"success":false,"code":"GST_CONFIGURATION_REQUIRED","message":"GST lookup is not configured. Ask your administrator to configure the GST provider."}
```

Errors: 400 invalid format/checksum; 401 unauthenticated; 403 role/store access denied; 404 provider reports no matching registration; 429 application/provider quota; 502 malformed or mismatched provider data; 503 missing configuration, provider credentials/access, or service unavailable; 504 timeout. Provider error text and credentials never reach clients. Responses are `Cache-Control: no-store`.

Only admins and salespeople can call lookup. Salespeople require an active store assignment. The endpoint does not accept a provider URL or key from the browser. Rate limiting is per process; multi-instance deployments should use a shared express-rate-limit store and an account-wide provider quota strategy.

## Form and persistence behavior

`GSTLookupField` validates regular PAN-based GST registrations, uppercases/trims input, checks the base-36 checksum, blocks duplicate requests, cancels/ignores stale results and presents a review dialog. This validator intentionally does not accept UIN or temporary registration IDs. The request's illustrative `10ABCDE1234F1Z5` fails checksum validation; it is not used as a successful registration fixture.

`GSTPartyFields` and `gstForm` reuse mapping across add/edit customer, add/edit supplier, Sales Billing customer quick-add and Purchase Billing supplier quick-add. Available values are applied only after confirmation. Missing fields remain blank or preserve existing manual data. Mobile/email, shipping address, balances and payment terms are not filled by the provider. Cancelled, suspended, unknown and sandbox registrations display warnings without adding a save restriction.

Applying details never saves a party. Users may edit fields and explicitly save through existing APIs. Quick-add selects the saved record immediately. The signed lookup proof binds the GSTIN, source and lookup time and expires after 30 minutes. Client-supplied timestamps/source alone cannot establish verification. Changing GSTIN invalidates the proof and marks business data stale. The Clear lookup verification action allows manual saving if the proof expires.

GST status is a point-in-time lookup, not an ongoing guarantee. Saved details display the last fetched date/source. Sales print rendering accepts canonical `line1`/`line2` as well as older `street` addresses. Purchases use their posting snapshot for display and printing. No accounting or GST calculation rules were changed.

No retained lookup cache is enabled pending provider terms. Concurrent requests for the same GSTIN are coalesced only while a request is in progress. Logs contain error codes only, with no provider response, key or full GSTIN.

## Changed code and tests

Backend: `index.js`, `.env.example`, `src/routes/gst.js`, `src/controllers/gst.js`, `src/providers/gstProvider.js`, `src/services/gstLookupService.js`, `src/services/gstErrors.js`, `src/utils/gstValidator.js`, `src/utils/gstPartyFields.js`, customer/supplier persistence controllers, purchase response projection, migrations 019/020 and adjacent tests.

Frontend: `src/components/gst/`, `src/utils/gstValidator.js`, customer/supplier management, supplier search quick-add, Sales Billing quick-add, sales print address rendering, purchase GST display and related tests.

```sh
# Backend: mocks plus local PostgreSQL integrity tests if DB_* is configured.
npm test
# Frontend
CI=true npm test -- --watchAll=false --runInBand --silent
CI=true npm run build
npx --no-install eslint src --max-warnings=0
```

Live provider acceptance, agreement/credentials, deployment migrations and a visual mobile-browser pass remain operator setup/validation. No paid lookup has been made.
