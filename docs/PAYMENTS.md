# Customer receipt allocation

Updated 27 October 2026.

When a new customer receipt has no invoice selections, the backend automatically
allocates its amount to that customer's posted invoices in the selected store,
oldest invoice date first, then invoice ID for equal dates. It covers each
remaining invoice balance before moving to the next invoice. Drafts, cancelled
invoices, fully paid invoices, other customers and other stores are excluded.
Posted return credits and reversed payments are accounted for when calculating
the remaining balance.

For example, invoices A and B have ₹1,000 and ₹500 outstanding. A receipt of
₹1,200 with no selection pays ₹1,000 against A and ₹200 against B. A receipt of
₹2,000 pays both and leaves ₹500 as an advance. If no invoices are outstanding,
the entire receipt remains an advance.

The customer ledger already deducts both allocated receipts and unallocated
advance credit from net outstanding, each exactly once. An invoice's own paid
status changes only when a receipt is allocated to it. Existing advances and
historical allocations are not automatically redistributed by this change.

## API and form

- `POST /api/tiles/payments/customer-receipts` treats `allocations: []` or an
  omitted allocations field as automatic oldest-first allocation.
- A nonempty allocations array is manual and is honored exactly as supplied;
  any unallocated remainder stays as an advance. Invalid selections are rejected.
- Supplier payment behavior is unchanged: allocations must be supplied, and an
  empty list remains a supplier advance.
- The receipt form previews the automatic allocation, updates it when the
  payment amount changes, and permits manual overrides. Automatic requests send
  an empty list so the server resolves current balances rather than trusting the
  browser's preview. Existing manual oldest-first action remains available.
- Payment details show allocated and remaining advance amounts and explain that
  an active customer advance already reduces net outstanding.

## Integrity

`services/customerReceiptAllocation.js` locks candidate invoices in ID order and
uses PostgreSQL NUMERIC/window sums to distribute the payment by date and ID.
The existing posting transaction validates the chosen invoices and amounts,
creates one payment and its allocations, and records the result in audit history
with `allocationMode: OLDEST_FIRST` or `MANUAL`.

Idempotency fingerprints describe the user's original request, before automatic
selection. A transaction advisory lock serializes identical request keys, and a
retry returns the existing payment without allocating a second time or applying
an old advance to newly created invoices. Different payment attempts lock their
candidate invoices and re-read current balances before allocating.

Migration `027_payment_allocation_reversals.sql` corrects the existing database
allocation-capacity trigger: allocations belonging to reversed payments no
longer consume invoice capacity. The original records remain immutable and are
retained in history. Payment capacity, invoice capacity, posted status, store,
and foreign-key checks remain installed. No financial records are rewritten.
Apply with `npm run migrate` before running the updated backend. The paired down
migration restores the earlier guard; it does not undo receipts/allocations, and
restoring the older guard can block replacement receipts after reversals.

## Verification

Database fixtures are rolled back. Tests cover oldest dates/tied IDs, partial
payments, multiple invoices, manual overrides, customer/store isolation, posted
returns, reversals, excess advances and net balances, no-invoice advances, and
idempotent retries. Browser tests cover the preview, manual override, supplier
behavior, advance explanation, and exact decimal totals. Backend and browser
previews use exact decimal/cents calculations rather than floating point sums.
