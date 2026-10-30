# Sales Bonus

This guide describes the invoice-linked Sales Bonus workflow, the bonus rules, approval and payout behavior, and the relevant application interfaces. The main user interfaces are in `tiles-wala-frontend/src/components/sales/` and the API implementation is in `tiles-wala-backend/src/`.

## Overview

Sales bonuses are generated from posted sales invoices. The invoice's **Referred By** user identifies who receives the bonus: an active **Salesperson** or **Tile Mistire**. The invoice does not require staff to recreate its products or quantities in the bonus module. Its lines are matched against active bonus rules, and matching lines are snapshotted into a bonus record for approval.

The normal lifecycle is:

1. An eligible person is selected in **Referred By** on the sale invoice.
2. The invoice is posted. If bonus integration is enabled, the system finds matching active product rules and creates a `pending_approval` bonus record.
3. An administrator reviews the invoice payment status and bonus detail. If the invoice has not been fully collected, approving requires a risk reason.
4. Once approved, the amount available to pay is normally released in proportion to customer payments allocated to the invoice.
5. An administrator can record a partial or full payment, including before invoice collection. Such an early payment overrides the collection release limit.
6. Posted returns adjust the associated bonus. Reversing the invoice reverses its bonus.

## Invoice referral

The sales invoice stores the selected user in `sales_invoices.referred_by_user_id`, and stores a name snapshot in `referred_by_name_snapshot`. The user must be active and have the `Salesperson` or `Tile Mistire` user type to be eligible for automatic bonus generation.

The referral picker in the sales invoice is backed by existing users. If the intended referral is missing, add that person through the user signup flow, then select them on the invoice. The referral stored on the invoice is the basis for the automatic invoice bonus; bonus recipients do not need to be separately entered for normal invoices.

## Product bonus rules

Automatic bonus calculation only includes invoice lines that match an active rule in `sales_bonus_product_config`. Product rules are managed against the active shared product catalog, the same catalog used by invoice entry. A rule includes:

- Product
- Cost price used for bonus calculation
- Bonus percentage
- Unit label
- Active/inactive state

The rule must match the invoice product and unit. Category eligibility is also respected when configured. A product without a matching active rule is skipped; if no invoice lines match, no bonus record is generated. Editing a rule affects future calculations; bonus record line values are stored as snapshots and do not get recalculated when a rule changes later.

Administrators manage these rules in **Sales Bonus Product Management** (`SalesBonusProductManagement.jsx`). The product list is drawn from the active inventory/product catalog rather than a separate manually maintained bonus product list.

## Calculation

For each matched invoice line:

```text
line cost         = configured cost price × quantity
line sales        = invoice taxable value
line gross profit = line sales − line cost
gross bonus       = max(line gross profit, 0) × bonus percentage ÷ 100
```

The configured cost price is treated as the unit cost. The invoice line's taxable value (after line and invoice discounts are reflected in that value) is used for sales. Negative gross profit does not produce a negative bonus.

Recipient allocation follows the existing bonus calculation strategy:

- **Tile Mistire:** receives 100% of the calculated gross bonus.
- **Salesperson:** receives 50% of the calculated gross bonus.

Amounts are rounded to two decimal places. The calculation helper is `src/utils/salesBonusCalculator.js`; invoice integration and product matching are in `src/controllers/salesBonusIntegration.js`.

## Approval and unpaid invoice risk

Invoice-linked bonuses start as `pending_approval`; they are not payable until approved. The administrator's bonus management list and review dialog show invoice total, amount collected, invoice due, recipient, bonus calculation, and the invoice line snapshots.

Invoice collection status is determined from posted incoming customer payment allocations to that invoice:

- **Paid:** collected amount is at least the invoice total.
- **Partially paid:** some amount is collected, but less than the invoice total.
- **Unpaid:** no amount is collected.

When an administrator approves a bonus while any portion of the invoice total remains uncollected, the approval action requires a reason (at least three non-whitespace characters). The server rechecks collection state during approval, records the reason, marks the record `approval_risk`, and snapshots the unpaid invoice amount at approval time. This server-side check is authoritative if the invoice collection changes while the review dialog is open. The record's risk marker and reason remain available in bonus management and its audit data.

Placing a bonus on hold requires a reason. A bonus with recorded payments cannot be placed on hold. Reversed bonuses cannot be approved.

## Payable amount and payment status

After approval, customer collection normally releases the approved bonus proportionally:

```text
collection ratio = min(posted customer collections ÷ invoice total, 1)
payable now      = min(approved bonus, approved bonus × collection ratio)
```

For example, if 40% of the invoice total has been collected, up to 40% of its approved bonus becomes payable. The unpaid amount is shown as awaiting invoice collection. Customer credits from returns affect invoice due projections, but the release ratio is based on posted customer payment allocations.

An administrator may pay any remaining approved bonus before collection. Recording such a payment turns on the admin payment override, making the remaining approved (return-adjusted) amount payable even if the invoice collection ratio is lower. The override does not increase the approved bonus amount. Payments can be partial or for the full remaining approved amount.

The bonus payment history is recorded in `sales_bonus_payments`. The administrator payment dialog accepts Cash, UPI, Bank transfer, and Other, plus payment date, reference, and remarks. Payment totals and payment history are shown separately. Older records whose paid total predates itemized payment history may show an explanatory message because no transaction details exist for that legacy amount.

## Returns and invoice reversal

A posted sales return creates a negative bonus adjustment based on the returned quantity's share of the original invoice line bonus. The adjusted amount is reflected in the earned/remaining bonus, including recovery due if more has already been paid than the adjusted bonus. Reversing a return adds a compensating adjustment. These changes are auditable.

If a return reduces a bonus below the amount already paid, the overpayment becomes a recovery balance on the referred person's bonus account. The balance carries forward and is automatically offset against that person's later approved bonus entitlements before additional payments are allowed. The recipient-facing bonus screen shows the account recovery balance and the amount offset against each later bonus. The underlying return adjustment and original payment history remain intact; the recovery is calculated from those ledgers rather than rewriting past payments.

Reversing the posted sales invoice reverses its linked bonus and prevents further payment. Bonus reversal is recorded as an adjustment and in audit history.

## Screens

- **Sales Billing** — enter/select **Referred By** while preparing the invoice.
- **Sales Bonus** (`SaleBonus.jsx`, `/sales-bonus`) — view a recipient's bonus records, line-level bonus, paid amount, amount due, collection waiting amount, and payment history. Administrators can use the payment action where permitted.
- **Sales Bonus Management** (`SaleBonusManagement.jsx`, `/sales-bonus-management`) — administrator review queue, invoice payment status, approval risk reason, approval/hold, detail and line snapshots, payment history, and bonus payment entry.
- **Sales Bonus Product Management** (`SalesBonusProductManagement.jsx`) — administrator product rule editor for catalog products and bonus rate/cost/unit.

## API routes

The routes below are mounted under `/api/tiles/sales-bonus` and require authentication. Administrator-only operations additionally enforce the `Admin` user type; record viewing uses the `bonus:view` permission.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/products/manage` | List active catalog products and their current bonus rules (Admin). |
| `PUT` | `/products/catalog/:productId` | Create or update the rule for a catalog product (Admin). |
| `GET` | `/products` | List active configured bonus products (Admin). |
| `POST` | `/products` | Create a bonus product rule (Admin). |
| `PUT` | `/products/:id` | Update a bonus product rule (Admin). |
| `GET` | `/records?userId=...` | View a user's bonus records; non-admin users can view only their own. |
| `PATCH` | `/records/:id/payment` | Record/update a bonus payment (Admin). |
| `GET` | `/manage/records` | List records for approval and management (Admin). |
| `GET` | `/manage/records/:id` | Load a bonus record and invoice/product detail (Admin). |
| `GET` | `/manage/records/:id/payments` | Load itemized payment history (Admin). |
| `POST` | `/manage/records/:id/approve` | Approve an invoice-linked bonus; provide `riskReason` when invoice collection is incomplete (Admin). |
| `POST` | `/manage/records/:id/hold` | Place an unpaid bonus on hold with a reason (Admin). |
| `GET` | `/top-seller` | Load top sellers (requires `bonus:view`). |
| `POST` | `/records` | Create a manual bonus record (Admin; separate from invoice automation). |

The sales invoice routes are under `/api/tiles/sales`. Posting an invoice invokes invoice bonus processing in the same transaction. Incoming payment allocation/reversal refreshes bonus payability; posted returns and invoice reversals also update linked bonus records.

## Main data model

- `sales_invoices.referred_by_user_id` and `referred_by_name_snapshot` — invoice referral and display snapshot.
- `sales_bonus_product_config` — product cost/rate/unit rule and eligibility configuration.
- `sales_bonus_records` — recipient, invoice link, calculated/approved/payable/paid totals, state, approval risk, and admin override.
- `sales_bonus_record_items` — immutable product/quantity/cost/rate/bonus calculation snapshots for each record.
- `sales_bonus_payments` — itemized payments and their method/date/reference/notes.
- `sales_bonus_adjustments` — return, return reversal, and invoice reversal accounting adjustments.
- `audit_logs` — processing, approval, hold, payment, and reversal audit events.

## Relevant migrations

The migration history is maintained in `migrations/README.md`. Sales bonus changes are represented in migrations **035–039**, covering invoice referral snapshots, invoice-driven bonus records, collection-aware payout and payment history, admin payout override, and unpaid-invoice approval risk tracking. Use the repository's normal migration runner so the migration ledger remains consistent.

## Implementation references

- `src/controllers/sales.js` — invoice creation/update/posting and referral persistence.
- `src/controllers/salesBonusIntegration.js` — product matching, invoice bonus creation, collection-based release, returns, and reversal.
- `src/controllers/salesBonus.js` — bonus rule, review, approval, payment, and history APIs.
- `src/utils/salesBonusCalculator.js` — shared calculation and validation.
- `src/routes/salesBonus.js` — bonus API route definitions and access controls.
- `../../tiles-wala-frontend/src/components/sales/SaleBonus.jsx` — recipient-facing bonus and payment history.
- `../../tiles-wala-frontend/src/components/sales/SaleBonusManagement.jsx` — administrator review and payout.
- `../../tiles-wala-frontend/src/components/sales/SalesBonusProductManagement.jsx` — catalog bonus rule editor.
- `../../tiles-wala-frontend/src/components/sales/SalesBilling.jsx` — invoice referral selection.
