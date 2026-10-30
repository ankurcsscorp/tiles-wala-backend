import {requirePermission} from '../middleware/permissions.js';
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { cancelSales, createSalesDraft, finalizeSales, getSales, listSales, recordSalesPayment, reverseSales, salesBonusPreview, updateSalesDraft } from "../controllers/sales.js";

const router=express.Router();
router.use(requireAuth,requirePermission('sales'));
router.get("/",listSales);
router.post("/",createSalesDraft);
router.post("/bonus-preview",salesBonusPreview);
router.get("/:id",getSales);
router.put("/:id",updateSalesDraft);
router.post("/:id/finalize",finalizeSales);
router.post("/:id/payments",requirePermission("payments","manage"),recordSalesPayment);
router.post("/:id/cancel",cancelSales);
router.post("/:id/reverse",reverseSales);
export default router;
