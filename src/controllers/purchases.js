import {readInvoiceSettings} from './invoiceSettings.js';
import {INVOICE_LAYOUTS} from '../services/invoicePolicy.js';
import {SUPPLIER_DOCUMENT_TYPES,validateSupplierTaxFacts} from '../services/purchaseTaxFacts.js';
import { connection } from "../../connection.js";
import { canAccessStore, canManageStore } from "./stores.js";

const isAdmin=(req)=>req.user?.userType?.toLowerCase()==="admin";
const idOk=(id)=>/^\d+$/.test(String(id??""));
const amountPattern=/^\d{1,14}(\.\d{1,4})?$/;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const invoiceFields=`pi.id,pi.store_id,st.code AS store_code,st.name AS store_name,pi.supplier_id,su.code AS supplier_code,su.name AS supplier_name,
  pi.supplier_details_snapshot,jsonb_build_object('name',su.name,'gstin',su.tax_id,'billingAddress',su.address,'city',su.city,'state',su.state,'pinCode',su.pin_code,'gstDetails',su.gst_details) AS supplier_current_details,
  pi.invoice_layout,pi.supplier_document_type,pi.supplier_tax_jurisdiction,pi.supplier_tax_reason,pi.declared_tax_total,pi.cgst_total,pi.sgst_total,pi.igst_total,pi.series,pi.invoice_number,pi.supplier_invoice_number,pi.invoice_date,pi.due_date,pi.subtotal,pi.discount_total,pi.tax_total,
  pi.freight_amount,pi.additional_charges,pi.round_off,pi.total,pi.status,pi.notes,pi.created_by,pi.posted_at,pi.created_at,pi.updated_at,
  pi.store_name_snapshot,pi.store_address_snapshot,pi.store_tax_id_snapshot,pi.store_phone_snapshot,pi.store_email_snapshot,
  COALESCE(pa.amount,0)::NUMERIC(18,2) AS paid_amount,COALESCE(pr.ret_total,0)::NUMERIC(18,2) AS returned_total,
  GREATEST(pi.total-COALESCE(pa.amount,0)-COALESCE(pr.ret_total,0),0)::NUMERIC(18,2) AS outstanding_balance,
  CASE WHEN pi.status<>'posted' THEN 'unposted' WHEN COALESCE(pa.amount,0)>=pi.total-COALESCE(pr.ret_total,0) THEN 'paid' WHEN COALESCE(pa.amount,0)>0 THEN 'partially_paid' ELSE 'unpaid' END AS payment_status`;
const invoiceJoins=`FROM purchase_invoices pi JOIN stores st ON st.id=pi.store_id JOIN suppliers su ON su.id=pi.supplier_id
  LEFT JOIN LATERAL(SELECT SUM(pax.amount) AS amount FROM payment_allocations pax JOIN payments pay ON pay.id=pax.payment_id AND pay.status='posted' WHERE pax.purchase_invoice_id=pi.id AND pax.direction='out') pa ON TRUE
  LEFT JOIN LATERAL(SELECT SUM(total) AS ret_total FROM purchase_returns WHERE purchase_invoice_id=pi.id AND status='posted') pr ON TRUE`;

function checkDecimal(value,label,{nullable=false,scale=4,signed=false}={}){
  if((value===undefined||value===null||value==="")&&nullable)return null;
  const pattern=signed?new RegExp(`^-?\\d{1,14}(\\.\\d{1,${scale}})?$`):new RegExp(`^\\d{1,14}(\\.\\d{1,${scale}})?$`);
  return pattern.test(String(value))?String(value):`${label} must be a valid ${scale===2?"amount":"decimal quantity or rate"}`;
}
function validateDraft(body={}){
  if(body.invoiceLayout!==undefined&&!INVOICE_LAYOUTS.includes(body.invoiceLayout))return {error:'Invalid billing mode'};
  if(body.supplierDocumentType!==undefined&&!SUPPLIER_DOCUMENT_TYPES.includes(body.supplierDocumentType))return {error:'Choose the actual supplier document type'};
  if(body.supplierTaxJurisdiction!==undefined&&body.supplierTaxJurisdiction!==null&&!['INTRA_STATE','INTER_STATE'].includes(body.supplierTaxJurisdiction))return {error:'Invalid supplier tax jurisdiction'};
  const declaredTaxTotal=checkDecimal(body.declaredTaxTotal,'Supplier GST total',{nullable:true,scale:2});
  if(declaredTaxTotal?.includes(' must be a valid '))return {error:declaredTaxTotal};
  const supplierTaxReason=String(body.supplierTaxReason||'').trim();if(supplierTaxReason.length>2000)return {error:'Supplier tax reason is too long'};
  if(!idOk(body.storeId)||!idOk(body.supplierId))return {error:"Choose a valid store and supplier"};
  if(!Array.isArray(body.items)||body.items.length<1||body.items.length>200)return {error:"A purchase invoice must contain between 1 and 200 item lines"};
  const freight=checkDecimal(body.freightAmount??"0","Freight",{scale:2});
  const charges=checkDecimal(body.additionalCharges??"0","Additional charges",{scale:2});
  const roundOff=checkDecimal(body.roundOff??"0","Round-off",{scale:2,signed:true});
  if([freight,charges,roundOff].some((v)=>typeof v==="string"&&v.includes(" must be a valid ")))return {error:[freight,charges,roundOff].find((v)=>typeof v==="string"&&v.includes(" must be a valid "))};
  const invoiceDate=body.invoiceDate||new Date().toISOString().slice(0,10);
  const dueDate=body.dueDate||null;
  if(!datePattern.test(invoiceDate)||(dueDate&&!datePattern.test(dueDate)))return {error:"Enter valid invoice and due dates in YYYY-MM-DD format"};
  if(dueDate&&dueDate<invoiceDate)return {error:"Due date cannot be earlier than invoice date"};
  const supplierInvoiceNumber=String(body.supplierInvoiceNumber||"").trim();
  const notes=String(body.notes||"").trim();
  if(supplierInvoiceNumber.length>80||notes.length>10000)return {error:"Supplier invoice number or notes exceed the allowed length"};
  const items=[];
  for(let index=0;index<body.items.length;index++){
    const row=body.items[index]||{};
    if(!idOk(row.productId)||!idOk(row.unitId))return {error:`Line ${index+1}: choose a product and unit`};
    const quantity=checkDecimal(row.quantity,"Quantity"); const unitPrice=checkDecimal(row.unitPrice,"Purchase rate");
    const discount=checkDecimal(row.discountAmount??"0","Discount",{scale:2});
    const taxRate=checkDecimal(row.taxRate,"Tax rate",{nullable:true});
    for(const value of [quantity,unitPrice,discount,taxRate])if(typeof value==="string"&&value.includes(" must be a valid "))return {error:`Line ${index+1}: ${value}`};
    if(Number(quantity)<=0||Number(taxRate)>100)return {error:`Line ${index+1}: quantity must be positive and tax rate cannot exceed 100%`};
    items.push({productId:String(row.productId),unitId:String(row.unitId),quantity,unitPrice,discountAmount:discount,taxRate});
  }
  return {data:{declaredTaxTotal,supplierTaxReason,supplierDocumentType:body.supplierDocumentType,supplierTaxJurisdiction:body.supplierTaxJurisdiction||null,storeId:String(body.storeId),supplierId:String(body.supplierId),invoiceDate,dueDate,supplierInvoiceNumber:supplierInvoiceNumber||null,notes:notes||null,freightAmount:freight,additionalCharges:charges,roundOff,items}};
}

async function storeAuthorized(req,res,storeId){
  if(!await canAccessStore(req.user,storeId)){res.status(403).json({message:"You do not have access to this store"});return false;}
  return true;
}
async function scopedStoreIds(req){
  if(isAdmin(req)){const result=await connection.query("SELECT id FROM stores WHERE is_active=TRUE ORDER BY id");return result.rows.map((row)=>String(row.id));}
  const result=await connection.query("SELECT usa.store_id AS id FROM user_store_assignments usa JOIN stores st ON st.id=usa.store_id WHERE usa.user_id=$1 AND usa.is_active=TRUE AND st.is_active=TRUE ORDER BY usa.store_id",[req.user.id]);
  return result.rows.map((row)=>String(row.id));
}
async function loadPurchase(id){
  const header=await connection.query(`SELECT ${invoiceFields} ${invoiceJoins} WHERE pi.id=$1`,[id]);
  if(!header.rowCount)return null;
  const items=await connection.query(`SELECT pii.id,pii.line_number,pii.product_id,pii.product_sku_snapshot AS sku,pii.product_name_snapshot AS product_name,
    pii.product_snapshot,pii.description,pii.unit_id,pii.unit_code_snapshot AS unit_code,pii.unit_name_snapshot AS unit_name,
    pii.cgst_amount,pii.sgst_amount,pii.igst_amount,pii.quantity,pii.unit_price,pii.discount_amount,pii.tax_rate,pii.taxable_value,pii.tax_amount,pii.line_total,
    COALESCE(received.quantity_received,0)::NUMERIC(18,4) AS quantity_received,
    GREATEST(pii.quantity-COALESCE(received.quantity_received,0),0)::NUMERIC(18,4) AS quantity_remaining
    FROM purchase_invoice_items pii LEFT JOIN LATERAL(SELECT SUM(pri.quantity_received) FILTER(WHERE pr.status='posted') AS quantity_received
      FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pri.purchase_invoice_item_id=pii.id) received ON TRUE
    WHERE pii.purchase_invoice_id=$1 ORDER BY pii.line_number`,[id]);
  const receipts=await connection.query(`SELECT id,receipt_number,status,receipt_date,notes,created_by,posted_at,created_at FROM purchase_receipts WHERE purchase_invoice_id=$1 ORDER BY receipt_date,id`,[id]);
  const payments=await connection.query(`SELECT pay.id,pay.payment_number,pay.payment_date,pay.payment_method,pay.amount,pax.amount AS allocated_amount,pay.reference,pay.notes
    FROM payment_allocations pax JOIN payments pay ON pay.id=pax.payment_id WHERE pax.purchase_invoice_id=$1 AND pax.direction='out' AND pay.status='posted' ORDER BY pay.payment_date,pay.id`,[id]);
  return {...header.rows[0],items:items.rows,receipts:receipts.rows,payments:payments.rows};
}

async function insertItemsAndRecalculate(client,invoiceId,data){
  await validateSupplierTaxFacts(client,data);
  if(data.invoiceLayout==='SIMPLE_LAYOUT'&&[data.freightAmount,data.additionalCharges,data.roundOff,...data.items.map(x=>x.discountAmount)].some(x=>Number(x)!==0))throw Object.assign(new Error('Simple Billing uses quantity × rate; nonzero discounts, freight, or adjustments require the detailed workflow.'),{status:400});
  await client.query("DELETE FROM purchase_invoice_items WHERE purchase_invoice_id=$1",[invoiceId]);
  for(let index=0;index<data.items.length;index++){
    const row=data.items[index];
    const productResult=await client.query(`SELECT p.id,p.sku,p.name,p.brand,p.collection,p.tile_size,p.finish,p.color,p.hsn_code,p.gst_supply_classification,p.gst_classification_reference,p.tax_rate AS default_tax_rate,
      p.base_unit_id,p.default_purchase_price,u.code AS unit_code,u.name AS unit_name,
      CASE WHEN p.base_unit_id=$2 THEN 1::numeric ELSE c.factor_to_base END AS conversion_factor_to_base,
      EXISTS(SELECT 1 FROM product_unit_conversions c WHERE c.product_id=p.id AND c.unit_id=$2) AS has_conversion
      FROM products p JOIN units_of_measure u ON u.id=$2 LEFT JOIN product_unit_conversions c ON c.product_id=p.id AND c.unit_id=$2 WHERE p.id=$1 AND p.is_active=TRUE`,[row.productId,row.unitId]);
    if(!productResult.rowCount)throw Object.assign(new Error(`Line ${index+1}: product or unit does not exist`),{status:400});
    const product=productResult.rows[0];
    if(String(product.base_unit_id)!==row.unitId&&!product.has_conversion)throw Object.assign(new Error(`Line ${index+1}: this unit has no conversion configured for the selected product`),{status:400});
    if(data.supplierDocumentType==='GST_TAX_INVOICE'&&row.taxRate===null)throw Object.assign(new Error(`Line ${index+1}: enter the tax rate actually shown on the supplier invoice`),{status:422});
    const taxRate=data.supplierDocumentType&&data.supplierDocumentType!=='GST_TAX_INVOICE'?(row.taxRate??'0'):row.taxRate??product.default_tax_rate;
    if(data.supplierDocumentType&&data.supplierDocumentType!=='GST_TAX_INVOICE'&&Number(taxRate)!==0)throw Object.assign(new Error('The supplier document is marked without GST but line tax rates are nonzero. Correct the actual supplier tax facts; changing appearance never clears tax.'),{status:422});
    if(taxRate===null||taxRate===undefined||taxRate==="")throw Object.assign(new Error(`Line ${index+1}: enter the applicable tax rate (enter 0 for tax-exempt items)`),{status:400});
    const saved=await client.query(`INSERT INTO purchase_invoice_items(purchase_invoice_id,line_number,product_id,description,unit_id,quantity,unit_price,discount_amount,tax_rate,taxable_value,tax_amount,line_total,
      product_sku_snapshot,product_name_snapshot,hsn_code_snapshot,product_snapshot,unit_code_snapshot,unit_name_snapshot,conversion_factor_to_base)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
       (round($6::numeric*$7::numeric,2)-$8::numeric),
       round((round($6::numeric*$7::numeric,2)-$8::numeric)*$9::numeric/100,2),
       (round($6::numeric*$7::numeric,2)-$8::numeric)+round((round($6::numeric*$7::numeric,2)-$8::numeric)*$9::numeric/100,2),
       $10,$11,$12,$13,$14,$15,$16)`,[invoiceId,index+1,product.id,product.name,row.unitId,row.quantity,row.unitPrice,row.discountAmount,taxRate,product.sku,product.name,product.hsn_code,
        {brand:product.brand,collection:product.collection,tileSize:product.tile_size,finish:product.finish,color:product.color,hsnCode:product.hsn_code,defaultTaxRate:product.default_tax_rate,supplyClassification:product.gst_supply_classification,classificationReference:product.gst_classification_reference},product.unit_code,product.unit_name,product.conversion_factor_to_base]);
    void saved;
  }
  await client.query(`UPDATE purchase_invoice_items SET
    cgst_amount=CASE WHEN $2='INTRA_STATE' THEN round(tax_amount/2,2) ELSE 0 END,
    sgst_amount=CASE WHEN $2='INTRA_STATE' THEN tax_amount-round(tax_amount/2,2) ELSE 0 END,
    igst_amount=CASE WHEN $2='INTER_STATE' THEN tax_amount ELSE 0 END WHERE purchase_invoice_id=$1`,[invoiceId,data.supplierTaxJurisdiction]);
  await client.query(`UPDATE purchase_invoices SET cgst_total=t.cgst,sgst_total=t.sgst,igst_total=t.igst FROM
    (SELECT COALESCE(sum(cgst_amount),0) cgst,COALESCE(sum(sgst_amount),0) sgst,COALESCE(sum(igst_amount),0) igst FROM purchase_invoice_items WHERE purchase_invoice_id=$1) t WHERE id=$1`,[invoiceId]);
  await client.query(`UPDATE purchase_invoices pi SET
    subtotal=totals.subtotal,discount_total=totals.discount_total,tax_total=totals.tax_total,
    total=totals.line_total+pi.freight_amount+pi.additional_charges+pi.round_off,updated_at=now()
    FROM (SELECT COALESCE(sum(round(quantity*unit_price,2)),0)::NUMERIC(18,2) AS subtotal,
      COALESCE(sum(discount_amount),0)::NUMERIC(18,2) AS discount_total,COALESCE(sum(tax_amount),0)::NUMERIC(18,2) AS tax_total,
      COALESCE(sum(line_total),0)::NUMERIC(18,2) AS line_total FROM purchase_invoice_items WHERE purchase_invoice_id=$1) totals WHERE pi.id=$1`,[invoiceId]);
  if(data.supplierDocumentType==='GST_TAX_INVOICE'&&data.declaredTaxTotal!==null){
    const match=await client.query('SELECT tax_total=$2::numeric AS valid FROM purchase_invoices WHERE id=$1',[invoiceId,data.declaredTaxTotal]);
    if(!match.rows[0].valid)throw Object.assign(new Error('Calculated GST does not match the GST total on the supplier invoice. Review tax rates and amounts.'),{status:422});
  }
}

function respondDbError(res,error,fallback){
  if(error.status)return res.status(error.status).json({message:error.message});
  if(["23503","23514","22007","22P02"].includes(error.code))return res.status(400).json({message:error.message});
  if(error.code==="23505")return res.status(409).json({message:"A duplicate invoice, payment, or receipt number was detected"});
  console.error(`${fallback}:`,error.message);return res.status(500).json({message:fallback});
}

export async function createPurchaseDraft(req,res){
  const validated=validateDraft(req.body);if(validated.error)return res.status(400).json({message:validated.error});const data=validated.data;
  if(!await storeAuthorized(req,res,data.storeId))return;
  const client=await connection.connect();
  try{
    await client.query("BEGIN");
    const storeResult=await client.query(`SELECT s.id,s.code,COALESCE(bc.invoice_prefix,s.code) AS invoice_prefix,s.invoice_numbering_period,s.invoice_number_padding FROM stores s LEFT JOIN store_billing_config bc ON bc.store_id=s.id WHERE s.id=$1 AND s.is_active=TRUE FOR SHARE OF s`,[data.storeId]);
    if(!storeResult.rowCount)throw Object.assign(new Error("Active store not found"),{status:404});
    const supplier=await client.query("SELECT id FROM suppliers WHERE id=$1 AND is_active=TRUE",[data.supplierId]);if(!supplier.rowCount)throw Object.assign(new Error("Active supplier not found"),{status:400});
    const settings=await readInvoiceSettings(client,data.storeId,true);data.invoiceLayout=settings.invoice_layout;
    if(req.body.invoiceLayout&&req.body.invoiceLayout!==data.invoiceLayout)throw Object.assign(new Error('Store billing preference changed. Reopen the purchase editor.'),{status:409});
    if(!data.supplierDocumentType)throw Object.assign(new Error('Choose the actual supplier invoice tax document; the store billing mode does not determine supplier GST.'),{status:422});
    await validateSupplierTaxFacts(client,data);
    const store=storeResult.rows[0];const series=(store.invoice_prefix||store.code||"PUR").toUpperCase();
    const period=store.invoice_numbering_period==="monthly"?data.invoiceDate.slice(0,7):store.invoice_numbering_period==="never"?"all":data.invoiceDate.slice(0,4);
    await client.query(`INSERT INTO invoice_number_sequences(store_id,document_type,series,period_key,next_number) VALUES($1,'purchase',$2,$3,1) ON CONFLICT(store_id,document_type,series,period_key) DO NOTHING`,[data.storeId,series,period]);
    const sequence=await client.query(`SELECT next_number FROM invoice_number_sequences WHERE store_id=$1 AND document_type='purchase' AND series=$2 AND period_key=$3 FOR UPDATE`,[data.storeId,series,period]);
    const sequenceNumber=sequence.rows[0].next_number;
    await client.query(`UPDATE invoice_number_sequences SET next_number=next_number+1 WHERE store_id=$1 AND document_type='purchase' AND series=$2 AND period_key=$3`,[data.storeId,series,period]);
    const invoiceNumber=`${series}-${period==='all'?'':`${period}-`}${String(sequenceNumber).padStart(store.invoice_number_padding||5,"0")}`;
    const inserted=await client.query(`INSERT INTO purchase_invoices(store_id,supplier_id,series,invoice_number,supplier_invoice_number,status,invoice_date,due_date,freight_amount,additional_charges,round_off,notes,created_by,invoice_layout,supplier_document_type,supplier_tax_jurisdiction,supplier_tax_reason,declared_tax_total)
      VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,[data.storeId,data.supplierId,series,invoiceNumber,data.supplierInvoiceNumber,data.invoiceDate,data.dueDate,data.freightAmount,data.additionalCharges,data.roundOff,data.notes,req.user.id,data.invoiceLayout,data.supplierDocumentType,data.supplierTaxJurisdiction,data.supplierTaxReason||null,data.declaredTaxTotal]);
    const id=inserted.rows[0].id;await insertItemsAndRecalculate(client,id,data);
    await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'purchase.draft.created','purchase_invoice',$3,$4)",[data.storeId,req.user.id,id,{invoiceLayout:data.invoiceLayout,supplierDocumentType:data.supplierDocumentType}]);await client.query("COMMIT");
    return res.status(201).json(await loadPurchase(id));
  }catch(error){await client.query("ROLLBACK").catch(()=>{});return respondDbError(res,error,"Unable to create purchase draft");}finally{client.release();}
}

export async function listPurchases(req,res){
  try{
    const stores=await scopedStoreIds(req);if(!stores.length)return res.json({items:[],pagination:{limit:50,offset:0,total:0}});
    if(req.query.storeId&&(!idOk(req.query.storeId)||!stores.includes(String(req.query.storeId))))return res.status(403).json({message:"You do not have access to this store"});
    const values=[stores];let where=["pi.store_id=ANY($1::bigint[])"];
    if(req.query.storeId){values.push(req.query.storeId);where.push(`pi.store_id=$${values.length}`);}
    if(req.query.supplierId){if(!idOk(req.query.supplierId))return res.status(400).json({message:"Invalid supplier ID"});values.push(req.query.supplierId);where.push(`pi.supplier_id=$${values.length}`);}
    if(req.query.status){values.push(req.query.status);where.push(`pi.status=$${values.length}`);}
    const q=String(req.query.q||"").trim();if(q){values.push(`%${q.slice(0,100)}%`);where.push(`(pi.invoice_number ILIKE $${values.length} OR COALESCE(pi.supplier_invoice_number,'') ILIKE $${values.length} OR su.name ILIKE $${values.length})`);}
    const limit=Math.min(Math.max(Number.parseInt(req.query.limit,10)||50,1),200);const offset=Math.max(Number.parseInt(req.query.offset,10)||0,0);
    const count=await connection.query(`SELECT count(*)::int AS total ${invoiceJoins} WHERE ${where.join(" AND ")}`,values);
    values.push(limit,offset);const result=await connection.query(`SELECT ${invoiceFields} ${invoiceJoins} WHERE ${where.join(" AND ")} ORDER BY pi.invoice_date DESC,pi.id DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    return res.json({items:result.rows,pagination:{limit,offset,total:count.rows[0].total}});
  }catch(error){return respondDbError(res,error,"Unable to load purchase invoices");}
}

export async function getPurchase(req,res){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid purchase invoice ID"});
  try{const purchase=await loadPurchase(req.params.id);if(!purchase)return res.status(404).json({message:"Purchase invoice not found"});if(!await storeAuthorized(req,res,purchase.store_id))return;return res.json(purchase);}
  catch(error){return respondDbError(res,error,"Unable to load purchase invoice");}
}
export async function getPurchaseItems(req,res){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid purchase invoice ID"});
  try{const purchase=await loadPurchase(req.params.id);if(!purchase)return res.status(404).json({message:"Purchase invoice not found"});if(!await storeAuthorized(req,res,purchase.store_id))return;return res.json(purchase.items);}
  catch(error){return respondDbError(res,error,"Unable to load purchase items");}
}

export async function updatePurchaseDraft(req,res){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid purchase invoice ID"});
  const validated=validateDraft(req.body);if(validated.error)return res.status(400).json({message:validated.error});const data=validated.data;
  const client=await connection.connect();
  try{
    await client.query("BEGIN");const lock=await client.query("SELECT id,store_id,status,invoice_layout,supplier_document_type FROM purchase_invoices WHERE id=$1 FOR UPDATE",[req.params.id]);
    if(!lock.rowCount){await client.query("ROLLBACK");return res.status(404).json({message:"Purchase invoice not found"});}
    const current=lock.rows[0];if(!await storeAuthorized(req,res,current.store_id)){await client.query("ROLLBACK");return;}
    if(current.status!=="draft"){await client.query("ROLLBACK");return res.status(409).json({message:"Only draft purchase invoices can be updated"});}
    if(String(current.store_id)!==data.storeId){await client.query("ROLLBACK");return res.status(400).json({message:"The receiving store cannot be changed after invoice creation"});}
    data.invoiceLayout=current.invoice_layout;
    data.supplierDocumentType=req.body.supplierDocumentType??current.supplier_document_type;
    if(req.body.invoiceLayout&&req.body.invoiceLayout!==data.invoiceLayout)throw Object.assign(new Error('Purchase billing mode cannot be changed after creation'),{status:409});
    const supplier=await client.query("SELECT 1 FROM suppliers WHERE id=$1 AND is_active=TRUE",[data.supplierId]);if(!supplier.rowCount)throw Object.assign(new Error("Active supplier not found"),{status:400});
    await client.query(`UPDATE purchase_invoices SET supplier_id=$2,supplier_invoice_number=$3,invoice_date=$4,due_date=$5,freight_amount=$6,additional_charges=$7,round_off=$8,notes=$9,supplier_document_type=$10,supplier_tax_jurisdiction=$11,supplier_tax_reason=$12,declared_tax_total=$13,updated_at=now() WHERE id=$1`,[req.params.id,data.supplierId,data.supplierInvoiceNumber,data.invoiceDate,data.dueDate,data.freightAmount,data.additionalCharges,data.roundOff,data.notes,data.supplierDocumentType,data.supplierTaxJurisdiction,data.supplierTaxReason||null,data.declaredTaxTotal]);
    await insertItemsAndRecalculate(client,req.params.id,data);await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,'purchase.draft.updated','purchase_invoice',$3,$4,$5)",[data.storeId,req.user.id,req.params.id,{supplierDocumentType:current.supplier_document_type,invoiceLayout:current.invoice_layout},{supplierDocumentType:data.supplierDocumentType,invoiceLayout:data.invoiceLayout}]);await client.query("COMMIT");return res.json(await loadPurchase(req.params.id));
  }catch(error){await client.query("ROLLBACK").catch(()=>{});return respondDbError(res,error,"Unable to update purchase draft");}finally{client.release();}
}

export async function postPurchaseInvoice(req,res){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid purchase invoice ID"});
  try{
    const client=await connection.connect();try{await client.query("BEGIN");const row=await client.query("SELECT * FROM purchase_invoices WHERE id=$1 FOR UPDATE",[req.params.id]);if(!row.rowCount){await client.query("ROLLBACK");return res.status(404).json({message:"Purchase invoice not found"});}if(!await storeAuthorized(req,res,row.rows[0].store_id)){await client.query("ROLLBACK");return;}if(row.rows[0].status!=="draft"){await client.query("ROLLBACK");return res.status(409).json({message:"Only a draft purchase invoice can be posted"});}const inv=row.rows[0];await validateSupplierTaxFacts(client,{supplierId:inv.supplier_id,supplierDocumentType:inv.supplier_document_type,supplierTaxJurisdiction:inv.supplier_tax_jurisdiction,supplierInvoiceNumber:inv.supplier_invoice_number,supplierTaxReason:inv.supplier_tax_reason,declaredTaxTotal:inv.declared_tax_total},{posting:true});await client.query("UPDATE purchase_invoices SET status='posted',posted_at=now(),updated_at=now() WHERE id=$1",[req.params.id]);await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id) VALUES($1,$2,'purchase.invoice.posted','purchase_invoice',$3)",[row.rows[0].store_id,req.user.id,req.params.id]);await client.query("COMMIT");return res.json(await loadPurchase(req.params.id));}catch(error){await client.query("ROLLBACK").catch(()=>{});return respondDbError(res,error,"Unable to post purchase invoice");}finally{client.release();}
  }catch(error){return respondDbError(res,error,"Unable to post purchase invoice");}
}

export async function receivePurchaseGoods(req,res){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid purchase invoice ID"});
  const {items,idempotencyKey,receiptDate,notes}=req.body||{};
  if(typeof idempotencyKey!=="string"||idempotencyKey.length<8||idempotencyKey.length>120)return res.status(400).json({message:"A valid idempotency key is required"});
  if(!Array.isArray(items)||items.length<1||items.length>200)return res.status(400).json({message:"Provide at least one received invoice line"});
  if(receiptDate&&!datePattern.test(receiptDate))return res.status(400).json({message:"Receipt date must use YYYY-MM-DD"});
  for(const row of items){const received=checkDecimal(row.quantityReceived,"Received quantity");if(!idOk(row.purchaseInvoiceItemId)||typeof received!=="string"||received.includes(" must be a valid ")||Number(received)<=0)return res.status(400).json({message:"Each receipt item needs an invoice line and a positive decimal quantity"});}
  const client=await connection.connect();
  try{
    await client.query("BEGIN");const invoice=await client.query("SELECT id,store_id,status FROM purchase_invoices WHERE id=$1 FOR UPDATE",[req.params.id]);if(!invoice.rowCount){await client.query("ROLLBACK");return res.status(404).json({message:"Purchase invoice not found"});}const header=invoice.rows[0];if(!await storeAuthorized(req,res,header.store_id)){await client.query("ROLLBACK");return;}if(header.status!=="posted"){await client.query("ROLLBACK");return res.status(409).json({message:"Post the purchase invoice before receiving goods"});}
    const existing=await client.query("SELECT id,receipt_number,status FROM purchase_receipts WHERE idempotency_key=$1",[idempotencyKey]);if(existing.rowCount){await client.query("COMMIT");return res.status(200).json({...existing.rows[0],duplicate:true});}
    const created=await client.query(`INSERT INTO purchase_receipts(purchase_invoice_id,store_id,receipt_number,idempotency_key,receipt_date,notes,created_by)
      VALUES($1,$2,'PENDING-'||$3,$4,COALESCE($5::date,CURRENT_DATE),$6,$7) RETURNING id`,[req.params.id,header.store_id,`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,idempotencyKey,receiptDate||null,String(notes||"").slice(0,2000)||null,req.user.id]);
    const receiptId=created.rows[0].id;await client.query("UPDATE purchase_receipts SET receipt_number=$2 WHERE id=$1",[receiptId,`GRN-${receiptId}`]);
    const seen=new Set();for(const row of items){if(seen.has(String(row.purchaseInvoiceItemId)))throw Object.assign(new Error("A receipt can contain each invoice line only once"),{status:400});seen.add(String(row.purchaseInvoiceItemId));await client.query("INSERT INTO purchase_receipt_items(receipt_id,purchase_invoice_item_id,quantity_received) VALUES($1,$2,$3)",[receiptId,row.purchaseInvoiceItemId,row.quantityReceived]);}
    const posted=await client.query("UPDATE purchase_receipts SET status='posted',posted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[receiptId]);
    await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'purchase.goods_received','purchase_receipt',$3,$4)",[header.store_id,req.user.id,receiptId,{purchaseInvoiceId:req.params.id,items}]);
    await client.query("COMMIT");return res.status(201).json(posted.rows[0]);
  }catch(error){await client.query("ROLLBACK").catch(()=>{});return respondDbError(res,error,"Unable to receive purchase goods");}finally{client.release();}
}

export async function reverseGoodsReceipt(req,res){
  if(!idOk(req.params.id)||!idOk(req.params.receiptId))return res.status(400).json({message:"Invalid purchase invoice or receipt ID"});
  const client=await connection.connect();
  try{
    await client.query("BEGIN");
    const result=await client.query("SELECT id,status,store_id FROM purchase_receipts WHERE id=$1 AND purchase_invoice_id=$2 FOR UPDATE",[req.params.receiptId,req.params.id]);
    if(!result.rowCount){await client.query("ROLLBACK");return res.status(404).json({message:"Goods receipt not found"});}
    const receipt=result.rows[0];if(!await storeAuthorized(req,res,receipt.store_id)){await client.query("ROLLBACK");return;}if(!await canManageStore(req.user,receipt.store_id,["owner","manager","inventory"],client)){await client.query("ROLLBACK");return res.status(403).json({message:"Inventory manager authorization is required to reverse a goods receipt"});}
    if(receipt.status!=="posted"){await client.query("ROLLBACK");return res.status(409).json({message:"Only a posted goods receipt can be reversed"});}
    await client.query("UPDATE purchase_receipts SET status='reversed',updated_at=now() WHERE id=$1",[receipt.id]);
    await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id) VALUES($1,$2,'purchase.receipt.reversed','purchase_receipt',$3)",[receipt.store_id,req.user.id,receipt.id]);
    await client.query("COMMIT");return res.json({id:receipt.id,status:"reversed"});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});return respondDbError(res,error,"Unable to reverse goods receipt");}finally{client.release();}
}

async function changePurchaseStatus(req,res,status){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid purchase invoice ID"});const client=await connection.connect();
  try{await client.query("BEGIN");const found=await client.query("SELECT store_id,status FROM purchase_invoices WHERE id=$1 FOR UPDATE",[req.params.id]);if(!found.rowCount){await client.query("ROLLBACK");return res.status(404).json({message:"Purchase invoice not found"});}const invoice=found.rows[0];if(!await storeAuthorized(req,res,invoice.store_id)){await client.query("ROLLBACK");return;}if(status==="cancelled"&&invoice.status!=="draft"){await client.query("ROLLBACK");return res.status(409).json({message:"Only draft purchase invoices can be cancelled"});}if(status==="reversed"){
    if(!await canManageStore(req.user,invoice.store_id,["owner","manager"],client)){await client.query("ROLLBACK");return res.status(403).json({message:"Manager authorization is required to reverse a posted purchase invoice"});}
    if(invoice.status!=="posted"){await client.query("ROLLBACK");return res.status(409).json({message:"Only posted invoices can be reversed"});}
    const dependencies=await client.query(`SELECT EXISTS(SELECT 1 FROM purchase_receipts WHERE purchase_invoice_id=$1 AND status='posted') AS has_receipts,
      EXISTS(SELECT 1 FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.purchase_invoice_id=$1 AND p.status='posted') AS has_payments`,[req.params.id]);
    if(dependencies.rows[0].has_receipts||dependencies.rows[0].has_payments){await client.query("ROLLBACK");return res.status(409).json({message:"Reverse posted goods receipts and supplier payments before reversing the purchase invoice"});}
  }
  await client.query("UPDATE purchase_invoices SET status=$2,updated_at=now() WHERE id=$1",[req.params.id,status]);await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,'purchase_invoice',$4)",[invoice.store_id,req.user.id,`purchase.invoice.${status}`,req.params.id]);await client.query("COMMIT");return res.json(await loadPurchase(req.params.id));
  }catch(error){await client.query("ROLLBACK").catch(()=>{});return respondDbError(res,error,"Unable to change purchase invoice status");}finally{client.release();}
}
export const cancelPurchase=(req,res)=>changePurchaseStatus(req,res,"cancelled");
export const reversePurchase=(req,res)=>changePurchaseStatus(req,res,"reversed");

export async function recordSupplierPayment(req,res){
  const {storeId,supplierId,paymentMethod,amount,allocations,paymentDate,reference,notes,idempotencyKey}=req.body||{};
  if(!idOk(storeId)||!idOk(supplierId))return res.status(400).json({message:"Choose a valid store and supplier"});
  if(!["cash","upi","card","bank_transfer","cheque","other"].includes(paymentMethod))return res.status(400).json({message:"Choose a valid payment method"});
  const validPaymentAmount=checkDecimal(amount,"Payment amount",{scale:2});if(typeof validPaymentAmount!=="string"||validPaymentAmount.includes(" must be a valid ")||Number(validPaymentAmount)<=0)return res.status(400).json({message:"Payment amount must be greater than zero and use up to two decimal places"});
  if(!Array.isArray(allocations)||allocations.length<1||allocations.length>100)return res.status(400).json({message:"Allocate the payment to at least one purchase invoice"});
  if(typeof idempotencyKey!=="string"||idempotencyKey.length<8||idempotencyKey.length>120)return res.status(400).json({message:"A valid payment request idempotency key is required"});
  if(paymentDate&&!datePattern.test(paymentDate))return res.status(400).json({message:"Payment date must use YYYY-MM-DD"});
  const client=await connection.connect();
  try{await client.query("BEGIN");if(!await storeAuthorized(req,res,storeId)){await client.query("ROLLBACK");return;}
    const previous=await client.query("SELECT id,store_id,supplier_id,payment_number,amount,payment_date,payment_method FROM payments WHERE purchase_request_key=$1",[idempotencyKey]);if(previous.rowCount){if(String(previous.rows[0].store_id)!==String(storeId)||String(previous.rows[0].supplier_id)!==String(supplierId)){await client.query("ROLLBACK");return res.status(409).json({message:"Payment request key has already been used"});}const previousAllocations=await client.query("SELECT purchase_invoice_id AS invoice_id,amount FROM payment_allocations WHERE payment_id=$1 ORDER BY id",[previous.rows[0].id]);await client.query("COMMIT");return res.status(200).json({...previous.rows[0],allocations:previousAllocations.rows,duplicate:true});}
    const supplier=await client.query("SELECT id FROM suppliers WHERE id=$1 AND is_active=TRUE",[supplierId]);if(!supplier.rowCount)throw Object.assign(new Error("Active supplier not found"),{status:400});
    const allocationIds=allocations.map((item)=>String(item.invoiceId));if(allocationIds.some((id)=>!idOk(id))||new Set(allocationIds).size!==allocationIds.length)throw Object.assign(new Error("Each allocated purchase invoice must be valid and unique"),{status:400});
    const locked=await client.query(`SELECT id,store_id,supplier_id,status,total FROM purchase_invoices WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[allocationIds]);if(locked.rowCount!==allocationIds.length)throw Object.assign(new Error("One or more purchase invoices were not found"),{status:404});
    let allocationTotal="0.00";
    for(const allocation of allocations){const invoice=locked.rows.find((row)=>String(row.id)===String(allocation.invoiceId));if(String(invoice.store_id)!==String(storeId)||String(invoice.supplier_id)!==String(supplierId)||invoice.status!=="posted")throw Object.assign(new Error("Payments can only be allocated to posted invoices for this supplier and store"),{status:400});const value=checkDecimal(allocation.amount,"Allocation amount",{scale:2});if(typeof value!=="string"||value.includes(" must be a valid ")||Number(value)<=0)throw Object.assign(new Error("Each allocation must be a positive amount with two decimal places"),{status:400});allocation.amount=value;
      const due=await client.query(`SELECT GREATEST(pi.total-COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='posted' WHERE pa.purchase_invoice_id=pi.id),0)-COALESCE((SELECT SUM(total) FROM purchase_returns WHERE purchase_invoice_id=pi.id AND status='posted'),0),0)::NUMERIC(18,2) AS due FROM purchase_invoices pi WHERE pi.id=$1`,[invoice.id]);
      const valid=await client.query("SELECT $1::numeric <= $2::numeric AS fits",[value,due.rows[0].due]);if(!valid.rows[0].fits)throw Object.assign(new Error(`Payment allocation exceeds the outstanding balance on invoice ${invoice.id}`),{status:400});
      const summed=await client.query("SELECT $1::numeric+$2::numeric AS value",[allocationTotal,value]);allocationTotal=summed.rows[0].value;
    }
    const fits=await client.query("SELECT $1::numeric <= $2::numeric AS fits",[allocationTotal,amount]);if(!fits.rows[0].fits)throw Object.assign(new Error("Allocated amounts cannot exceed the payment amount"),{status:400});
    const sequence=await client.query("SELECT nextval('purchase_payment_number_seq') AS value");const paymentNumber=`SP-${String(sequence.rows[0].value).padStart(8,"0")}`;
    const payment=await client.query(`INSERT INTO payments(store_id,payment_number,direction,status,payment_method,amount,payment_date,reference,notes,created_by,supplier_id,purchase_request_key)
      VALUES($1,$2,'out','posted',$3,$4,COALESCE($5::date,CURRENT_DATE),$6,$7,$8,$9,$10) RETURNING id,payment_number,amount,payment_date,payment_method`,[storeId,paymentNumber,paymentMethod,amount,paymentDate||null,String(reference||"").slice(0,120)||null,String(notes||"").slice(0,2000)||null,req.user.id,supplierId,idempotencyKey]);
    for(const allocation of allocations)await client.query(`INSERT INTO payment_allocations(payment_id,store_id,direction,purchase_invoice_id,amount) VALUES($1,$2,'out',$3,$4)`,[payment.rows[0].id,storeId,allocation.invoiceId,allocation.amount]);
    await client.query("INSERT INTO audit_logs(store_id,user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'supplier.payment.posted','payment',$3,$4)",[storeId,req.user.id,payment.rows[0].id,{supplierId,allocations}]);await client.query("COMMIT");return res.status(201).json({...payment.rows[0],allocations});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});return respondDbError(res,error,"Unable to record supplier payment");}finally{client.release();}
}

export async function purchaseReports(req,res){
  try{const stores=await scopedStoreIds(req);if(!stores.length)return res.json({summary:{invoice_count:0,purchase_total:"0.00",paid_total:"0.00",outstanding_total:"0.00"},bySupplier:[],byStore:[]});if(req.query.storeId&&(!idOk(req.query.storeId)||!stores.includes(String(req.query.storeId))))return res.status(403).json({message:"You do not have access to this store"});
    const values=[stores];let storeClause="pi.store_id=ANY($1::bigint[])";if(req.query.storeId){values.push(req.query.storeId);storeClause+=` AND pi.store_id=$${values.length}`;}const startDate=req.query.startDate,endDate=req.query.endDate;if(startDate&&datePattern.test(startDate)){values.push(startDate);storeClause+=` AND pi.invoice_date >= $${values.length}::date`;}if(endDate&&datePattern.test(endDate)){values.push(endDate);storeClause+=` AND pi.invoice_date <= $${values.length}::date`;}
    const summary=await connection.query(`SELECT count(*)::int AS invoice_count,COALESCE(sum(pi.total) FILTER(WHERE pi.status='posted'),0)::numeric(18,2) AS purchase_total,
      COALESCE(sum(COALESCE(pa.amount,0)) FILTER(WHERE pi.status='posted'),0)::numeric(18,2) AS paid_total,
      COALESCE(sum(GREATEST(pi.total-COALESCE(pa.amount,0)-COALESCE(pr.ret_total,0),0)) FILTER(WHERE pi.status='posted'),0)::numeric(18,2) AS outstanding_total
      FROM purchase_invoices pi LEFT JOIN LATERAL(SELECT sum(pax.amount) amount FROM payment_allocations pax JOIN payments pay ON pay.id=pax.payment_id AND pay.status='posted' WHERE pax.purchase_invoice_id=pi.id) pa ON TRUE
      LEFT JOIN LATERAL(SELECT sum(total) ret_total FROM purchase_returns WHERE purchase_invoice_id=pi.id AND status='posted') pr ON TRUE WHERE ${storeClause}`,values);
    const bySupplier=await connection.query(`SELECT su.id,su.name,COUNT(*)::int AS invoice_count,COALESCE(SUM(pi.total),0)::numeric(18,2) AS purchase_total FROM purchase_invoices pi JOIN suppliers su ON su.id=pi.supplier_id WHERE ${storeClause} AND pi.status='posted' GROUP BY su.id,su.name ORDER BY purchase_total DESC`,values);
    const byStore=await connection.query(`SELECT st.id,st.code,st.name,COUNT(*)::int AS invoice_count,COALESCE(SUM(pi.total),0)::numeric(18,2) AS purchase_total FROM purchase_invoices pi JOIN stores st ON st.id=pi.store_id WHERE ${storeClause} AND pi.status='posted' GROUP BY st.id,st.code,st.name ORDER BY st.name`,values);
    return res.json({summary:summary.rows[0],bySupplier:bySupplier.rows,byStore:byStore.rows});
  }catch(error){return respondDbError(res,error,"Unable to load purchase reports");}
}
