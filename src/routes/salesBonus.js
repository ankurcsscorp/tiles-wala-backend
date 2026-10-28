import {requirePermission} from '../middleware/permissions.js';
import express from "express";
import {
	createProductConfig,
	createSalesBonusRecord,
	getManageableProductCatalog,
	getProductCatalog,
	getSalesBonusRecords,
	getTopSeller,
	updateSalesBonusPayment,
	updateProductConfig,
} from "../controllers/salesBonus.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const router = express.Router();

router.get("/products/manage", requireAuth, requireUserTypes("Admin"), getManageableProductCatalog);
router.post("/products", requireAuth, requireUserTypes("Admin"), createProductConfig);
router.put("/products/:id", requireAuth, requireUserTypes("Admin"), updateProductConfig);
router.get("/products", requireAuth, requireUserTypes("Admin"), getProductCatalog);
router.get("/records", requireAuth, requirePermission('bonus','view'), getSalesBonusRecords);
router.get("/top-seller", requireAuth, requirePermission('bonus','view'), getTopSeller);
router.patch("/records/:id/payment", requireAuth, requireUserTypes("Admin"), updateSalesBonusPayment);
router.post("/records", requireAuth, requireUserTypes("Admin"), createSalesBonusRecord);

export default router;
