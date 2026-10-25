import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import {
  inventoryList, inventorySummary, productStock, movementHistory,
  lowStock, valuation, reconciliation, createAdjustment,
} from "../controllers/inventory.js";

const router = express.Router();
router.use(requireAuth, requireUserTypes("Admin", "Salesperson"));
router.get("/", inventoryList);
router.get("/summary", inventorySummary);
router.get("/low-stock", lowStock);
router.get("/valuation", valuation);
router.get("/reconciliation", reconciliation);
router.get("/movements", movementHistory);
router.get("/products/:productId", productStock);
router.post("/adjustments", requireUserTypes("Admin", "Salesperson"), createAdjustment);
export default router;
