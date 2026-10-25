DROP TRIGGER IF EXISTS stock_movement_immutable ON stock_movements;
DROP FUNCTION IF EXISTS protect_stock_movement_history();
DROP TRIGGER IF EXISTS inventory_balance_guard ON inventory_balances;
DROP FUNCTION IF EXISTS guard_inventory_balance_write();
