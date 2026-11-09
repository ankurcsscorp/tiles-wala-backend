DROP TRIGGER IF EXISTS dealer_order_transition_guard ON dealer_orders;
DROP FUNCTION IF EXISTS guard_dealer_order_transition();
DROP TABLE IF EXISTS dealer_order_quotations, dealer_order_status_history, dealer_order_items, dealer_orders, dealer_delivery_addresses, dealer_profiles;
DROP SEQUENCE IF EXISTS dealer_order_number_seq;
