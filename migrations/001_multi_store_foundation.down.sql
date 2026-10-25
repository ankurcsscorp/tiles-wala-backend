-- Destructive rollback: first export/archive all data in these tables.
DROP TRIGGER IF EXISTS transfer_no_delete ON stock_transfers;
DROP TRIGGER IF EXISTS purchase_return_no_delete ON purchase_returns;
DROP TRIGGER IF EXISTS sales_return_no_delete ON sales_returns;
DROP TRIGGER IF EXISTS purchase_invoice_no_delete ON purchase_invoices;
DROP TRIGGER IF EXISTS sales_invoice_no_delete ON sales_invoices;
DROP TRIGGER IF EXISTS payment_allocation_validate ON payment_allocations;
DROP TRIGGER IF EXISTS stock_movement_apply ON stock_movements;
DROP FUNCTION IF EXISTS block_posted_document_delete();
DROP FUNCTION IF EXISTS validate_payment_allocation();
DROP FUNCTION IF EXISTS apply_stock_movement();
DROP TABLE IF EXISTS audit_logs, stock_movements, purchase_return_items, purchase_returns,
  sales_return_items, sales_returns, stock_transfer_items, stock_transfers,
  payment_allocations, payments, sales_invoice_items, sales_invoices,
  purchase_invoice_items, purchase_invoices, invoice_number_sequences,
  inventory_balances, store_billing_config, suppliers, customers, products,
  units_of_measure, user_store_assignments, stores CASCADE;
