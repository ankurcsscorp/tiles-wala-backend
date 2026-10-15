import express from "express";
import {
	createProductConfig,
	createSalesBonusRecord,
	getManageableProductCatalog,
	getProductCatalog,
	updateProductConfig,
} from "../controllers/salesBonus.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth, requireUserTypes("Admin"));
router.get("/products/manage", getManageableProductCatalog);
router.post("/products", createProductConfig);
router.put("/products/:id", updateProductConfig);
router.get("/products", getProductCatalog);
router.post("/records", createSalesBonusRecord);

export default router;
