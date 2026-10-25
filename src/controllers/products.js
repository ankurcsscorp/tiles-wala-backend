import { connection } from "../../connection.js";
import { canAccessStore } from "./stores.js";

const isAdmin = (req) => req.user?.userType?.toLowerCase() === "admin";
const idOk = (id) => /^\d+$/.test(String(id ?? ""));
const text = (v) => typeof v === "string" ? v.trim() : "";
const positiveId = (value) => value === null || value === undefined || value === "" ? null : idOk(value) ? String(value) : NaN;
const money = (value, label, nullable = true) => {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const s = String(value);
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(s)) return `${label} must be a non-negative amount with up to 4 decimal places`;
  return s;
};

const productSelect = `p.id,p.sku,p.name,p.description,p.product_description,p.category_id,pc.name AS category,
 p.brand,p.collection,p.tile_size,p.finish,p.color,p.product_image_url,p.hsn_code,p.tax_rate,p.tax_inclusive,p.gst_supply_classification,p.gst_classification_reference,
 p.base_unit_id,bu.code AS base_unit_code,bu.name AS base_unit_name,
 p.purchase_unit_id,pu.code AS purchase_unit_code,pu.name AS purchase_unit_name,
 p.sales_unit_id,su.code AS sales_unit_code,su.name AS sales_unit_name,
 p.default_purchase_price,p.default_selling_price,p.reorder_threshold,p.is_active,p.created_at,p.updated_at`;

function validateProduct(body = {}) {
  const sku=text(body.sku).toUpperCase(); const name=text(body.name);
  const categoryId=positiveId(body.categoryId); const baseUnitId=positiveId(body.baseUnitId);
  const purchaseUnitId=positiveId(body.purchaseUnitId); const salesUnitId=positiveId(body.salesUnitId);
  if (!sku || sku.length>80 || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(sku)) return {error:"SKU is required and may contain letters, numbers, dots, underscores, slashes, or hyphens"};
  if (!name || name.length>200) return {error:"Product name is required and must be 200 characters or fewer"};
  if (Number.isNaN(categoryId)||Number.isNaN(baseUnitId)||Number.isNaN(purchaseUnitId)||Number.isNaN(salesUnitId)) return {error:"Category and unit IDs must be valid"};
  if (!baseUnitId) return {error:"A base unit is required"};
  const prices={purchase:money(body.defaultPurchasePrice,"Default purchase price"),selling:money(body.defaultSellingPrice,"Default selling price"),reorder:money(body.reorderThreshold,"Reorder threshold")};
  for(const value of Object.values(prices)) if(typeof value==="string"&&value.includes("must be")) return {error:value};
  let taxRate=null;
  if(body.taxRate!==null&&body.taxRate!==undefined&&body.taxRate!=="") {
    const raw=String(body.taxRate);
    if(!/^\d{1,3}(\.\d{1,4})?$/.test(raw)||Number(raw)>100) return {error:"Tax rate must be between 0 and 100 with up to 4 decimal places"};
    taxRate=raw;
  }
  const supplyClassification=body.supplyClassification??'UNKNOWN',classificationReference=text(body.classificationReference);
  if(!['UNKNOWN','TAXABLE','EXEMPT','NON_TAXABLE'].includes(supplyClassification)||classificationReference.length>2000)return {error:'Invalid supply classification or reference'};
  if(['EXEMPT','NON_TAXABLE'].includes(supplyClassification)&&!classificationReference)return {error:'An exemption or non-taxable classification reference is required'};
  const rawConversions=body.conversions??[];
  if(!Array.isArray(rawConversions)||rawConversions.length>40) return {error:"Conversions must be a list of at most 40 units"};
  const seen=new Set(); const conversions=[];
  for(const row of rawConversions) {
    const unitId=positiveId(row?.unitId); const factor=String(row?.factorToBase??"");
    if(!unitId||Number.isNaN(unitId)) return {error:"Each conversion needs a valid unit"};
    if(String(unitId)===String(baseUnitId)) return {error:"The base unit conversion is always 1 and should not be added"};
    if(seen.has(String(unitId))) return {error:"A unit conversion may only be listed once per product"};
    if(!/^\d{1,10}(\.\d{1,8})?$/.test(factor)||Number(factor)<=0) return {error:"Conversion factors must be positive decimals with up to 8 decimal places"};
    seen.add(String(unitId)); conversions.push({unitId:String(unitId),factor});
  }
  if(purchaseUnitId&&String(purchaseUnitId)!==String(baseUnitId)&&!seen.has(String(purchaseUnitId))) return {error:"Add a conversion factor for the purchase unit"};
  if(salesUnitId&&String(salesUnitId)!==String(baseUnitId)&&!seen.has(String(salesUnitId))) return {error:"Add a conversion factor for the sales unit"};
  const image=text(body.productImageUrl);
  if(image.length>2000) return {error:"Product image URL must be 2000 characters or fewer"};
  const fields={supplyClassification,classificationReference,sku,name,categoryId,baseUnitId,purchaseUnitId,salesUnitId,conversions,
    description:text(body.description),productDescription:text(body.productDescription),brand:text(body.brand),collection:text(body.collection),tileSize:text(body.tileSize),finish:text(body.finish),color:text(body.color),productImageUrl:image,
    hsnCode:text(body.hsnCode),taxRate,taxInclusive:typeof body.taxInclusive==="boolean"?body.taxInclusive:null,
    defaultPurchasePrice:prices.purchase,defaultSellingPrice:prices.selling,reorderThreshold:prices.reorder,isActive:body.isActive!==false};
  if(fields.description.length>2000||fields.productDescription.length>10000||fields.brand.length>120||fields.collection.length>160||fields.tileSize.length>80||fields.finish.length>80||fields.color.length>80||fields.hsnCode.length>16) return {error:"One or more product fields exceed the allowed length"};
  return {data:fields};
}

const listJoins=`FROM products p LEFT JOIN product_categories pc ON pc.id=p.category_id
 JOIN units_of_measure bu ON bu.id=p.base_unit_id
 LEFT JOIN units_of_measure pu ON pu.id=p.purchase_unit_id LEFT JOIN units_of_measure su ON su.id=p.sales_unit_id`;

export async function listProducts(req,res) {
  const page=Number(req.query.page??1), limit=Number(req.query.limit??25);
  if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100) return res.status(400).json({message:"Page must be positive and limit must be between 1 and 100"});
  const sortMap={sku:"p.sku",name:"p.name",brand:"p.brand",category:"pc.name",createdAt:"p.created_at",updatedAt:"p.updated_at"};
  const sort=sortMap[req.query.sort]||"p.name"; const direction=String(req.query.direction||"asc").toLowerCase()==="desc"?"DESC":"ASC";
  const params=[]; const where=[]; const bind=(v)=>{params.push(v);return `$${params.length}`;};
  if(req.params?.id) where.push(`p.id=${bind(req.params.id)}`);
  const q=text(req.query.q).toLowerCase();
  if(q){const p=bind(`${q}%`);where.push(`(lower(p.sku) LIKE ${p} OR lower(p.name) LIKE ${p} OR lower(COALESCE(p.brand,'')) LIKE ${p} OR lower(COALESCE(p.collection,'')) LIKE ${p} OR lower(COALESCE(pc.name,'')) LIKE ${p} OR lower(COALESCE(p.tile_size,'')) LIKE ${p} OR lower(COALESCE(p.finish,'')) LIKE ${p})`);}
  for(const [key,expression] of [["categoryId","p.category_id"],["brand","p.brand"],["collection","p.collection"],["tileSize","p.tile_size"],["finish","p.finish"]]) {
    const value=text(req.query[key]); if(value){const p=bind(key==="categoryId"?value:`${value}%`);where.push(key==="categoryId"?`${expression}=${p}`:`lower(${expression}) LIKE lower(${p})`);}
  }
  if(req.query.isActive!==undefined) where.push(`p.is_active=${bind(String(req.query.isActive)==="true")}`);
  else if(!isAdmin(req)) where.push("p.is_active=TRUE");
  const storeId=req.query.storeId;
  if(storeId!==undefined){if(!idOk(storeId))return res.status(400).json({message:"Invalid store ID"});try{if(!(await canAccessStore(req.user,storeId)))return res.status(403).json({message:"You do not have access to this store"});}catch{return res.status(500).json({message:"Unable to verify store access"});}}
  const businessWide=String(req.query.includeBusinessStock)==="true";
  if(businessWide&&!isAdmin(req))return res.status(403).json({message:"Only admins can view business-wide stock"});
  try{
    const whereSql=where.length?`WHERE ${where.join(" AND ")}`:"";
    const count=await connection.query(`SELECT count(*)::int AS total ${listJoins} ${whereSql}`,params);
    const offset=(page-1)*limit;const limitParam=bind(limit);const offsetParam=bind(offset);
    const storeExpr=storeId?`COALESCE((SELECT quantity FROM inventory_balances ib WHERE ib.product_id=p.id AND ib.store_id=${bind(storeId)}),0)`:"NULL";
    const businessExpr=businessWide?"COALESCE((SELECT sum(quantity) FROM inventory_balances ib WHERE ib.product_id=p.id),0)":"NULL";
    const data=await connection.query(`SELECT ${productSelect},${storeExpr} AS store_stock,${businessExpr} AS business_stock ${listJoins} ${whereSql} ORDER BY ${sort} ${direction},p.id ASC LIMIT ${limitParam} OFFSET ${offsetParam}`,params);
    res.json({items:data.rows,pagination:{page,limit,total:count.rows[0].total,totalPages:Math.ceil(count.rows[0].total/limit)}});
  }catch(error){console.error("Unable to list products:",error.message);res.status(500).json({message:"Unable to load products"});}
}

export async function getProduct(req,res){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid product ID"});
  const scopedReq={...req,query:{...req.query,page:"1",limit:"1"},params:req.params};
  const originalJson=res.json;
  res.json=(data)=>{if(!data.items?.length)return res.status(404).json({message:"Product not found"});return originalJson.call(res,data.items[0]);};
  return listProducts(scopedReq,res);
}

async function saveConversions(client,productId,conversions){
  await client.query("DELETE FROM product_unit_conversions WHERE product_id=$1",[productId]);
  for(const conversion of conversions) await client.query("INSERT INTO product_unit_conversions(product_id,unit_id,factor_to_base) VALUES($1,$2,$3)",[productId,conversion.unitId,conversion.factor]);
}

export async function createProduct(req,res){
  const {data,error}=validateProduct(req.body);if(error)return res.status(400).json({message:error});
  const client=await connection.connect();
  try{await client.query("BEGIN");const result=await client.query(`INSERT INTO products(sku,name,description,product_description,category_id,brand,collection,tile_size,finish,color,product_image_url,hsn_code,tax_rate,tax_inclusive,base_unit_id,purchase_unit_id,sales_unit_id,default_purchase_price,default_selling_price,reorder_threshold,is_active,gst_supply_classification,gst_classification_reference)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,[data.sku,data.name,data.description||null,data.productDescription||null,data.categoryId,data.brand||null,data.collection||null,data.tileSize||null,data.finish||null,data.color||null,data.productImageUrl||null,data.hsnCode||null,data.taxRate,data.taxInclusive,data.baseUnitId,data.purchaseUnitId,data.salesUnitId,data.defaultPurchasePrice,data.defaultSellingPrice,data.reorderThreshold,data.isActive,data.supplyClassification,data.classificationReference||null]);
    await saveConversions(client,result.rows[0].id,data.conversions);await client.query("COMMIT");return getProduct({...req,params:{id:result.rows[0].id},query:{}},res);
  }catch(error){await client.query("ROLLBACK").catch(()=>{});if(error.code==="23505")return res.status(409).json({message:"A product with this SKU already exists"});if(error.code==="23503")return res.status(400).json({message:"Selected category or unit does not exist"});if(error.code==="23514")return res.status(400).json({message:error.message});console.error("Unable to create product:",error.message);res.status(500).json({message:"Unable to create product"});}finally{client.release();}
}

export async function updateProduct(req,res){
  if(!idOk(req.params.id))return res.status(400).json({message:"Invalid product ID"});const {data,error}=validateProduct(req.body);if(error)return res.status(400).json({message:error});const client=await connection.connect();
  try{await client.query("BEGIN");const result=await client.query(`UPDATE products SET sku=$2,name=$3,description=$4,product_description=$5,category_id=$6,brand=$7,collection=$8,tile_size=$9,finish=$10,color=$11,product_image_url=$12,hsn_code=$13,tax_rate=$14,tax_inclusive=$15,base_unit_id=$16,purchase_unit_id=$17,sales_unit_id=$18,default_purchase_price=$19,default_selling_price=$20,reorder_threshold=$21,is_active=$22,gst_supply_classification=COALESCE($23,gst_supply_classification),gst_classification_reference=CASE WHEN $23 IS NULL THEN gst_classification_reference ELSE $24 END,updated_at=now() WHERE id=$1 RETURNING id`,[req.params.id,data.sku,data.name,data.description||null,data.productDescription||null,data.categoryId,data.brand||null,data.collection||null,data.tileSize||null,data.finish||null,data.color||null,data.productImageUrl||null,data.hsnCode||null,data.taxRate,data.taxInclusive,data.baseUnitId,data.purchaseUnitId,data.salesUnitId,data.defaultPurchasePrice,data.defaultSellingPrice,data.reorderThreshold,data.isActive,req.body.supplyClassification===undefined?null:data.supplyClassification,data.classificationReference||null]);
    if(!result.rowCount){await client.query("ROLLBACK");return res.status(404).json({message:"Product not found"});}await saveConversions(client,req.params.id,data.conversions);await client.query("COMMIT");return getProduct({...req,params:{id:req.params.id},query:{}},res);
  }catch(error){await client.query("ROLLBACK").catch(()=>{});if(error.code==="23505")return res.status(409).json({message:"A product with this SKU already exists"});if(error.code==="23503")return res.status(400).json({message:"Selected category or unit does not exist"});if(error.code==="23514")return res.status(400).json({message:error.message});console.error("Unable to update product:",error.message);res.status(500).json({message:"Unable to update product"});}finally{client.release();}
}

export async function setProductActive(req,res){if(!idOk(req.params.id)||typeof req.body?.isActive!=="boolean")return res.status(400).json({message:"Valid product ID and isActive boolean are required"});try{const result=await connection.query("UPDATE products SET is_active=$2,updated_at=now() WHERE id=$1 RETURNING id,is_active",[req.params.id,req.body.isActive]);if(!result.rowCount)return res.status(404).json({message:"Product not found"});res.json(result.rows[0]);}catch(error){console.error("Unable to change product status:",error.message);res.status(500).json({message:"Unable to change product status"});}}

export async function listCategories(req,res){try{const rows=await connection.query(`SELECT id,name,description,is_active,created_at,updated_at FROM product_categories ${isAdmin(req)?"":"WHERE is_active=TRUE"} ORDER BY name,id`);res.json(rows.rows);}catch(error){console.error("Unable to list categories:",error.message);res.status(500).json({message:"Unable to load categories"});}}
export async function saveCategory(req,res){const id=req.params.id;const name=text(req.body?.name);const description=text(req.body?.description);if(id&&!idOk(id))return res.status(400).json({message:"Invalid category ID"});if(!name||name.length>100||description.length>500)return res.status(400).json({message:"Category name is required (100 characters max); description is limited to 500 characters"});try{const query=id?"UPDATE product_categories SET name=$2,description=$3,updated_at=now() WHERE id=$1 RETURNING *":"INSERT INTO product_categories(name,description) VALUES($1,$2) RETURNING *";const values=id?[id,name,description||null]:[name,description||null];const result=await connection.query(query,values);if(!result.rowCount)return res.status(404).json({message:"Category not found"});res.status(id?200:201).json(result.rows[0]);}catch(error){if(error.code==="23505")return res.status(409).json({message:"A category with this name already exists"});console.error("Unable to save category:",error.message);res.status(500).json({message:"Unable to save category"});}}
export async function setCategoryActive(req,res){if(!idOk(req.params.id)||typeof req.body?.isActive!=="boolean")return res.status(400).json({message:"Valid category ID and isActive boolean are required"});try{const result=await connection.query("UPDATE product_categories SET is_active=$2,updated_at=now() WHERE id=$1 RETURNING *",[req.params.id,req.body.isActive]);if(!result.rowCount)return res.status(404).json({message:"Category not found"});res.json(result.rows[0]);}catch(error){res.status(500).json({message:"Unable to change category status"});}}

export async function listUnits(req,res){try{const result=await connection.query(`SELECT id,code,name,decimal_places,is_active,created_at,updated_at FROM units_of_measure ${isAdmin(req)?"":"WHERE is_active=TRUE"} ORDER BY name,id`);res.json(result.rows);}catch(error){console.error("Unable to list units:",error.message);res.status(500).json({message:"Unable to load units"});}}
export async function saveUnit(req,res){const id=req.params.id;const code=text(req.body?.code).toUpperCase();const name=text(req.body?.name);const decimals=Number(req.body?.decimalPlaces??4);if(id&&!idOk(id))return res.status(400).json({message:"Invalid unit ID"});if(!/^[A-Z0-9_-]{1,24}$/.test(code)||!name||name.length>80||!Number.isInteger(decimals)||decimals<0||decimals>6)return res.status(400).json({message:"Provide a valid unit code, name, and decimal precision from 0 to 6"});try{const result=id?await connection.query("UPDATE units_of_measure SET code=$2,name=$3,decimal_places=$4,updated_at=now() WHERE id=$1 RETURNING *",[id,code,name,decimals]):await connection.query("INSERT INTO units_of_measure(code,name,decimal_places) VALUES($1,$2,$3) RETURNING *",[code,name,decimals]);if(!result.rowCount)return res.status(404).json({message:"Unit not found"});res.status(id?200:201).json(result.rows[0]);}catch(error){if(error.code==="23505")return res.status(409).json({message:"A unit with this code already exists"});console.error("Unable to save unit:",error.message);res.status(500).json({message:"Unable to save unit"});}}
export async function setUnitActive(req,res){if(!idOk(req.params.id)||typeof req.body?.isActive!=="boolean")return res.status(400).json({message:"Valid unit ID and isActive boolean are required"});try{if(!req.body.isActive){const used=await connection.query(`SELECT 1 FROM products WHERE base_unit_id=$1 OR purchase_unit_id=$1 OR sales_unit_id=$1 UNION ALL SELECT 1 FROM product_unit_conversions WHERE unit_id=$1 LIMIT 1`,[req.params.id]);if(used.rowCount)return res.status(409).json({message:"This unit is used by products and cannot be deactivated"});}const result=await connection.query("UPDATE units_of_measure SET is_active=$2,updated_at=now() WHERE id=$1 RETURNING *",[req.params.id,req.body.isActive]);if(!result.rowCount)return res.status(404).json({message:"Unit not found"});res.json(result.rows[0]);}catch(error){res.status(500).json({message:"Unable to change unit status"});}}

export async function getProductConversions(req,res){if(!idOk(req.params.id))return res.status(400).json({message:"Invalid product ID"});try{const result=await connection.query(`SELECT c.id,c.product_id,c.unit_id,u.code,u.name,c.factor_to_base FROM product_unit_conversions c JOIN units_of_measure u ON u.id=c.unit_id WHERE c.product_id=$1 ORDER BY u.name`,[req.params.id]);res.json(result.rows);}catch(error){res.status(500).json({message:"Unable to load product conversions"});}}

export async function getProductPrice(req, res) {
  const { id } = req.params;
  const direction = req.query.direction === "purchase" ? "purchase" : "sales";
  const requestedUnitId = req.query.unitId;
  if (!idOk(id)) return res.status(400).json({ message: "Invalid product ID" });
  if (requestedUnitId !== undefined && !idOk(requestedUnitId)) return res.status(400).json({ message: "Invalid unit ID" });

  try {
    const result = await connection.query(
      `SELECT p.id,p.base_unit_id,p.purchase_unit_id,p.sales_unit_id,
        CASE WHEN $2='purchase' THEN p.default_purchase_price ELSE p.default_selling_price END AS price,
        COALESCE($3::bigint, CASE WHEN $2='purchase' THEN p.purchase_unit_id ELSE p.sales_unit_id END, p.base_unit_id) AS target_unit_id,
        base.code AS base_unit_code,base.name AS base_unit_name,
        target.code AS target_unit_code,target.name AS target_unit_name,
        (CASE WHEN COALESCE($3::bigint, CASE WHEN $2='purchase' THEN p.purchase_unit_id ELSE p.sales_unit_id END, p.base_unit_id)=p.base_unit_id THEN 1::numeric
          ELSE target_conversion.factor_to_base END) AS target_factor,
        (CASE WHEN COALESCE(CASE WHEN $2='purchase' THEN p.purchase_unit_id ELSE p.sales_unit_id END,p.base_unit_id)=p.base_unit_id THEN 1::numeric
          ELSE default_conversion.factor_to_base END) AS default_factor
       FROM products p JOIN units_of_measure base ON base.id=p.base_unit_id
       LEFT JOIN units_of_measure target ON target.id=COALESCE($3::bigint,CASE WHEN $2='purchase' THEN p.purchase_unit_id ELSE p.sales_unit_id END,p.base_unit_id)
       LEFT JOIN product_unit_conversions target_conversion ON target_conversion.product_id=p.id AND target_conversion.unit_id=target.id
       LEFT JOIN product_unit_conversions default_conversion ON default_conversion.product_id=p.id AND default_conversion.unit_id=CASE WHEN $2='purchase' THEN p.purchase_unit_id ELSE p.sales_unit_id END
       WHERE p.id=$1`, [id, direction, requestedUnitId || null]
    );
    if (!result.rowCount) return res.status(404).json({ message: "Product not found" });
    const row = result.rows[0];
    if (row.price === null) return res.status(404).json({ message: "No default price is configured for this product" });
    if (row.target_factor === null || row.default_factor === null) return res.status(400).json({ message: "No conversion is configured for the requested unit" });
    if (!row.target_unit_code) return res.status(400).json({ message: "Requested unit does not exist" });
    const allowed = [row.base_unit_id, row.purchase_unit_id, row.sales_unit_id].filter(Boolean).map(String);
    if (!allowed.includes(String(row.target_unit_id))) {
      const configured = await connection.query("SELECT 1 FROM product_unit_conversions WHERE product_id=$1 AND unit_id=$2", [id, row.target_unit_id]);
      if (!configured.rowCount) return res.status(400).json({ message: "Unit is not configured for this product" });
    }
    const converted = await connection.query("SELECT ($1::numeric * $2::numeric / $3::numeric)::numeric(18,4) AS price", [row.price, row.target_factor, row.default_factor]);
    return res.json({ productId: id, direction, price: converted.rows[0].price, unit: { id: row.target_unit_id, code: row.target_unit_code, name: row.target_unit_name }, defaultUnitId: direction === "purchase" ? row.purchase_unit_id || row.base_unit_id : row.sales_unit_id || row.base_unit_id, baseUnit: { id: row.base_unit_id, code: row.base_unit_code, name: row.base_unit_name } });
  } catch (error) {
    console.error("Unable to load product price:", error.message);
    return res.status(500).json({ message: "Unable to load product price" });
  }
}
