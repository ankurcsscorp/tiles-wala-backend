import {requirePermission,requireAnyPermission} from '../middleware/permissions.js';
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  createProduct, getProduct, getProductConversions, getProductPrice, listCategories,
  listProducts, listUnits, saveCategory, saveUnit, setCategoryActive,
  setProductActive, setUnitActive, updateProduct,
} from "../controllers/products.js";

const router=express.Router();
router.use(requireAuth,(req,res,next)=>req.method==='GET'?requireAnyPermission('products.view','sales.view','purchases.view','inventory.view','transfers.view','returns.view')(req,res,next):requirePermission('products','manage')(req,res,next));
router.get("/categories",listCategories);
router.post("/categories",requirePermission('products','manage'),saveCategory);
router.put("/categories/:id",requirePermission('products','manage'),saveCategory);
router.patch("/categories/:id/status",requirePermission('products','manage'),setCategoryActive);
router.get("/units",listUnits);
router.post("/units",requirePermission('products','manage'),saveUnit);
router.put("/units/:id",requirePermission('products','manage'),saveUnit);
router.patch("/units/:id/status",requirePermission('products','manage'),setUnitActive);
router.get("/search",listProducts);
router.get("/",listProducts);
router.post("/",requirePermission('products','manage'),createProduct);
router.get("/:id/price",getProductPrice);
router.get("/:id/conversions",getProductConversions);
router.patch("/:id/status",requirePermission('products','manage'),setProductActive);
router.get("/:id",getProduct);
router.put("/:id",requirePermission('products','manage'),updateProduct);

export default router;
