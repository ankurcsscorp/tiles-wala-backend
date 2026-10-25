import { connection } from "../../connection.js";
import { canAccessStore } from "./stores.js";

const admin = (req) => req.user?.userType?.toLowerCase() === "admin";
const idPattern = /^\d+$/;
const positiveInt = (value, fallback, max = 200) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
};

async function authorizeFilter(req, res) {
  const storeId = req.query.storeId;
  if (storeId && !idPattern.test(String(storeId))) {
    res.status(400).json({ message: "Invalid store ID" });
    return null;
  }
  if (storeId && !(await canAccessStore(req.user, storeId))) {
    res.status(403).json({ message: "You do not have access to this store" });
    return null;
  }
  return storeId || null;
}

function visibleStoreClause(req, storeId, values, alias = "st") {
  if (storeId) { values.push(storeId); return `${alias}.is_active=TRUE AND ${alias}.id=$${values.length}`; }
  if (admin(req)) return `${alias}.is_active=TRUE`;
  values.push(req.user.id);
  return `${alias}.is_active=TRUE AND EXISTS (SELECT 1 FROM user_store_assignments usa WHERE usa.store_id=${alias}.id AND usa.user_id=$${values.length} AND usa.is_active=TRUE)`;
}

function transferScope(req, storeId, values) {
  const clauses=[];
  if(storeId){values.push(storeId);clauses.push(`(t.from_store_id=$${values.length} OR t.to_store_id=$${values.length})`);}
  if(!admin(req)){values.push(req.user.id);clauses.push(`(EXISTS(SELECT 1 FROM user_store_assignments a WHERE a.user_id=$${values.length} AND a.store_id=t.from_store_id AND a.is_active=TRUE) OR EXISTS(SELECT 1 FROM user_store_assignments a WHERE a.user_id=$${values.length} AND a.store_id=t.to_store_id AND a.is_active=TRUE))`);}
  return clauses.length?clauses.join(" AND "):"TRUE";
}

function searchClause(req, values, aliases = ["p.sku", "p.name", "p.brand", "p.collection", "p.tile_size", "p.finish"]) {
  if (!req.query.search) return "TRUE";
  values.push(`%${String(req.query.search).trim().slice(0, 100)}%`);
  const bind = `$${values.length}`;
  return `(${aliases.map((field) => `COALESCE(${field},'') ILIKE ${bind}`).join(" OR ")})`;
}

const inventorySelect = `SELECT p.id AS product_id,p.sku,p.name AS product_name,p.brand,p.collection,p.tile_size,p.finish,
  st.id AS store_id,st.code AS store_code,st.name AS store_name,u.code AS unit_code,u.name AS unit_name,
  COALESCE(ib.quantity,0)::NUMERIC(18,4) AS quantity_on_hand,0::NUMERIC(18,4) AS reserved_quantity,
  COALESCE(ib.quantity,0)::NUMERIC(18,4) AS available_quantity,
  p.default_purchase_price,
  CASE WHEN p.default_purchase_price IS NULL THEN NULL ELSE p.default_purchase_price / COALESCE(conv.factor_to_base,1) END AS unit_cost_base,
  CASE WHEN p.default_purchase_price IS NULL THEN NULL ELSE COALESCE(ib.quantity,0) * p.default_purchase_price / COALESCE(conv.factor_to_base,1) END AS stock_value
 FROM stores st CROSS JOIN products p
 JOIN units_of_measure u ON u.id=p.base_unit_id
 LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id
 LEFT JOIN product_unit_conversions conv ON conv.product_id=p.id AND conv.unit_id=p.purchase_unit_id`;

export async function inventoryList(req, res) {
  try {
    const storeId = await authorizeFilter(req, res); if (storeId === null && req.query.storeId) return;
    const values = [];
    const storeClause = visibleStoreClause(req, storeId, values);
    const productClause = searchClause(req, values);
    const includeZero = req.query.includeZero === "true";
    const limit = positiveInt(req.query.limit, 50, 200); const offset = positiveInt(req.query.offset, 1, 1000000) - 1;
    const selectWithCount = inventorySelect.replace(" FROM stores st", ",count(*) OVER()::int AS total_count FROM stores st");
    const sql = `${selectWithCount} WHERE ${storeClause} AND p.is_active=TRUE AND ${productClause} ${includeZero ? "" : "AND COALESCE(ib.quantity,0)<>0"} ORDER BY st.name,p.name LIMIT $${values.length+1} OFFSET $${values.length+2}`;
    values.push(limit, offset);
    const result = await connection.query(sql, values);
    res.json({ items: result.rows, limit, offset, total: result.rows[0]?.total_count ?? 0 });
  } catch (error) { console.error("Unable to load inventory:", error.message); res.status(500).json({ message: "Unable to load inventory" }); }
}

export async function inventorySummary(req, res) {
  try {
    const storeId = await authorizeFilter(req, res); if (storeId === null && req.query.storeId) return;
    const values = []; const storeClause = visibleStoreClause(req, storeId, values);
    const { rows } = await connection.query(`SELECT COUNT(DISTINCT p.id)::int AS product_count,COUNT(DISTINCT st.id)::int AS store_count,
      COALESCE(SUM(ib.quantity),0)::NUMERIC(18,4) AS total_quantity,
      COALESCE(SUM(ib.quantity*p.default_purchase_price/COALESCE(conv.factor_to_base,1)) FILTER (WHERE p.default_purchase_price IS NOT NULL),0)::NUMERIC(18,2) AS valued_stock,
      COUNT(*) FILTER(WHERE ib.quantity IS NOT NULL AND p.default_purchase_price IS NULL)::int AS unvalued_product_store_count
      FROM stores st CROSS JOIN products p LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id
      LEFT JOIN product_unit_conversions conv ON conv.product_id=p.id AND conv.unit_id=p.purchase_unit_id
      WHERE ${storeClause} AND st.is_active=TRUE AND p.is_active=TRUE`, values);
    const transitValues=[];const transitWhere=transferScope(req,storeId,transitValues);
    const transit=await connection.query(`SELECT COALESCE(SUM(m.quantity_delta),0)::NUMERIC(18,4) AS transit_quantity FROM stock_transfer_transit_movements m JOIN stock_transfers t ON t.id=m.transfer_id WHERE ${transitWhere}`,transitValues);
    const transitQuantity=transit.rows[0].transit_quantity;
    const businessTotal=await connection.query("SELECT ($1::numeric+$2::numeric)::NUMERIC(18,4) AS quantity",[rows[0].total_quantity,transitQuantity]);
    res.json({...rows[0],transit_quantity:transitQuantity,business_total_quantity:businessTotal.rows[0].quantity});
  } catch (error) { console.error("Unable to load inventory summary:", error.message); res.status(500).json({ message: "Unable to load inventory summary" }); }
}

export async function productStock(req, res) {
  const productId = req.params.productId;
  if (!idPattern.test(productId)) return res.status(400).json({ message: "Invalid product ID" });
  try {
    const storeId = await authorizeFilter(req, res); if (storeId === null && req.query.storeId) return;
    const values = [productId]; const storeClause = visibleStoreClause(req, storeId, values);
    const { rows } = await connection.query(`${inventorySelect} WHERE p.id=$1 AND ${storeClause} ORDER BY st.name`, values);
    if (!rows.length) return res.status(404).json({ message: "Product not found or no authorized store stock is available" });
    res.json(rows);
  } catch (error) { console.error("Unable to load product stock:", error.message); res.status(500).json({ message: "Unable to load product stock" }); }
}

export async function movementHistory(req, res) {
  try {
    const storeId = await authorizeFilter(req, res); if (storeId === null && req.query.storeId) return;
    const values = []; const storeClause = visibleStoreClause(req, storeId, values);
    if (req.query.productId) { if (!idPattern.test(String(req.query.productId))) return res.status(400).json({ message: "Invalid product ID" }); values.push(req.query.productId); }
    const productClause = req.query.productId ? `AND m.product_id=$${values.length}` : "";
    const limit = positiveInt(req.query.limit, 50, 200); const offset = positiveInt(req.query.offset, 1, 1000000)-1;
    values.push(limit,offset);
    const { rows } = await connection.query(`SELECT m.id,m.store_id,st.name AS store_name,m.product_id,p.sku,p.name AS product_name,
      m.movement_type,m.quantity_delta,u.code AS unit_code,m.source_type,m.source_id,m.source_line_id,m.reversal_of_id,m.created_by,
      usr.name AS created_by_name,m.created_at FROM stock_movements m JOIN stores st ON st.id=m.store_id
      JOIN products p ON p.id=m.product_id JOIN units_of_measure u ON u.id=p.base_unit_id LEFT JOIN users usr ON usr.id=m.created_by
      WHERE ${storeClause} ${productClause} ORDER BY m.created_at DESC,m.id DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    res.json({ items: rows, limit, offset });
  } catch (error) { console.error("Unable to load stock movements:", error.message); res.status(500).json({ message: "Unable to load stock movements" }); }
}

export async function lowStock(req, res) {
  try {
    const storeId = await authorizeFilter(req, res); if (storeId === null && req.query.storeId) return;
    const values = []; const storeClause = visibleStoreClause(req, storeId, values);
    const { rows } = await connection.query(`${inventorySelect} WHERE ${storeClause} AND p.is_active=TRUE AND p.reorder_threshold IS NOT NULL AND COALESCE(ib.quantity,0)<=p.reorder_threshold ORDER BY st.name,COALESCE(ib.quantity,0),p.name LIMIT 500`, values);
    res.json(rows);
  } catch (error) { console.error("Unable to load low stock products:", error.message); res.status(500).json({ message: "Unable to load low stock products" }); }
}

export async function valuation(req, res) {
  try {
    const storeId = await authorizeFilter(req, res); if (storeId === null && req.query.storeId) return;
    const values = []; const storeClause = visibleStoreClause(req, storeId, values);
    const { rows } = await connection.query(`${inventorySelect} WHERE ${storeClause} AND COALESCE(ib.quantity,0)<>0 AND p.is_active=TRUE ORDER BY st.name,p.name`, values);
    const totalResult = await connection.query(`SELECT COALESCE(SUM(ib.quantity*p.default_purchase_price/COALESCE(conv.factor_to_base,1)),0)::NUMERIC(18,2) AS valued_total
      FROM stores st CROSS JOIN products p JOIN units_of_measure u ON u.id=p.base_unit_id
      LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id
      LEFT JOIN product_unit_conversions conv ON conv.product_id=p.id AND conv.unit_id=p.purchase_unit_id
      WHERE ${storeClause} AND COALESCE(ib.quantity,0)<>0 AND p.is_active=TRUE AND p.default_purchase_price IS NOT NULL`, values);
    res.json({ items: rows, valuedTotal: totalResult.rows[0].valued_total, unvaluedCount: rows.filter(row=>row.stock_value===null).length });
  } catch (error) { console.error("Unable to load stock valuation:", error.message); res.status(500).json({ message: "Unable to load stock valuation" }); }
}

export async function reconciliation(req, res) {
  try {
    const storeId = await authorizeFilter(req, res); if (storeId === null && req.query.storeId) return;
    const values = []; const storeClause = visibleStoreClause(req, storeId, values);
    const { rows } = await connection.query(`WITH ledger AS (SELECT store_id,product_id,SUM(quantity_delta)::NUMERIC(18,4) AS ledger_quantity FROM stock_movements GROUP BY store_id,product_id)
      SELECT st.id AS store_id,st.name AS store_name,p.id AS product_id,p.sku,p.name AS product_name,
      COALESCE(ib.quantity,0)::NUMERIC(18,4) AS balance_quantity,COALESCE(l.ledger_quantity,0)::NUMERIC(18,4) AS ledger_quantity,
      (COALESCE(ib.quantity,0)-COALESCE(l.ledger_quantity,0))::NUMERIC(18,4) AS difference
      FROM stores st CROSS JOIN products p LEFT JOIN inventory_balances ib ON ib.store_id=st.id AND ib.product_id=p.id
      LEFT JOIN ledger l ON l.store_id=st.id AND l.product_id=p.id WHERE ${storeClause}
      AND (COALESCE(ib.quantity,0)<>COALESCE(l.ledger_quantity,0)) ORDER BY st.name,p.name LIMIT 1000`, values);
    const transitValues=[];const transitWhere=transferScope(req,storeId,transitValues);
    const transit=await connection.query(`WITH expected AS (
        SELECT i.id AS transfer_item_id,i.product_id,CASE WHEN t.status='dispatched' THEN i.dispatched_base_quantity ELSE 0 END-COALESCE(ri.received_base_quantity+ri.damaged_base_quantity+ri.shortage_base_quantity,0) AS expected_quantity
        FROM stock_transfer_items i JOIN stock_transfers t ON t.id=i.transfer_id LEFT JOIN stock_transfer_receipts r ON r.transfer_id=t.id LEFT JOIN stock_transfer_receipt_items ri ON ri.receipt_id=r.id AND ri.transfer_item_id=i.id WHERE ${transitWhere}
      ), actual AS (SELECT m.transfer_item_id,m.product_id,SUM(m.quantity_delta)::NUMERIC(18,4) AS ledger_quantity FROM stock_transfer_transit_movements m JOIN stock_transfers t ON t.id=m.transfer_id WHERE ${transitWhere} GROUP BY m.transfer_item_id,m.product_id)
      SELECT COALESCE(e.transfer_item_id,a.transfer_item_id) AS transfer_item_id,COALESCE(e.product_id,a.product_id) AS product_id,p.sku,p.name AS product_name,
        COALESCE(e.expected_quantity,0)::NUMERIC(18,4) AS expected_quantity,COALESCE(a.ledger_quantity,0)::NUMERIC(18,4) AS ledger_quantity,
        (COALESCE(e.expected_quantity,0)-COALESCE(a.ledger_quantity,0))::NUMERIC(18,4) AS difference
      FROM expected e FULL JOIN actual a USING(transfer_item_id,product_id) JOIN products p ON p.id=COALESCE(e.product_id,a.product_id)
      WHERE COALESCE(e.expected_quantity,0)<>COALESCE(a.ledger_quantity,0) ORDER BY p.name LIMIT 1000`,transitValues);
    res.json({ reconciled: rows.length===0&&transit.rows.length===0, discrepancyCount: rows.length+transit.rows.length, discrepancies: rows, transitReconciled: transit.rows.length===0, transitDiscrepancies: transit.rows });
  } catch (error) { console.error("Unable to reconcile inventory:", error.message); res.status(500).json({ message: "Unable to reconcile inventory" }); }
}

export async function createAdjustment(req, res) {
  const { storeId, reason, items, idempotencyKey } = req.body ?? {};
  if (!idPattern.test(String(storeId ?? ""))) return res.status(400).json({ message: "A valid store is required" });
  if (!(await canAccessStore(req.user, storeId))) return res.status(403).json({ message: "You do not have access to this store" });
  if (!admin(req)) {
    const { rows } = await connection.query("SELECT role FROM user_store_assignments WHERE user_id=$1 AND store_id=$2 AND is_active=TRUE", [req.user.id,storeId]);
    if (!rows.length || !["manager","inventory","owner"].includes(rows[0].role)) return res.status(403).json({ message: "An inventory manager or administrator must post stock adjustments" });
  }
  if (typeof reason !== "string" || reason.trim().length<3 || reason.trim().length>1000) return res.status(400).json({ message: "Adjustment reason is required (3 to 1000 characters)" });
  if (!Array.isArray(items) || items.length<1 || items.length>200) return res.status(400).json({ message: "Provide between 1 and 200 adjustment lines" });
  if (typeof idempotencyKey !== "string" || idempotencyKey.length<8 || idempotencyKey.length>120) return res.status(400).json({ message: "A valid idempotency key is required" });
  for (const item of items) {
    if (!idPattern.test(String(item.productId??"")) || !idPattern.test(String(item.unitId??"")) || !["increase","decrease"].includes(item.direction) || !/^\d{1,14}(\.\d{1,4})?$/.test(String(item.quantity)) || Number(item.quantity)<=0) return res.status(400).json({ message: "Each line requires a product, unit, positive decimal quantity, and direction" });
  }
  const client=await connection.connect();
  try {
    await client.query("BEGIN");
    const prior=await client.query("SELECT id,status,store_id,reason,created_at,posted_at FROM stock_adjustments WHERE idempotency_key=$1",[idempotencyKey]);
    if(prior.rowCount){ await client.query("COMMIT"); return res.status(200).json({...prior.rows[0],adjustmentNumber:`ADJ-${prior.rows[0].id}`,duplicate:true}); }
    const store=await client.query("SELECT id FROM stores WHERE id=$1 AND is_active=TRUE FOR SHARE",[storeId]);
    if(!store.rowCount){await client.query("ROLLBACK");return res.status(404).json({message:"Active store not found"});}
    const inserted=await client.query(`INSERT INTO stock_adjustments(store_id,reason,idempotency_key,created_by) VALUES($1,$2,$3,$4) RETURNING id`,[storeId,reason.trim(),idempotencyKey,req.user.id]);
    const adjustmentId=inserted.rows[0].id;
    for(let index=0;index<items.length;index++){
      const item=items[index];
      await client.query(`INSERT INTO stock_adjustment_items(adjustment_id,line_number,product_id,unit_id,quantity,direction)
        VALUES($1,$2,$3,$4,$5,$6)`,[adjustmentId,index+1,item.productId,item.unitId,item.quantity,item.direction]);
    }
    const posted=await client.query("UPDATE stock_adjustments SET status='posted',posted_at=now(),updated_at=now() WHERE id=$1 RETURNING id,store_id,status,reason,created_by,adjustment_date,posted_at,created_at",[adjustmentId]);
    await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'inventory.adjustment.posted','stock_adjustment',$3,$4)",[storeId,req.user.id,adjustmentId,{reason:reason.trim(),items}]);
    await client.query("COMMIT");
    return res.status(201).json({...posted.rows[0],adjustmentNumber:`ADJ-${adjustmentId}`});
  } catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    if(error.code==="23505") return res.status(409).json({message:"This adjustment request was already processed"});
    if(error.code==="23514"||error.code==="23503") return res.status(400).json({message:error.message});
    console.error("Unable to post stock adjustment:",error.message); return res.status(500).json({message:"Unable to post stock adjustment"});
  } finally { client.release(); }
}
