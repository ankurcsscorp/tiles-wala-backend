# Dealer portal foundation

Apply with `npm run migrate` (migration `042_dealer_ordering_portal.sql`). Provision a Dealer profile as Admin before the dealer can use the portal. A profile is bound to one store; the optional `customerId` links to the shared customer party and ledger. No dealer, product, unit, or customer master is duplicated.

All endpoints use Bearer JWT authentication. Dealer routes derive profile and order scope from the authenticated user; callers cannot supply a dealer ID or store ID to widen access. Admin can list/read all dealer orders, provision profiles, and issue quotations.

Dealer catalog products are managed through the Admin Product Management form. Each explicit `dealerPrices` entry is `{unitId, price}` and `availableForDealerOrdering` controls listing. Prices can only reference the product's base unit or a configured conversion unit. The catalog returns only priced units; an unpriced unit cannot be ordered. Price changes affect future orders only: order lines snapshot the submitted unit's dealer price and quotation versions retain those line snapshots. Catalog responses also include `stock_status` (`IN_STOCK`, `LIMITED_STOCK`, or `OUT_OF_STOCK`) and the store's `transportCharge` value.

| Method and path | Access | Contract |
| --- | --- | --- |
| `POST /api/tiles/dealer-portal/profiles` | Admin | `{userId, storeId, businessName, customerId?, ...profile fields}` |
| `GET /api/tiles/dealer-portal/profile` | Dealer | Own profile and store/customer mapping |
| `GET /api/tiles/dealer-portal/addresses` | Dealer | Own active delivery addresses |
| `POST /api/tiles/dealer-portal/addresses` | Dealer | `{label, address, contactName?, mobile?, isDefault?}` |
| `GET /api/tiles/dealer/products` or `/api/tiles/dealer-portal/catalog` | Dealer | Products enabled for dealer ordering, explicit per-unit dealer prices, GST/category/image details, and a boolean stock indicator; no stock quantity or cost |
| `POST /api/tiles/dealer-portal/orders` | Dealer | `{items:[{productId,unitId,quantity}], billingAddress?, deliveryAddress?, deliveryAddressId?, notes?}` |
| `GET /api/tiles/dealer-portal/orders` | Dealer or Admin | Dealer's own orders, or all orders for Admin |
| `GET /api/tiles/dealer-portal/orders/:id` | Dealer or Admin | Order, items, history, and quotation snapshots; dealer ownership enforced |
| `POST /api/tiles/dealer-portal/orders/:id/quotations` | Admin | `{transportCharge?,discountAmount?,taxAmount?,validUntil?,remarks?}`; records a versioned quote and issues `QUOTATION_SENT` |
| `PATCH /api/tiles/dealer-portal/orders/:id/status` | Dealer | Legacy cancellation contract only; use the versioned `accept-quotation` endpoint to confirm |
| `GET /api/tiles/dealer-portal/outstanding` | Dealer | Derived from the linked customer ledger for the profile's store; zero when no ledger link exists |
| `GET /api/tiles/dealer-portal/ledger` | Dealer | Paginated existing customer-party ledger scoped to the authenticated dealer's mapped customer and assigned store. Posted invoices, receipts, returns, refunds, and adjustments are included; unconfirmed quotations are excluded. |
| `GET /api/tiles/dealer-portal/ledger` | Dealer | Paginated existing customer-party ledger, scoped to the authenticated dealer's mapped customer and assigned store; includes posted invoices, receipts, returns, refunds, and adjustments. Unconfirmed quotations are excluded. |

Status transitions are database-guarded. Dealer order creation stores request and price/address snapshots only. It creates no final invoice, stock movement, inventory deduction, revenue, or commission. Payment status begins as `UNPAID`; verified UPI and Admin COD collections reuse the existing customer receipt ledger and remain dealer-order advances until invoice allocation. The existing sales finalization service remains the only sales invoice and inventory posting path.

Store scope comes from the Dealer profile and the order's composite `(dealer_id, store_id)` foreign key. The product master is shared in this application; the catalog lists active shared products explicitly enabled and priced for dealer ordering, plus stock status for the dealer's assigned store. It omits stock quantities. Migration 044 configures transport per store (INR 1,000 by default); order creation snapshots this once per order. Submission locks/rechecks the relevant stock rows and validates combined quantities across selected units. It does not reserve or deduct stock. Migration 049 adds the shipment and delivery event records used by the Admin fulfillment workflow.

## Checkout and quotation

Migration 045 adds a required `Idempotency-Key` header and request fingerprint to order placement, delivery contact/instruction snapshots, a first quotation version created atomically with the order request, and in-app notification rows for Admin and dealer accounts. Reusing a key with a different payload returns `409`. The initial order remains `PENDING_REVIEW` with `UNPAID`, even when UPI is selected. Admin quotation edits can provide an `items` array with product/unit/quantity and optional `dealerPrice`; each revision creates a new immutable quotation version and requires acceptance of that version.

| Method and path | Access | Contract |
| --- | --- | --- |
| `POST /api/tiles/dealer/orders` | Dealer | `Idempotency-Key` header and `{items:[{productId,unitId,quantity}],paymentMethod:'UPI'|'CASH_ON_DELIVERY',deliveryAddressId?,deliveryInstructions?}`; server supplies prices, tax, and transport. Returns order and quotation identifiers. |
| `GET /api/tiles/dealer/orders` | Dealer | Own orders. |
| `GET /api/tiles/dealer/orders/:id` | Dealer or Admin | Order and versioned quotation history; dealer ownership enforced. |
| `GET /api/tiles/dealer/orders/:id/quotation?version=n` | Dealer or Admin | Download a PDF quotation/proforma snapshot, never a sales tax invoice. |
| `GET /api/tiles/dealer/orders/:id/payment-intent` | Dealer | Returns a UPI intent URI when the assigned store has a configured UPI VPA and the order selected UPI. It does not verify or record payment. |
| `POST /api/tiles/dealer/orders/:id/accept-quotation` | Dealer | `{quotationVersion}` must match the current offer; stale versions are rejected. |
| `POST /api/tiles/dealer/orders/:id/cancel` | Dealer | Cancels an order in a cancellable state. |
| `POST /api/tiles/dealer/orders/:id/quotations` | Admin | `{transportCharge?,discountAmount?,taxAmount?,items?,validUntil?,remarks?}`; preserves prior versions, updates the current offer, and notifies the dealer. |
| `GET /api/tiles/dealer/admin/notifications` | Admin | Recent dealer order and quotation events. |
| `GET /api/tiles/dealer/notifications` | Dealer | Own quotation revision notifications. |

UPI collection uses the Razorpay order and signature-verified webhook integration. Configure backend credentials and register the documented webhook before enabling live collection. Admin order notifications are available through the in-app inbox endpoint; no email/SMS notification provider is configured.

## Fulfillment and sales invoice integration

Migration 049 adds `dealer_order_shipments`, append-only `dealer_order_delivery_events`, delivery receipt fields, and a same-store one-to-one link between dealer orders and existing sales invoices. Shipment attachment upload is not enabled because the project has no secure file storage adapter.

| Method and path | Access | Contract |
| --- | --- | --- |
| `POST /api/tiles/dealer-portal/admin/orders/:id/invoice-draft` | Admin | Creates a standard sales invoice draft from the accepted quotation and links it to the dealer order. It requires a customer ledger mapping, `READY_TO_DISPATCH`, confirmed stock/payment terms, and a tax-compliant total that matches the accepted quote. |
| `PUT /api/tiles/dealer-portal/admin/orders/:id/shipment` | Admin | Saves transporter, vehicle, driver, dispatch/ETA, tracking/LR number, and remarks once the order is ready to dispatch. |
| `PUT /api/tiles/dealer-portal/admin/orders/:id/referral` | Admin | `{referredByUserId}` may select an active salesperson or Tiles Mistri before an invoice draft is linked. |
| `PATCH /api/tiles/dealer-portal/admin/orders/:id/status` | Admin | Status changes remain transition-guarded. `SHIPPED` requires a posted linked invoice plus dispatch details; `DELIVERED` records actual date, recipient, and remarks. |
| `POST /api/tiles/dealer-portal/admin/orders/:id/partial-delivery` | Admin | `{items:[{invoiceItemId,quantity}],remarks?}` records a partial shipment receipt against posted invoice lines, rejects cumulative quantity above invoiced quantity, keeps order `SHIPPED`, and adds dealer activity plus an audit record. |
| `GET /api/tiles/dealer-portal/orders/:id/invoice` | Owning Dealer | Returns posted invoice lines, tax/document details, allocated receipts, and current outstanding balance. |
| `GET /api/tiles/dealer-portal/admin/reports?storeId=n` | Admin | Dealer order totals, posted invoice sales trends, UPI/COD collections, dealer outstanding balances, product demand, and order/shipping status. Optional store filter is authorized server-side. |

The invoice draft uses the active store's existing document-type and appearance settings. Finalization remains `POST /api/tiles/sales/:invoiceId/finalize`: the existing sales service revalidates GST treatment, stock/conversions, numbering, and bonus rules. That transaction writes stock movements once, links verified dealer-order receipts to the invoice up to its due amount, updates dealer payment status, and adds an audit/activity entry. Later COD/invoice collections use existing payment and allocation services. Sales returns remain on the existing linked return workflow; an invoiced order cannot be cancelled as if the invoice did not exist.
