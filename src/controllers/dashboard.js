import { connection } from "../../connection.js";
import { canAccessStore } from "./stores.js";

const isAdmin = (req) => req.user?.userType?.toLowerCase() === "admin";
const validId = (value) => /^\d+$/.test(String(value ?? ""));
const validDate = (value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

async function authorizedStores(req, res) {
  const result = isAdmin(req)
    ? await connection.query("SELECT id FROM stores WHERE is_active=TRUE ORDER BY id")
    : await connection.query("SELECT s.id FROM user_store_assignments a JOIN stores s ON s.id=a.store_id WHERE a.user_id=$1 AND a.is_active=TRUE AND s.is_active=TRUE ORDER BY s.id", [req.user.id]);
  const ids = result.rows.map((row) => String(row.id));
  if (req.query.storeId) {
    if (!validId(req.query.storeId)) { res.status(400).json({ message: "Invalid store ID" }); return null; }
    if (!ids.includes(String(req.query.storeId)) || !(await canAccessStore(req.user, req.query.storeId))) { res.status(403).json({ message: "You do not have access to this store" }); return null; }
    return [String(req.query.storeId)];
  }
  return ids;
}

function dateRange(req, res) {
  const from = req.query.fromDate || null;
  const to = req.query.toDate || null;
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) {
    res.status(400).json({ message: "Use valid YYYY-MM-DD dates with fromDate before toDate" });
    return null;
  }
  return { from, to };
}

export async function dashboardSummary(req, res) {
  const stores = await authorizedStores(req, res);
  if (!stores) return;
  const range = dateRange(req, res);
  if (!range) return;
  if (!stores.length) return res.json({ stores: [], summary: {}, salesByStore: [], inventory: {}, lowStockCount: 0, grossProfit: { available: false, reason: "Sales invoice lines do not store a reliable cost-of-goods snapshot." } });
  try {
    const [sales, purchases, finance, payments, inventory, lowStock, salesByStore, transit] = await Promise.all([
      connection.query(`SELECT
        COALESCE(sum(total) FILTER (WHERE invoice_date=CURRENT_DATE),0)::numeric(18,2) today,
        COALESCE(sum(total) FILTER (WHERE invoice_date>=date_trunc('month',CURRENT_DATE)::date AND invoice_date<=CURRENT_DATE),0)::numeric(18,2) month,
        COALESCE(sum(total) FILTER (WHERE ($2::date IS NULL OR invoice_date>=$2::date) AND ($3::date IS NULL OR invoice_date<=$3::date)),0)::numeric(18,2) selected
        FROM sales_invoices WHERE store_id=ANY($1::bigint[]) AND status='posted'`, [stores, range.from, range.to]),
      connection.query(`SELECT
        COALESCE(sum(total) FILTER (WHERE invoice_date=CURRENT_DATE),0)::numeric(18,2) today,
        COALESCE(sum(total) FILTER (WHERE invoice_date>=date_trunc('month',CURRENT_DATE)::date AND invoice_date<=CURRENT_DATE),0)::numeric(18,2) month,
        COALESCE(sum(total) FILTER (WHERE ($2::date IS NULL OR invoice_date>=$2::date) AND ($3::date IS NULL OR invoice_date<=$3::date)),0)::numeric(18,2) selected
        FROM purchase_invoices WHERE store_id=ANY($1::bigint[]) AND status='posted'`, [stores, range.from, range.to]),
      connection.query(`WITH customer_entries AS (
        SELECT store_id,total debit,0::numeric credit FROM sales_invoices WHERE status='posted' AND store_id=ANY($1::bigint[])
        UNION ALL SELECT pa.store_id,0::numeric,pa.amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' AND p.direction='in' JOIN sales_invoices i ON i.id=pa.sales_invoice_id AND i.status='posted' WHERE pa.store_id=ANY($1::bigint[])
        UNION ALL SELECT p.store_id,0::numeric,GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='in'),0),0) FROM payments p WHERE p.status='posted' AND p.direction='in' AND p.customer_id IS NOT NULL AND p.store_id=ANY($1::bigint[])
        UNION ALL SELECT store_id,refund_amount,customer_credit FROM sales_returns WHERE status='posted' AND store_id=ANY($1::bigint[])
        UNION ALL SELECT store_id,CASE WHEN direction='debit' THEN amount ELSE 0 END,CASE WHEN direction='credit' THEN amount ELSE 0 END FROM customer_balance_adjustments WHERE status='posted' AND store_id=ANY($1::bigint[])
      ), supplier_entries AS (
        SELECT store_id,0::numeric debit,total credit FROM purchase_invoices WHERE status='posted' AND store_id=ANY($1::bigint[])
        UNION ALL SELECT pa.store_id,pa.amount,0::numeric FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' AND p.direction='out' JOIN purchase_invoices i ON i.id=pa.purchase_invoice_id AND i.status='posted' WHERE pa.store_id=ANY($1::bigint[])
        UNION ALL SELECT p.store_id,GREATEST(p.amount-COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.payment_id=p.id AND pa.direction='out'),0),0),0::numeric FROM payments p WHERE p.status='posted' AND p.direction='out' AND p.supplier_id IS NOT NULL AND p.store_id=ANY($1::bigint[])
        UNION ALL SELECT store_id,supplier_credit,0::numeric FROM purchase_returns WHERE status='posted' AND store_id=ANY($1::bigint[])
        UNION ALL SELECT store_id,CASE WHEN direction='debit' THEN amount ELSE 0 END,CASE WHEN direction='credit' THEN amount ELSE 0 END FROM supplier_balance_adjustments WHERE status='posted' AND store_id=ANY($1::bigint[])
      ) SELECT COALESCE((SELECT sum(debit-credit) FROM customer_entries),0)::numeric(18,2) receivables,COALESCE((SELECT sum(credit-debit) FROM supplier_entries),0)::numeric(18,2) payables`, [stores]),
      connection.query(`SELECT COALESCE(sum(amount) FILTER(WHERE direction='in'),0)::numeric(18,2) receipts,COALESCE(sum(amount) FILTER(WHERE direction='out'),0)::numeric(18,2) supplierPayments,count(*) FILTER(WHERE direction='in')::int receiptCount,count(*) FILTER(WHERE direction='out')::int supplierPaymentCount
        FROM payments WHERE store_id=ANY($1::bigint[]) AND status='posted' AND payment_date=CURRENT_DATE`, [stores]),
      connection.query(`SELECT COALESCE(sum(ib.quantity),0)::numeric(18,4) quantity,COALESCE(sum(ib.quantity*p.default_purchase_price/COALESCE(conv.factor_to_base,1)) FILTER(WHERE p.default_purchase_price IS NOT NULL),0)::numeric(18,2) valuation,
        count(*) FILTER(WHERE ib.quantity IS NOT NULL AND p.default_purchase_price IS NULL)::int unvaluedProductStoreCount
        FROM stores st CROSS JOIN products p LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id LEFT JOIN product_unit_conversions conv ON conv.product_id=p.id AND conv.unit_id=p.purchase_unit_id
        WHERE st.id=ANY($1::bigint[]) AND p.is_active=TRUE`, [stores]),
      connection.query(`SELECT count(*)::int count FROM stores st CROSS JOIN products p LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id WHERE st.id=ANY($1::bigint[]) AND p.is_active=TRUE AND p.reorder_threshold IS NOT NULL AND COALESCE(ib.quantity,0)<=p.reorder_threshold`, [stores]),
      connection.query(`SELECT st.id store_id,st.code store_code,st.name store_name,COALESCE(sum(si.total),0)::numeric(18,2) sales FROM stores st LEFT JOIN sales_invoices si ON si.store_id=st.id AND si.status='posted' AND si.invoice_date BETWEEN COALESCE($2::date,date_trunc('month',CURRENT_DATE)::date) AND COALESCE($3::date,CURRENT_DATE) WHERE st.id=ANY($1::bigint[]) GROUP BY st.id,st.code,st.name ORDER BY sales DESC,st.name`, [stores, range.from, range.to]),
      connection.query(`SELECT COALESCE(sum(m.quantity_delta),0)::numeric(18,4) quantity FROM stock_transfer_transit_movements m JOIN stock_transfers t ON t.id=m.transfer_id WHERE t.from_store_id=ANY($1::bigint[]) OR t.to_store_id=ANY($1::bigint[])`, [stores]),
    ]);
    const totalQuantity = await connection.query("SELECT ($1::numeric+$2::numeric)::numeric(18,4) quantity", [inventory.rows[0].quantity, transit.rows[0].quantity]);
    const inventorySummary = { ...inventory.rows[0], transitQuantity: transit.rows[0].quantity, businessTotalQuantity: totalQuantity.rows[0].quantity };
    return res.json({ stores, fromDate: range.from, toDate: range.to, summary: { todaySales: sales.rows[0].today, monthlySales: sales.rows[0].month, selectedPeriodSales: sales.rows[0].selected, todayPurchases: purchases.rows[0].today, monthlyPurchases: purchases.rows[0].month, selectedPeriodPurchases: purchases.rows[0].selected, customerOutstanding: finance.rows[0].receivables, supplierOutstanding: finance.rows[0].payables, todayReceipts: payments.rows[0].receipts, todaySupplierPayments: payments.rows[0].supplierpayments, receiptCount: payments.rows[0].receiptcount, supplierPaymentCount: payments.rows[0].supplierpaymentcount }, inventory: inventorySummary, lowStockCount: lowStock.rows[0].count, salesByStore: salesByStore.rows, grossProfit: { available: false, reason: "Sales invoice lines do not store a reliable cost-of-goods snapshot." }, inventoryValuationBasis: "On-hand quantity × configured default purchase price, converted from purchase unit; this is indicative and is not used as cost of goods sold." });
  } catch (error) {
    console.error("Unable to load dashboard summary:", error.message);
    return res.status(500).json({ message: "Unable to load dashboard summary" });
  }
}

const REPORTS = {
  sales_by_date: { sql: `SELECT si.invoice_date report_date,count(*)::int invoice_count,sum(si.subtotal)::numeric(18,2) gross_sales,sum(si.discount_total)::numeric(18,2) discounts,sum(si.taxable_total)::numeric(18,2) net_sales,sum(si.tax_total)::numeric(18,2) taxes,sum(si.total)::numeric(18,2) invoice_total FROM sales_invoices si WHERE si.store_id=ANY($1::bigint[]) AND si.status='posted' AND si.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY si.invoice_date ORDER BY si.invoice_date DESC`, columns: ["report_date","invoice_count","gross_sales","discounts","net_sales","taxes","invoice_total"] },
  sales_by_store: { sql: `SELECT st.id store_id,st.code,st.name store_name,count(si.id)::int invoice_count,COALESCE(sum(si.subtotal),0)::numeric(18,2) gross_sales,COALESCE(sum(si.discount_total),0)::numeric(18,2) discounts,COALESCE(sum(si.taxable_total),0)::numeric(18,2) net_sales,COALESCE(sum(si.tax_total),0)::numeric(18,2) taxes,COALESCE(sum(si.total),0)::numeric(18,2) invoice_total FROM stores st LEFT JOIN sales_invoices si ON si.store_id=st.id AND si.status='posted' AND si.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') WHERE st.id=ANY($1::bigint[]) GROUP BY st.id,st.code,st.name ORDER BY net_sales DESC`, columns: ["store_id","code","store_name","invoice_count","gross_sales","discounts","net_sales","taxes","invoice_total"] },
  sales_by_product: { sql: `SELECT sii.product_id,p.sku,sii.description product_name,sum(sii.quantity)::numeric(18,4) quantity,sum(sii.quantity*sii.unit_price)::numeric(18,2) gross_sales,sum(sii.discount_amount+sii.invoice_discount_amount)::numeric(18,2) discounts,sum(sii.taxable_value)::numeric(18,2) net_sales,sum(sii.tax_amount)::numeric(18,2) taxes FROM sales_invoice_items sii JOIN sales_invoices si ON si.id=sii.sales_invoice_id JOIN products p ON p.id=sii.product_id WHERE si.store_id=ANY($1::bigint[]) AND si.status='posted' AND si.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY sii.product_id,p.sku,sii.description ORDER BY net_sales DESC`, columns: ["sku","product_name","quantity","gross_sales","discounts","net_sales","taxes"] },
  sales_by_customer: { sql: `SELECT si.customer_id,COALESCE(si.customer_name_snapshot,c.name,'Walk-in') customer_name,count(*)::int invoice_count,sum(si.total)::numeric(18,2) net_sales FROM sales_invoices si LEFT JOIN customers c ON c.id=si.customer_id WHERE si.store_id=ANY($1::bigint[]) AND si.status='posted' AND si.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY si.customer_id,COALESCE(si.customer_name_snapshot,c.name,'Walk-in') ORDER BY net_sales DESC`, columns: ["customer_id","customer_name","invoice_count","net_sales"] },
  sales_by_salesperson: { sql: `SELECT COALESCE(si.salesperson_name_snapshot,'Unassigned') salesperson,count(*)::int invoice_count,sum(si.total)::numeric(18,2) net_sales FROM sales_invoices si WHERE si.store_id=ANY($1::bigint[]) AND si.status='posted' AND si.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY COALESCE(si.salesperson_name_snapshot,'Unassigned') ORDER BY net_sales DESC`, columns: ["salesperson","invoice_count","net_sales"] },
  purchases_by_date: { sql: `SELECT pi.invoice_date report_date,count(*)::int invoice_count,sum(pi.subtotal)::numeric(18,2) subtotal,sum(pi.discount_total)::numeric(18,2) discounts,sum(pi.total)::numeric(18,2) purchases FROM purchase_invoices pi WHERE pi.store_id=ANY($1::bigint[]) AND pi.status='posted' AND pi.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY pi.invoice_date ORDER BY pi.invoice_date DESC`, columns: ["report_date","invoice_count","subtotal","discounts","purchases"] },
  purchases_by_store: { sql: `SELECT st.code,st.name store_name,count(pi.id)::int invoice_count,COALESCE(sum(pi.total),0)::numeric(18,2) purchases FROM stores st LEFT JOIN purchase_invoices pi ON pi.store_id=st.id AND pi.status='posted' AND pi.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') WHERE st.id=ANY($1::bigint[]) GROUP BY st.id,st.code,st.name ORDER BY purchases DESC`, columns: ["code","store_name","invoice_count","purchases"] },
  purchases_by_supplier: { sql: `SELECT pi.supplier_id,su.code supplier_code,su.name supplier_name,count(*)::int invoice_count,sum(pi.total)::numeric(18,2) purchases FROM purchase_invoices pi JOIN suppliers su ON su.id=pi.supplier_id WHERE pi.store_id=ANY($1::bigint[]) AND pi.status='posted' AND pi.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY pi.supplier_id,su.code,su.name ORDER BY purchases DESC`, columns: ["supplier_code","supplier_name","invoice_count","purchases"] },
  purchases_by_product: { sql: `SELECT p.sku,pii.description product_name,sum(pii.quantity)::numeric(18,4) quantity,sum(pii.line_total)::numeric(18,2) purchases FROM purchase_invoice_items pii JOIN purchase_invoices pi ON pi.id=pii.purchase_invoice_id JOIN products p ON p.id=pii.product_id WHERE pi.store_id=ANY($1::bigint[]) AND pi.status='posted' AND pi.invoice_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY p.sku,pii.description ORDER BY purchases DESC`, columns: ["sku","product_name","quantity","purchases"] },
  payment_methods: { sql: `SELECT CASE direction WHEN 'in' THEN 'Customer receipt' ELSE 'Supplier payment' END payment_type,payment_method,count(*)::int payment_count,sum(amount)::numeric(18,2) amount FROM payments WHERE store_id=ANY($1::bigint[]) AND status='posted' AND payment_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY direction,payment_method ORDER BY direction,payment_method`, columns: ["payment_type","payment_method","payment_count","amount"] },
  daily_collections: { sql: `SELECT payment_date,CASE direction WHEN 'in' THEN 'Customer receipt' ELSE 'Supplier payment' END payment_type,count(*)::int payment_count,sum(amount)::numeric(18,2) amount FROM payments WHERE store_id=ANY($1::bigint[]) AND status='posted' AND payment_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY payment_date,direction ORDER BY payment_date DESC,direction`, columns: ["payment_date","payment_type","payment_count","amount"] },
  inventory_valuation: { sql: `SELECT st.name store_name,p.sku,p.name product_name,u.code unit,ib.quantity,CASE WHEN p.default_purchase_price IS NULL THEN NULL ELSE (ib.quantity*p.default_purchase_price/COALESCE(cv.factor_to_base,1))::numeric(18,2) END indicative_value FROM inventory_balances ib JOIN stores st ON st.id=ib.store_id JOIN products p ON p.id=ib.product_id JOIN units_of_measure u ON u.id=p.base_unit_id LEFT JOIN product_unit_conversions cv ON cv.product_id=p.id AND cv.unit_id=p.purchase_unit_id WHERE st.id=ANY($1::bigint[]) AND p.is_active=TRUE AND ib.quantity<>0 ORDER BY st.name,p.name`, columns: ["store_name","sku","product_name","unit","quantity","indicative_value"] },
  stock_by_store: { sql: `SELECT st.code store_code,st.name store_name,count(DISTINCT p.id)::int product_count,COALESCE(sum(ib.quantity),0)::numeric(18,4) quantity,COALESCE(sum(ib.quantity*p.default_purchase_price/COALESCE(cv.factor_to_base,1)) FILTER(WHERE p.default_purchase_price IS NOT NULL),0)::numeric(18,2) indicative_valuation FROM stores st CROSS JOIN products p LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id LEFT JOIN product_unit_conversions cv ON cv.product_id=p.id AND cv.unit_id=p.purchase_unit_id WHERE st.id=ANY($1::bigint[]) AND p.is_active=TRUE GROUP BY st.id,st.code,st.name ORDER BY st.name`, columns: ["store_code","store_name","product_count","quantity","indicative_valuation"] },
  low_stock: { sql: `SELECT st.name store_name,p.sku,p.name product_name,COALESCE(ib.quantity,0)::numeric(18,4) quantity_on_hand,p.reorder_threshold FROM stores st CROSS JOIN products p LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id WHERE st.id=ANY($1::bigint[]) AND p.is_active=TRUE AND p.reorder_threshold IS NOT NULL AND COALESCE(ib.quantity,0)<=p.reorder_threshold ORDER BY st.name,COALESCE(ib.quantity,0),p.name`, columns: ["store_name","sku","product_name","quantity_on_hand","reorder_threshold"] },
  stock_movements: { sql: `SELECT m.created_at,m.movement_type,st.name store_name,p.sku,p.name product_name,m.quantity_delta,m.source_type,m.source_id FROM stock_movements m JOIN stores st ON st.id=m.store_id JOIN products p ON p.id=m.product_id WHERE m.store_id=ANY($1::bigint[]) AND m.created_at>=COALESCE($2::date,'1900-01-01')::timestamptz AND m.created_at<(COALESCE($3::date,'9999-12-31')+1)::timestamptz ORDER BY m.created_at DESC,m.id DESC`, columns: ["created_at","movement_type","store_name","sku","product_name","quantity_delta","source_type","source_id"] },
  transfers: { sql: `SELECT t.transfer_number,t.transfer_date,t.status,fs.name source_store,ts.name destination_store,count(ti.id)::int item_count,COALESCE(sum(ti.dispatched_base_quantity),0)::numeric(18,4) dispatched_quantity FROM stock_transfers t JOIN stores fs ON fs.id=t.from_store_id JOIN stores ts ON ts.id=t.to_store_id LEFT JOIN stock_transfer_items ti ON ti.transfer_id=t.id WHERE (t.from_store_id=ANY($1::bigint[]) OR t.to_store_id=ANY($1::bigint[])) AND t.transfer_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') GROUP BY t.id,fs.name,ts.name ORDER BY t.transfer_date DESC,t.id DESC`, columns: ["transfer_number","transfer_date","status","source_store","destination_store","item_count","dispatched_quantity"] },
  returns: { sql: `SELECT 'Sales return' return_type,r.return_number,r.return_date,r.status,s.name store_name,si.invoice_number original_invoice,r.total::numeric(18,2) amount FROM sales_returns r JOIN sales_invoices si ON si.id=r.sales_invoice_id JOIN stores s ON s.id=r.store_id WHERE r.store_id=ANY($1::bigint[]) AND r.return_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') UNION ALL SELECT 'Purchase return',r.return_number,r.return_date,r.status,s.name,pi.invoice_number,r.total::numeric(18,2) FROM purchase_returns r JOIN purchase_invoices pi ON pi.id=r.purchase_invoice_id JOIN stores s ON s.id=r.store_id WHERE r.store_id=ANY($1::bigint[]) AND r.return_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'9999-12-31') ORDER BY return_date DESC,return_number DESC`, columns: ["return_type","return_number","return_date","status","store_name","original_invoice","amount"] },
};

export async function dashboardReport(req, res) {
  const report = REPORTS[req.query.report];
  if (!report) return res.status(400).json({ message: "Choose a supported report", reports: Object.keys(REPORTS) });
  const stores = await authorizedStores(req, res);
  if (!stores) return;
  const range = dateRange(req, res);
  if (!range) return;
  const limit = Number.parseInt(req.query.limit, 10) || 50;
  const offset = Number.parseInt(req.query.offset, 10) || 0;
  if (limit < 1 || limit > 200 || offset < 0) return res.status(400).json({ message: "Limit must be 1–200 and offset cannot be negative" });
  if (!stores.length) return res.json({ report: req.query.report, columns: report.columns, items: [], pagination: { limit, offset, total: 0 } });
  try {
    const usesDateRange = report.sql.includes("$2::date") || report.sql.includes("$3::date");
    const result = usesDateRange
      ? await connection.query(`SELECT * FROM (${report.sql}) report_rows LIMIT $4 OFFSET $5`, [stores, range.from, range.to, limit, offset])
      : await connection.query(`SELECT * FROM (${report.sql}) report_rows LIMIT $2 OFFSET $3`, [stores, limit, offset]);
    const count = usesDateRange
      ? await connection.query(`SELECT count(*)::int total FROM (${report.sql}) report_rows`, [stores, range.from, range.to])
      : await connection.query(`SELECT count(*)::int total FROM (${report.sql}) report_rows`, [stores]);
    return res.json({ report: req.query.report, columns: report.columns, items: result.rows, pagination: { limit, offset, total: count.rows[0].total }, grossProfit: { available: false, reason: "No reliable cost-of-goods snapshot is recorded on sales invoice lines." } });
  } catch (error) {
    console.error("Unable to load dashboard report:", error.message);
    return res.status(500).json({ message: "Unable to load dashboard report" });
  }
}
