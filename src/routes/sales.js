import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import { cancelSales, createSalesDraft, finalizeSales, getSales, listSales, recordSalesPayment, reverseSales, updateSalesDraft } from "../controllers/sales.js";

const router=express.Router();
router.use(requireAuth,requireUserTypes("Admin","Salesperson"));
router.get("/",listSales);
router.post("/",createSalesDraft);
router.get("/:id",getSales);
router.put("/:id",updateSalesDraft);
router.post("/:id/finalize",finalizeSales);
router.post("/:id/payments",recordSalesPayment);
router.post("/:id/cancel",cancelSales);
router.post("/:id/reverse",reverseSales);
export default router;
