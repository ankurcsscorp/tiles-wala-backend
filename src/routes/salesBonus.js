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
  getBonusManagementRecords,
  approveSalesBonus,
  holdSalesBonus,
  getSalesBonusPaymentHistory,
  getSalesBonusManagementDetail,
  saveCatalogProductBonusRule,
} from "../controllers/salesBonus.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const router = express.Router();

router.get("/products/manage", requireAuth, requireUserTypes("Admin"), getManageableProductCatalog);
router.put("/products/catalog/:productId", requireAuth, requireUserTypes("Admin"), saveCatalogProductBonusRule);
router.post("/products", requireAuth, requireUserTypes("Admin"), createProductConfig);
router.put("/products/:id", requireAuth, requireUserTypes("Admin"), updateProductConfig);
router.get("/products", requireAuth, requireUserTypes("Admin"), getProductCatalog);
router.get("/records", requireAuth, requirePermission('bonus','view'), getSalesBonusRecords);
router.get("/manage/records", requireAuth, requireUserTypes("Admin"), getBonusManagementRecords);
router.get("/manage/records/:id", requireAuth, requireUserTypes("Admin"), getSalesBonusManagementDetail);
router.get("/manage/records/:id/payments", requireAuth, requireUserTypes("Admin"), getSalesBonusPaymentHistory);
router.post("/manage/records/:id/approve", requireAuth, requireUserTypes("Admin"), approveSalesBonus);
router.post("/manage/records/:id/hold", requireAuth, requireUserTypes("Admin"), holdSalesBonus);
router.get("/top-seller", requireAuth, requirePermission('bonus','view'), getTopSeller);
router.patch("/records/:id/payment", requireAuth, requireUserTypes("Admin"), updateSalesBonusPayment);
router.post("/records", requireAuth, requireUserTypes("Admin"), createSalesBonusRecord);

export default router;
