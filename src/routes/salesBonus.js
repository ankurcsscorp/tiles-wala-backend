import express from "express";
import {
	createProductConfig,
	createSalesBonusRecord,
	getManageableProductCatalog,
	getProductCatalog,
	getSalesBonusRecords,
	updateSalesBonusPayment,
	updateProductConfig,
} from "../controllers/salesBonus.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const router = express.Router();

router.get("/products/manage", requireAuth, requireUserTypes("Admin"), getManageableProductCatalog);
router.post("/products", requireAuth, requireUserTypes("Admin"), createProductConfig);
router.put("/products/:id", requireAuth, requireUserTypes("Admin"), updateProductConfig);
router.get("/products", requireAuth, requireUserTypes("Admin"), getProductCatalog);
router.get("/records", requireAuth, getSalesBonusRecords);
router.patch("/records/:id/payment", requireAuth, requireUserTypes("Admin"), updateSalesBonusPayment);
router.post("/records", requireAuth, requireUserTypes("Admin"), createSalesBonusRecord);

export default router;
