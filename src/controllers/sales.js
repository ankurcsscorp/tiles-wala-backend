import {hasPermission} from '../services/permissions.js';
import {INVOICE_LAYOUTS,DOCUMENT_TYPES,resolveSalesDocumentType} from "../services/invoicePolicy.js";
import { readInvoiceSettings } from "./invoiceSettings.js";
import { randomUUID } from "node:crypto";
import { connection } from "../../connection.js";
import { canAccessStore, canManageStore } from "./stores.js";
import { processSalesInvoiceBonus, quoteSalesInvoiceBonus, reverseInvoiceBonus } from "./salesBonusIntegration.js";

const isAdmin=(req)=>req.user?.userType?.toLowerCase()==="admin";
const idOk=(v)=>/^\d+$/.test(String(v??""));
const decimal=(v,label,{scale=4,signed=false}={})=>{
  const pattern=signed?new RegExp(`^-?\\d{1,14}(\\.\\d{1,${scale}})?$`):new RegExp(`^\\d{1,14}(\\.\\d{1,${scale}})?$`);
  return pattern.test(String(v??""))?String(v):`${label} must be a valid decimal with up to ${scale} places`;
};
const headerSelect=`si.*,st.code AS store_code,st.name AS current_store_name,c.name AS current_customer_name,ref.mobile AS referred_by_mobile,ref.user_type AS referred_by_user_type,
  COALESCE(pay.paid,0)::numeric(18,2) AS amount_received,
  COALESCE(ret.credited,0)::numeric(18,2) AS return_credit,
  GREATEST(si.total-COALESCE(pay.paid,0)-COALESCE(ret.credited,0),0)::numeric(18,2) AS outstanding_balance,
  CASE WHEN si.status<>'posted' THEN 'unposted' WHEN COALESCE(pay.paid,0)+COALESCE(ret.credited,0)>=si.total THEN 'paid' WHEN COALESCE(pay.paid,0)+COALESCE(ret.credited,0)>0 THEN 'partially_paid' ELSE 'unpaid' END AS payment_status
  FROM sales_invoices si JOIN stores st ON st.id=si.store_id LEFT JOIN customers c ON c.id=si.customer_id LEFT JOIN users ref ON ref.id=si.referred_by_user_id
  LEFT JOIN LATERAL(SELECT SUM(pa.amount) AS paid FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' WHERE pa.sales_invoice_id=si.id AND pa.direction='in') pay ON TRUE
  LEFT JOIN LATERAL(SELECT SUM(sr.customer_credit) AS credited FROM sales_invoice_return_credits sr WHERE sr.sales_invoice_id=si.id AND sr.status='posted') ret ON TRUE`;
const headerFrom=headerSelect.slice(headerSelect.indexOf("FROM "));

function validate(body={}){
  if(body.documentType!==undefined&&!DOCUMENT_TYPES.includes(body.documentType))return {error:'Invalid tax document type',code:'INVALID_DOCUMENT_TYPE',field:'documentType'};
  if(body.invoiceLayout!==undefined&&!INVOICE_LAYOUTS.includes(body.invoiceLayout))return {error:'Invalid invoice layout'};
  if(String(body.placeOfSupply||'').length>100)return {error:'Place of supply is too long'};
  if(body.invoiceType!==undefined && !["GST","NON_GST"].includes(body.invoiceType))return {error:"Invalid invoice type"};
  if(!idOk(body.storeId))return {error:"Choose a valid store"};
  if(body.customerId&&!idOk(body.customerId))return {error:"Choose a valid customer"};
  if(body.referredByUserId&&!idOk(body.referredByUserId))return {error:"Choose a valid referral"};
  if(!Array.isArray(body.items)||body.items.length<1||body.items.length>100)return {error:"An invoice must contain between 1 and 100 item lines"};
  const date=body.invoiceDate||new Date().toISOString().slice(0,10),due=body.dueDate||null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||(due&&!/^\d{4}-\d{2}-\d{2}$/.test(due))||(due&&due<date))return {error:"Enter valid invoice and due dates"};
  const invDisc=decimal(body.invoiceDiscount??0,"Invoice discount",{scale:2}),charges=decimal(body.additionalCharges??0,"Additional charges",{scale:2}),roundOff=decimal(body.roundOff??0,"Round-off",{scale:2,signed:true});
  if([invDisc,charges,roundOff].some(x=>x.includes(" must be a valid ")))return {error:[invDisc,charges,roundOff].find(x=>x.includes(" must be a valid "))};
  if(String(body.notes||"").length>10000)return {error:"Notes are too long"};
  const items=[];
  for(let i=0;i<body.items.length;i++){
    const x=body.items[i]||{};if(!idOk(x.productId)||!idOk(x.unitId))return {error:`Line ${i+1}: choose a product and unit`};
    const quantity=decimal(x.quantity,"Quantity"),price=decimal(x.unitPrice,"Selling price"),discount=decimal(x.discountAmount??0,"Discount",{scale:2});
    const taxRate=x.taxRate===null||x.taxRate===undefined||x.taxRate===""?null:decimal(x.taxRate,"Tax rate");
    if([quantity,price,discount,taxRate].some(v=>v?.includes(" must be a valid ")))return {error:`Line ${i+1}: invalid quantity, price, discount, or tax rate`};
    if(Number(quantity)<=0||(taxRate!==null&&Number(taxRate)>100))return {error:`Line ${i+1}: quantity must be positive and tax rate must be at most 100%`};
    items.push({productId:String(x.productId),unitId:String(x.unitId),quantity,unitPrice:price,discountAmount:discount,taxRate});
  }
  return {data:{placeOfSupply:String(body.placeOfSupply||'').trim()||null,storeId:String(body.storeId),customerId:body.customerId?String(body.customerId):null,referredByUserId:body.referredByUserId?String(body.referredByUserId):null,date,due,invoiceDiscount:invDisc,additionalCharges:charges,roundOff,notes:String(body.notes||"").trim()||null,items}};
}
async function permitted(req,res,storeId){if(!await canAccessStore(req.user,storeId)){res.status(403).json({message:"You do not have access to this store"});return false;}return true;}
async function loadInvoice(id,db=connection){
  const h=await db.query(`SELECT ${headerSelect} WHERE si.id=$1`,[id]);if(!h.rowCount)return null;
  const items=await db.query(`SELECT id,line_number,product_id,product_sku_snapshot AS sku,product_name_snapshot AS product_name,product_snapshot,description,unit_id,unit_code_snapshot AS unit_code,unit_name_snapshot AS unit_name,quantity,unit_price,discount_amount,invoice_discount_amount,tax_rate,taxable_value,tax_amount,cgst_amount,sgst_amount,igst_amount,line_total FROM sales_invoice_items WHERE sales_invoice_id=$1 ORDER BY line_number`,[id]);
  const payments=await db.query(`SELECT p.id,p.payment_number,p.payment_date,p.payment_method,p.amount,pa.amount AS allocated_amount,p.reference,p.notes FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.sales_invoice_id=$1 AND pa.direction='in' AND p.status='posted' ORDER BY p.payment_date,p.id`,[id]);
  return {...h.rows[0],items:items.rows,payments:payments.rows};
}
async function checkDocument(client,data){
  const settings=await readInvoiceSettings(client,data.storeId,true);
  if(!settings)throw Object.assign(new Error('Active store not found'),{status:404});
  resolveSalesDocumentType({store:settings,requestedDocumentType:data.documentType,supplyDetails:{placeOfSupply:data.placeOfSupply}});
  return settings;
}
async function saveItems(client,id,data){
  if(data.documentType)data.settings=await checkDocument(client,data);
  const noTax=data.invoiceType==='NON_GST'||data.documentType==='BILL_OF_SUPPLY';
  if(data.invoiceLayout==='SIMPLE_LAYOUT'&&[data.invoiceDiscount,data.additionalCharges,data.roundOff,...data.items.map(x=>x.discountAmount)].some(x=>Number(x)!==0))throw Object.assign(new Error('Simple Layout requires quantity × rate without discounts or adjustments'),{status:400});
  if(noTax) {
    if([data.invoiceDiscount,data.additionalCharges,data.roundOff,...data.items.map(x=>x.discountAmount)].some(x=>Number(x)!==0) || data.items.some(x=>x.taxRate!==null && Number(x.taxRate)!==0))
      throw Object.assign(new Error("Non-GST invoices cannot contain tax, discounts, charges, or round-off"),{status:400});
    data.items=data.items.map(x=>({...x,taxRate:"0"}));
  }
  await client.query("DELETE FROM sales_invoice_items WHERE sales_invoice_id=$1",[id]);
  for(let i=0;i<data.items.length;i++){
    const x=data.items[i];
    const found=await client.query(`SELECT p.id,p.sku,p.name,p.brand,p.collection,p.tile_size,p.finish,p.color,p.hsn_code,p.tax_rate,p.gst_supply_classification,p.gst_classification_reference,p.base_unit_id,p.category_id,
      u.code AS unit_code,u.name AS unit_name,CASE WHEN p.base_unit_id=$2 THEN 1::numeric ELSE conv.factor_to_base END AS factor,
      (p.base_unit_id=$2 OR conv.factor_to_base IS NOT NULL) AS valid_unit
      FROM products p JOIN units_of_measure u ON u.id=$2 LEFT JOIN product_unit_conversions conv ON conv.product_id=p.id AND conv.unit_id=$2
      WHERE p.id=$1 AND p.is_active=TRUE FOR SHARE OF p`,[x.productId,x.unitId]);
    if(!found.rowCount)throw Object.assign(new Error(`Line ${i+1}: product or unit not found`),{status:400});
    const p=found.rows[0];if(!p.valid_unit)throw Object.assign(new Error(`Line ${i+1}: no conversion is configured for this unit`),{status:400});
    if(data.documentType)resolveSalesDocumentType({store:data.settings,requestedDocumentType:data.documentType,products:[{...p,lineIndex:i}],supplyDetails:{placeOfSupply:data.placeOfSupply}});
    // All new GST documents use catalog rates; request-supplied tax rates are not authoritative.
    if(data.documentType==='GST_TAX_INVOICE')x.taxRate=p.tax_rate;
    const rate=x.taxRate===null||x.taxRate===undefined||x.taxRate===""?p.tax_rate:x.taxRate;if(rate===null||rate===undefined||rate==="")throw Object.assign(new Error(`Line ${i+1}: choose an explicit tax rate`),{status:400});
    await client.query(`INSERT INTO sales_invoice_items(sales_invoice_id,line_number,product_id,description,unit_id,quantity,unit_price,discount_amount,tax_rate,taxable_value,tax_amount,line_total,
      product_sku_snapshot,product_name_snapshot,product_snapshot,unit_code_snapshot,unit_name_snapshot,conversion_factor_to_base)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,round($6::numeric*$7::numeric,2)-$8::numeric,
      round((round($6::numeric*$7::numeric,2)-$8::numeric)*$9::numeric/100,2),
      round($6::numeric*$7::numeric,2)-$8::numeric+round((round($6::numeric*$7::numeric,2)-$8::numeric)*$9::numeric/100,2),$10,$11,$12,$13,$14,$15)`,
      [id,i+1,p.id,p.name,x.unitId,x.quantity,x.unitPrice,x.discountAmount,rate,p.sku,p.name,{brand:p.brand,collection:p.collection,tileSize:p.tile_size,finish:p.finish,color:p.color,hsnCode:p.hsn_code,categoryId:p.category_id,supplyClassification:p.gst_supply_classification,classificationReference:p.gst_classification_reference},p.unit_code,p.unit_name,p.factor]);
  }
  const grossCheck=await client.query("SELECT COALESCE(sum(GREATEST(round(quantity*unit_price,2)-discount_amount,0)),0) AS taxable FROM sales_invoice_items WHERE sales_invoice_id=$1",[id]);
  const discountCheck=await client.query("SELECT $1::numeric <= $2::numeric AS valid",[data.invoiceDiscount,grossCheck.rows[0].taxable]);
  if(!discountCheck.rows[0].valid)throw Object.assign(new Error("Invoice discount cannot exceed the taxable amount"),{status:400});
  // Allocate the invoice discount proportionally using PostgreSQL NUMERIC. Any cent remainder is assigned to the final line.
  await client.query(`WITH base AS (SELECT id,line_number,GREATEST(round(quantity*unit_price,2)-discount_amount,0)::numeric(18,2) taxable FROM sales_invoice_items WHERE sales_invoice_id=$1),
    totals AS (SELECT sum(taxable) total,max(line_number) last_line FROM base),alloc AS (
      SELECT b.id,CASE WHEN b.line_number=t.last_line THEN $2::numeric-COALESCE(sum(round($2::numeric*b.taxable/NULLIF(t.total,0),2)) OVER(ORDER BY b.line_number ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
        ELSE round($2::numeric*b.taxable/NULLIF(t.total,0),2) END disc
      FROM base b CROSS JOIN totals t)
    UPDATE sales_invoice_items li SET invoice_discount_amount=CASE WHEN t.total=0 THEN 0 ELSE a.disc END,
      taxable_value=GREATEST(b.taxable-CASE WHEN t.total=0 THEN 0 ELSE a.disc END,0),
      tax_amount=round(GREATEST(b.taxable-CASE WHEN t.total=0 THEN 0 ELSE a.disc END,0)*li.tax_rate/100,2)
    FROM base b JOIN alloc a ON a.id=b.id CROSS JOIN totals t WHERE li.id=b.id`,[id,data.invoiceDiscount]);
  const jurisdiction=await client.query(`SELECT CASE WHEN $2::bigint IS NULL THEN 'intra_state'
    WHEN c.tax_id IS NOT NULL AND s.gstin IS NOT NULL THEN CASE WHEN left(c.tax_id,2)=left(s.gstin,2) THEN 'intra_state' ELSE 'inter_state' END
    WHEN c.state IS NOT NULL AND s.state IS NOT NULL THEN CASE WHEN lower(trim(c.state))=lower(trim(s.state)) THEN 'intra_state' ELSE 'inter_state' END ELSE 'intra_state' END AS j
    FROM stores s LEFT JOIN customers c ON c.id=$2 WHERE s.id=$1`,[data.storeId,data.customerId]);
  const j=jurisdiction.rows[0]?.j||"intra_state";
  await client.query(`UPDATE sales_invoice_items SET cgst_amount=CASE WHEN $2='intra_state' THEN round(tax_amount/2,2) ELSE 0 END,
    sgst_amount=CASE WHEN $2='intra_state' THEN tax_amount-round(tax_amount/2,2) ELSE 0 END,
    igst_amount=CASE WHEN $2='inter_state' THEN tax_amount ELSE 0 END WHERE sales_invoice_id=$1`,[id,j]);
  await client.query(`UPDATE sales_invoice_items SET line_total=taxable_value+tax_amount WHERE sales_invoice_id=$1`,[id]);
  await client.query(`UPDATE sales_invoices si SET invoice_discount=$2,additional_charges=$3,round_off=$4,tax_jurisdiction_snapshot=$5,
    subtotal=t.subtotal,discount_total=t.discount_total,taxable_total=t.taxable,tax_total=t.tax,cgst_total=t.cgst,sgst_total=t.sgst,igst_total=t.igst,
    total=t.taxable+t.tax+$3::numeric+$4::numeric,updated_at=now()
    FROM (SELECT COALESCE(sum(round(quantity*unit_price,2)),0)::numeric(18,2) subtotal,
      COALESCE(sum(discount_amount+invoice_discount_amount),0)::numeric(18,2) discount_total,COALESCE(sum(taxable_value),0)::numeric(18,2) taxable,
      COALESCE(sum(tax_amount),0)::numeric(18,2) tax,COALESCE(sum(cgst_amount),0)::numeric(18,2) cgst,COALESCE(sum(sgst_amount),0)::numeric(18,2) sgst,
      COALESCE(sum(igst_amount),0)::numeric(18,2) igst FROM sales_invoice_items WHERE sales_invoice_id=$1) t WHERE si.id=$1`,[id,data.invoiceDiscount,data.additionalCharges,data.roundOff,j]);
}
function dbError(res,e,label){if(e.status)return res.status(e.status).json({message:e.message,...Object.fromEntries(["code","field","productId","lineNumber","invoiceTotal"].filter(key=>e[key]!==undefined).map(key=>[key,e[key]]))});if(["23503","23514","22007","22P02"].includes(e.code))return res.status(400).json({message:e.message});if(e.code==="23505")return res.status(409).json({message:"Duplicate invoice or payment reference"});if(e.code==="TW001")return res.status(409).json({message:e.message});console.error(label,e.message);return res.status(500).json({message:label});}

export async function createSalesDraft(req,res){
  const v=validate(req.body);if(v.error)return res.status(400).json({message:v.error,...(v.code?{code:v.code,field:v.field}:{})});const d=v.data;if(!await permitted(req,res,d.storeId))return;
  const c=await connection.connect();try{await c.query("BEGIN");const st=await c.query(`SELECT s.id,s.code,COALESCE(bc.invoice_prefix,s.code) AS invoice_prefix FROM stores s
    LEFT JOIN store_billing_config bc ON bc.store_id=s.id WHERE s.id=$1 AND s.is_active=TRUE FOR SHARE OF s`,[d.storeId]);if(!st.rowCount)throw Object.assign(new Error("Active store not found"),{status:404});
    if(d.customerId){const x=await c.query("SELECT id FROM customers WHERE id=$1 AND is_active=TRUE",[d.customerId]);if(!x.rowCount)throw Object.assign(new Error("Active customer not found"),{status:400});}
    if(d.referredByUserId){const x=await c.query("SELECT id,name FROM users WHERE id=$1 AND is_active=TRUE AND user_type IN ('Salesperson','Tile Mistire')",[d.referredByUserId]);if(!x.rowCount)throw Object.assign(new Error("Choose an active salesperson or tile mistiri"),{status:400});d.referredByName=x.rows[0].name;}
    const settings=await readInvoiceSettings(c,d.storeId,true);
    d.documentType=req.body.documentType||settings.default_document_type;
    d.invoiceLayout=settings.invoice_layout;
    if(req.body.invoiceLayout&&req.body.invoiceLayout!==d.invoiceLayout)throw Object.assign(new Error('Store appearance changed. Reopen the invoice editor.'),{status:409});
    d.invoiceType=d.documentType==='GST_TAX_INVOICE'?'GST':d.documentType==='NON_GST_COMMERCIAL'?'NON_GST':null;
    d.settings=await checkDocument(c,d);
    if(req.body.invoiceType && req.body.invoiceType!==d.invoiceType)throw Object.assign(new Error("Store invoice settings changed. Start a new invoice to load the current default."),{status:409});

    const series=(st.rows[0].invoice_prefix||st.rows[0].code||"SALE").toUpperCase();const assignedSalesperson=req.user.userType?.toLowerCase()==="salesperson"?req.user.id:null;const h=await c.query(`INSERT INTO sales_invoices(store_id,customer_id,series,invoice_number,status,invoice_date,due_date,notes,created_by,salesperson_user_id,referred_by_user_id,referred_by_name_snapshot,invoice_type,invoice_layout,document_type,registration_category_snapshot,place_of_supply_state)
      VALUES($1,$2,$3,NULL,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[d.storeId,d.customerId,series,d.date,d.due,d.notes,req.user.id,assignedSalesperson,d.referredByUserId,d.referredByName||null,d.invoiceType,d.invoiceLayout,d.documentType,d.settings.gst_registration_category,d.placeOfSupply]);
    await saveItems(c,h.rows[0].id,d);const invoice=await loadInvoice(h.rows[0].id,c);await c.query("COMMIT");return res.status(201).json(invoice);
  }catch(e){await c.query("ROLLBACK").catch(()=>{});return dbError(res,e,"Unable to create sales draft");}finally{c.release();}
}
export async function listSales(req,res){
  try{let stores;if(isAdmin(req)){const r=await connection.query("SELECT id FROM stores WHERE is_active=TRUE");stores=r.rows.map(x=>String(x.id));}else{const r=await connection.query("SELECT store_id AS id FROM user_store_assignments WHERE user_id=$1 AND is_active=TRUE",[req.user.id]);stores=r.rows.map(x=>String(x.id));}
    if(req.query.storeId&&(!idOk(req.query.storeId)||!stores.includes(String(req.query.storeId))))return res.status(403).json({message:"You do not have access to this store"});if(!stores.length)return res.json({items:[],pagination:{limit:50,offset:0,total:0}});
    const p=[stores];const w=["si.store_id=ANY($1::bigint[])"];if(req.query.storeId){p.push(req.query.storeId);w.push(`si.store_id=$${p.length}`);}if(req.query.status){p.push(req.query.status);w.push(`si.status=$${p.length}`);}const q=String(req.query.q||"").trim();if(q){p.push(`%${q.slice(0,80)}%`);w.push(`(si.invoice_number ILIKE $${p.length} OR c.name ILIKE $${p.length} OR c.phone ILIKE $${p.length})`);}
    const limit=Math.min(Math.max(Number.parseInt(req.query.limit)||50,1),200),offset=Math.max(Number.parseInt(req.query.offset)||0,0);const count=await connection.query(`SELECT count(*)::int total ${headerFrom} WHERE ${w.join(" AND ")}`,p);
    const rows=await connection.query(`SELECT ${headerSelect} WHERE ${w.join(" AND ")} ORDER BY si.invoice_date DESC,si.id DESC LIMIT $${p.length+1} OFFSET $${p.length+2}`,[...p,limit,offset]);return res.json({items:rows.rows,pagination:{limit,offset,total:count.rows[0].total}});
  }catch(e){return dbError(res,e,"Unable to list sales invoices");}
}
export async function getSales(req,res){if(!idOk(req.params.id))return res.status(400).json({message:"Invalid invoice ID"});try{const x=await loadInvoice(req.params.id);if(!x)return res.status(404).json({message:"Invoice not found"});if(!await permitted(req,res,x.store_id))return;return res.json(x);}catch(e){return dbError(res,e,"Unable to load invoice");}}
export async function salesBonusPreview(req,res){
  const storeId=String(req.body?.storeId||''),referralId=req.body?.referredByUserId;
  if(!idOk(storeId)||!Array.isArray(req.body?.items)||req.body.items.length>100)return res.status(400).json({message:'Choose a store and provide valid invoice lines'});
  if(!await permitted(req,res,storeId))return;
  const discount=decimal(req.body.invoiceDiscount??'0','Invoice discount',{scale:2});if(discount.includes(' must be a valid '))return res.status(400).json({message:discount});
  if(referralId&&!idOk(referralId))return res.status(400).json({message:'Choose a valid referral'});
  const items=[];for(const [index,line] of req.body.items.entries()){
    if(!idOk(line.productId)||!idOk(line.unitId))return res.status(400).json({message:`Line ${index+1}: choose a valid product and unit`});
    const quantity=decimal(line.quantity,'Quantity'),unitPrice=decimal(line.unitPrice,'Selling price',{scale:4}),discountAmount=decimal(line.discountAmount??'0','Discount',{scale:2});
    if([quantity,unitPrice,discountAmount].some(value=>value.includes(' must be a valid '))||Number(quantity)<=0)return res.status(400).json({message:`Line ${index+1}: enter a valid quantity, selling price, and discount`});
    items.push({productId:String(line.productId),unitId:String(line.unitId),quantity,unitPrice,discountAmount});
  }
  try{const quote=await quoteSalesInvoiceBonus(connection,{referredByUserId:referralId,items,invoiceDiscount:Number(discount)});const showFinancials=hasPermission(req.user,'bonus_cost.view');return res.json({...quote,items:quote.items.map(item=>showFinancials?item:{productName:item.productName,quantity:item.quantity,sellingPrice:item.sellingPrice,bonusRate:item.bonusRate,bonus:item.bonus}),totals:quote.totals?(showFinancials?quote.totals:{userBonus:quote.totals.userBonus}):null});}
  catch(e){console.error('Unable to calculate sales bonus preview:',e.message);return res.status(500).json({message:'Unable to calculate sales bonus preview'});}
}
export async function updateSalesDraft(req,res){
  const v=validate(req.body);if(v.error)return res.status(400).json({message:v.error,...(v.code?{code:v.code,field:v.field}:{})});const d=v.data;const c=await connection.connect();try{await c.query("BEGIN");const r=await c.query("SELECT store_id,status,invoice_type,invoice_layout,document_type,place_of_supply_state FROM sales_invoices WHERE id=$1 FOR UPDATE",[req.params.id]);if(!r.rowCount)throw Object.assign(new Error("Invoice not found"),{status:404});if(!await permitted(req,res,r.rows[0].store_id)){await c.query("ROLLBACK");return;}if(r.rows[0].status!=="draft")throw Object.assign(new Error("Only draft invoices can be edited"),{status:409});if(String(r.rows[0].store_id)!==d.storeId)throw Object.assign(new Error("The store cannot be changed"),{status:400});
  d.invoiceType=r.rows[0].invoice_type;d.documentType=r.rows[0].document_type;d.invoiceLayout=r.rows[0].invoice_layout;
  if(req.body.documentType&&req.body.documentType!==d.documentType || req.body.invoiceLayout&&req.body.invoiceLayout!==d.invoiceLayout)throw Object.assign(new Error('Invoice document type and appearance cannot be converted; create a replacement draft'),{status:409});
  if(req.body.invoiceType && req.body.invoiceType!==d.invoiceType)throw Object.assign(new Error("Invoice type cannot be converted; create a new draft"),{status:409});
  if(d.referredByUserId){const x=await c.query("SELECT id,name FROM users WHERE id=$1 AND is_active=TRUE AND user_type IN ('Salesperson','Tile Mistire')",[d.referredByUserId]);if(!x.rowCount)throw Object.assign(new Error("Choose an active salesperson or tile mistiri"),{status:400});d.referredByName=x.rows[0].name;}
  await c.query("UPDATE sales_invoices SET customer_id=$2,referred_by_user_id=$3,referred_by_name_snapshot=$4,invoice_date=$5,due_date=$6,notes=$7,place_of_supply_state=$8 WHERE id=$1",[req.params.id,d.customerId,d.referredByUserId,d.referredByName||null,d.date,d.due,d.notes,d.placeOfSupply]);await saveItems(c,req.params.id,d);await c.query("COMMIT");return res.json(await loadInvoice(req.params.id));
  }catch(e){await c.query("ROLLBACK").catch(()=>{});return dbError(res,e,"Unable to update sales draft");}finally{c.release();}
}
async function validateInitialPayment(client,payment,amount,method,total){
  const invalid=message=>Object.assign(new Error(message),{status:400,code:'INVALID_PAYMENT_AMOUNT',field:'payment.amount',invoiceTotal:total});
  const exceeds=await client.query('SELECT $1::numeric>$2::numeric AS yes',[amount,total]);
  if(exceeds.rows[0].yes)throw invalid('Received amount cannot exceed the invoice total. Record customer advances through the separate receipts workflow.');
  if(Number(amount)===0)return;
  const key=String(payment?.idempotencyKey||'');
  if(key.length<8||key.length>120)throw Object.assign(new Error('A payment idempotency key is required'),{status:400,code:'INVALID_PAYMENT_KEY',field:'payment.idempotencyKey'});
  const configured=await client.query('SELECT 1 FROM payment_method_options WHERE code=$1 AND is_active=TRUE',[method]);
  if(!configured.rowCount)throw Object.assign(new Error('Payment method is not configured or active'),{status:400,code:'INVALID_PAYMENT_METHOD',field:'payment.method'});
}

export async function finalizeSales(req,res){
  const id=req.params.id;if(!idOk(id))return res.status(400).json({message:"Invalid invoice ID"});const amount=decimal(req.body?.payment?.amount??"0","Payment amount",{scale:2});if(amount.includes(" must be a valid "))return res.status(400).json({code:"INVALID_PAYMENT_AMOUNT",field:"payment.amount",message:amount});const method=req.body?.payment?.method||"cash";
  if(Number(amount)>0&&!hasPermission(req.user,'payments.manage'))return res.status(403).json({code:'PERMISSION_DENIED',message:'Payment management permission is required to receive payment. Finalize without an initial payment or ask your administrator.'});
  const c=await connection.connect();try{await c.query("BEGIN");const r=await c.query(`SELECT si.*,si.invoice_date::text AS invoice_date,s.invoice_numbering_period,s.invoice_number_padding,s.code FROM sales_invoices si JOIN stores s ON s.id=si.store_id WHERE si.id=$1 FOR UPDATE OF si`,[id]);if(!r.rowCount)throw Object.assign(new Error("Invoice not found"),{status:404});const inv=r.rows[0];if(!await permitted(req,res,inv.store_id)){await c.query("ROLLBACK");return;}if(inv.status!=="draft")throw Object.assign(new Error("Only a draft invoice can be finalized"),{status:409,code:"INVOICE_ALREADY_FINALIZED"});
    if(inv.customer_id){const customer=await c.query('SELECT id FROM customers WHERE id=$1 AND is_active=TRUE FOR SHARE',[inv.customer_id]);if(!customer.rowCount)throw Object.assign(new Error('Active customer not found'),{status:422,code:'INVALID_CUSTOMER',field:'customerId'});}
    if(inv.document_type){
      const settings=await checkDocument(c,{storeId:inv.store_id,documentType:inv.document_type,placeOfSupply:inv.place_of_supply_state});
      if(inv.document_type==='BILL_OF_SUPPLY'&&settings.gst_registration_category!==inv.registration_category_snapshot)throw Object.assign(new Error('Registration category changed since drafting. Create a replacement draft.'),{status:409,code:'DOCUMENT_NOT_ELIGIBLE',field:'documentType'});
      // Revalidate/recalculate from the saved draft and current authorized catalog, never request totals.
      const saved=await c.query('SELECT product_id,unit_id,quantity,unit_price,discount_amount,tax_rate FROM sales_invoice_items WHERE sales_invoice_id=$1 ORDER BY line_number',[id]);
      await saveItems(c,id,{storeId:inv.store_id,customerId:inv.customer_id,documentType:inv.document_type,invoiceType:inv.invoice_type,invoiceLayout:inv.invoice_layout,placeOfSupply:inv.place_of_supply_state,
        invoiceDiscount:inv.invoice_discount,additionalCharges:inv.additional_charges,roundOff:inv.round_off,
        items:saved.rows.map(x=>({productId:x.product_id,unitId:x.unit_id,quantity:x.quantity,unitPrice:x.unit_price,discountAmount:x.discount_amount,taxRate:x.tax_rate}))});
      inv.total=(await c.query('SELECT total FROM sales_invoices WHERE id=$1',[id])).rows[0].total;
    }else if(inv.invoice_type==="NON_GST") {
      const settings=await readInvoiceSettings(c,inv.store_id,true);
      if(!settings)throw Object.assign(new Error("Active store not found"),{status:404});
    }
    await validateInitialPayment(c,req.body?.payment,amount,method,inv.total);
    const lines=await c.query(`SELECT li.id,li.product_id,li.quantity,li.unit_id,CASE WHEN p.base_unit_id=li.unit_id THEN 1::numeric ELSE conv.factor_to_base END AS factor
      FROM sales_invoice_items li JOIN products p ON p.id=li.product_id LEFT JOIN product_unit_conversions conv ON conv.product_id=p.id AND conv.unit_id=li.unit_id
      WHERE li.sales_invoice_id=$1 ORDER BY li.product_id,li.id`,[id]);if(!lines.rowCount)throw Object.assign(new Error("Invoice requires at least one item"),{status:400});
    if(lines.rows.some(line=>line.factor===null))throw Object.assign(new Error("A product unit conversion is no longer configured. Update the draft before finalizing."),{status:409});
    for(const line of lines.rows)await c.query("UPDATE sales_invoice_items SET conversion_factor_to_base=$2 WHERE id=$1",[line.id,line.factor]);
    // Serialize competing sales and lock existing balance rows in stable order. The stock movement trigger remains the final no-oversell guard.
    const products=[...new Set(lines.rows.map(x=>String(x.product_id)))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);for(const pid of products)await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${inv.store_id}:${pid}`]);
    await c.query("SELECT product_id FROM inventory_balances WHERE store_id=$1 AND product_id=ANY($2::bigint[]) ORDER BY product_id FOR UPDATE",[inv.store_id,products]);
    const insufficient=await c.query(`WITH requested AS(SELECT product_id,sum(quantity*factor)::numeric(24,8) quantity FROM (
      SELECT li.product_id,li.quantity,CASE WHEN p.base_unit_id=li.unit_id THEN 1::numeric ELSE conv.factor_to_base END factor FROM sales_invoice_items li JOIN products p ON p.id=li.product_id
      LEFT JOIN product_unit_conversions conv ON conv.product_id=p.id AND conv.unit_id=li.unit_id WHERE li.sales_invoice_id=$1) q GROUP BY product_id)
      SELECT r.product_id FROM requested r LEFT JOIN inventory_balances b ON b.store_id=$2 AND b.product_id=r.product_id WHERE COALESCE(b.quantity,0)<r.quantity LIMIT 1`,[id,inv.store_id]);
    if(insufficient.rowCount)throw Object.assign(new Error(`Insufficient stock for product ${insufficient.rows[0].product_id}`),{status:409,code:"INSUFFICIENT_STOCK",productId:insufficient.rows[0].product_id,field:"items"});
    const date=String(inv.invoice_date).slice(0,10),period=inv.invoice_numbering_period==="monthly"?date.slice(0,7):inv.invoice_numbering_period==="never"?"all":date.slice(0,4),series=inv.series;
    await c.query("INSERT INTO invoice_number_sequences(store_id,document_type,series,period_key,next_number) VALUES($1,'sale',$2,$3,1) ON CONFLICT(store_id,document_type,series,period_key) DO NOTHING",[inv.store_id,series,period]);const seq=await c.query("SELECT next_number FROM invoice_number_sequences WHERE store_id=$1 AND document_type='sale' AND series=$2 AND period_key=$3 FOR UPDATE",[inv.store_id,series,period]);const no=seq.rows[0].next_number;await c.query("UPDATE invoice_number_sequences SET next_number=next_number+1 WHERE store_id=$1 AND document_type='sale' AND series=$2 AND period_key=$3",[inv.store_id,series,period]);const invoiceNo=`${series}-${period==='all'?'':`${period}-`}${String(no).padStart(inv.invoice_number_padding||5,"0")}`;
    await c.query("UPDATE sales_invoices SET invoice_number=$2,salesperson_name_snapshot=$3,status='posted',posted_at=now(),updated_at=now() WHERE id=$1",[id,invoiceNo,req.user.name]);
    if(Number(amount)>0){const key=String(req.body.payment.idempotencyKey);const pm=await c.query("INSERT INTO payments(store_id,payment_number,direction,status,payment_method,amount,payment_date,reference,notes,created_by,customer_id,customer_request_key) VALUES($1,$2,'in','posted',$3,$4,current_date,$5,$6,$7,$8,$9) RETURNING id",[inv.store_id,`RCPT-${randomUUID()}`,method,amount,String(req.body.payment.reference||"").slice(0,120)||null,String(req.body.payment.notes||"").slice(0,2000)||null,req.user.id,inv.customer_id,key]);await c.query("INSERT INTO payment_allocations(payment_id,store_id,direction,sales_invoice_id,amount) VALUES($1,$2,'in',$3,$4)",[pm.rows[0].id,inv.store_id,id,amount]);}
    await processSalesInvoiceBonus(c,id,req.user.id);
    await c.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id) VALUES($1,$2,'sales.invoice.finalized','sales_invoice',$3)",[inv.store_id,req.user.id,id]);const invoice=await loadInvoice(id,c);await c.query("COMMIT");return res.json(invoice);
  }catch(e){await c.query("ROLLBACK").catch(()=>{});return dbError(res,e,"Unable to finalize invoice");}finally{c.release();}
}
async function updateSalesStatus(req,res,status){if(!idOk(req.params.id))return res.status(400).json({message:"Invalid invoice ID"});const c=await connection.connect();try{await c.query("BEGIN");const r=await c.query("SELECT * FROM sales_invoices WHERE id=$1 FOR UPDATE",[req.params.id]);if(!r.rowCount)throw Object.assign(new Error("Invoice not found"),{status:404});const inv=r.rows[0];if(!await permitted(req,res,inv.store_id)){await c.query("ROLLBACK");return;}if(status==="cancelled"&&inv.status!=="draft")throw Object.assign(new Error("Only drafts can be cancelled"),{status:409});if(status==="reversed"){if(!await canManageStore(req.user,inv.store_id,["owner","manager"],c)){await c.query("ROLLBACK");return res.status(403).json({message:"Manager authorization is required to reverse a posted sales invoice"});}if(inv.status!=="posted")throw Object.assign(new Error("Only posted invoices can be reversed"),{status:409});const dep=await c.query("SELECT EXISTS(SELECT 1 FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.sales_invoice_id=$1 AND p.status='posted') AS paid,(EXISTS(SELECT 1 FROM sales_returns WHERE sales_invoice_id=$1 AND status='posted') OR EXISTS(SELECT 1 FROM sales_return_items ri JOIN sales_returns r ON r.id=ri.sales_return_id JOIN sales_invoice_items si ON si.id=ri.sales_invoice_item_id WHERE si.sales_invoice_id=$1 AND r.status='posted') OR EXISTS(SELECT 1 FROM sales_invoice_return_credits WHERE sales_invoice_id=$1 AND status='posted')) AS returned",[inv.id]);if(dep.rows[0].paid||dep.rows[0].returned)throw Object.assign(new Error("Reverse related payments and returns before reversing this invoice"),{status:409});}
  await c.query("UPDATE sales_invoices SET status=$2,updated_at=now() WHERE id=$1",[inv.id,status]);if(status==="reversed")await reverseInvoiceBonus(c,inv.id,req.user.id,inv.store_id);await c.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,'sales_invoice',$4)",[inv.store_id,req.user.id,`sales.invoice.${status}`,inv.id]);await c.query("COMMIT");return res.json(await loadInvoice(inv.id));
  }catch(e){await c.query("ROLLBACK").catch(()=>{});return dbError(res,e,"Unable to change invoice status");}finally{c.release();}}
export const cancelSales=(req,res)=>updateSalesStatus(req,res,"cancelled");
export const reverseSales=(req,res)=>updateSalesStatus(req,res,"reversed");
export async function recordSalesPayment(req,res){
  const id=req.params.id,amount=decimal(req.body?.amount,"Payment amount",{scale:2}),key=String(req.body?.idempotencyKey||"");if(amount.includes(" must be a valid ")||Number(amount)<=0)return res.status(400).json({message:"Enter a valid positive payment amount"});if(key.length<8||key.length>120)return res.status(400).json({message:"A payment idempotency key is required"});
  const c=await connection.connect();try{await c.query("BEGIN");const r=await c.query("SELECT * FROM sales_invoices WHERE id=$1 FOR UPDATE",[id]);if(!r.rowCount)throw Object.assign(new Error("Invoice not found"),{status:404});const inv=r.rows[0];if(!await permitted(req,res,inv.store_id)){await c.query("ROLLBACK");return;}const prior=await c.query("SELECT id,store_id,customer_id,amount,payment_method,status FROM payments WHERE customer_request_key=$1 FOR UPDATE",[key]);if(prior.rowCount){const prev=prior.rows[0],numericSame=await c.query("SELECT $1::numeric=$2::numeric AS yes",[prev.amount,amount]),allocation=await c.query("SELECT 1 FROM payment_allocations WHERE payment_id=$1 AND sales_invoice_id=$2",[prev.id,id]);const same=String(prev.store_id)===String(inv.store_id)&&String(prev.customer_id||"")===String(inv.customer_id||"")&&numericSame.rows[0].yes&&prev.payment_method===(req.body.method||"cash")&&prev.status==="posted"&&allocation.rowCount>0;if(!same)throw Object.assign(new Error("Payment request key was already used with different details"),{status:409});await c.query("COMMIT");return res.json(await loadInvoice(id));}if(inv.status!=="posted")throw Object.assign(new Error("Payments require a finalized invoice"),{status:409});const paid=await c.query("SELECT COALESCE(sum(pa.amount),0) amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.sales_invoice_id=$1 AND p.status='posted'",[id]);const credit=await c.query("SELECT COALESCE(sum(total),0) amount FROM sales_invoice_return_credits WHERE sales_invoice_id=$1 AND status='posted'",[id]);const exceeds=await c.query("SELECT $1::numeric+$2::numeric+$4::numeric>$3::numeric AS yes",[paid.rows[0].amount,amount,inv.total,credit.rows[0].amount]);if(exceeds.rows[0].yes)throw Object.assign(new Error("Payment exceeds the outstanding balance"),{status:409});
  const method=req.body.method||"cash";const configured=await c.query("SELECT 1 FROM payment_method_options WHERE code=$1 AND is_active=TRUE",[method]);if(!configured.rowCount)throw Object.assign(new Error("Payment method is not configured or active"),{status:400});const p=await c.query("INSERT INTO payments(store_id,payment_number,direction,status,payment_method,amount,payment_date,reference,created_by,customer_id,customer_request_key) VALUES($1,$2,'in','posted',$3,$4,COALESCE($5::date,current_date),$6,$7,$8,$9) RETURNING id",[inv.store_id,`RCPT-${randomUUID()}`,method,amount,req.body.paymentDate||null,String(req.body.reference||"").slice(0,120)||null,req.user.id,inv.customer_id,key]);await c.query("INSERT INTO payment_allocations(payment_id,store_id,direction,sales_invoice_id,amount) VALUES($1,$2,'in',$3,$4)",[p.rows[0].id,inv.store_id,id,amount]);await processSalesInvoiceBonus(c,id,req.user.id);await c.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id) VALUES($1,$2,'sales.payment.recorded','sales_invoice',$3)",[inv.store_id,req.user.id,id]);await c.query("COMMIT");return res.json(await loadInvoice(id));
  }catch(e){await c.query("ROLLBACK").catch(()=>{});return dbError(res,e,"Unable to record payment");}finally{c.release();}
}
