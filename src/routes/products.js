import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import {
  createProduct, getProduct, getProductConversions, getProductPrice, listCategories,
  listProducts, listUnits, saveCategory, saveUnit, setCategoryActive,
  setProductActive, setUnitActive, updateProduct,
} from "../controllers/products.js";

const router=express.Router();
router.use(requireAuth);
router.get("/categories",listCategories);
router.post("/categories",requireUserTypes("Admin"),saveCategory);
router.put("/categories/:id",requireUserTypes("Admin"),saveCategory);
router.patch("/categories/:id/status",requireUserTypes("Admin"),setCategoryActive);
router.get("/units",listUnits);
router.post("/units",requireUserTypes("Admin"),saveUnit);
router.put("/units/:id",requireUserTypes("Admin"),saveUnit);
router.patch("/units/:id/status",requireUserTypes("Admin"),setUnitActive);
router.get("/search",listProducts);
router.get("/",listProducts);
router.post("/",requireUserTypes("Admin"),createProduct);
router.get("/:id/price",getProductPrice);
router.get("/:id/conversions",getProductConversions);
router.patch("/:id/status",requireUserTypes("Admin"),setProductActive);
router.get("/:id",getProduct);
router.put("/:id",requireUserTypes("Admin"),updateProduct);

export default router;
