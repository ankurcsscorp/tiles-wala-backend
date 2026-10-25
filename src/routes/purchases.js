import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import {
  createPurchaseDraft, listPurchases, getPurchase, getPurchaseItems, updatePurchaseDraft,
  postPurchaseInvoice, cancelPurchase, reversePurchase, receivePurchaseGoods,
  purchaseReports, recordSupplierPayment,
  reverseGoodsReceipt,
} from "../controllers/purchases.js";

const router=express.Router();
router.use(requireAuth,requireUserTypes("Admin","Salesperson"));
router.get("/reports",purchaseReports);
router.post("/payments",recordSupplierPayment);
router.get("/",listPurchases);
router.post("/",createPurchaseDraft);
router.get("/:id/items",getPurchaseItems);
router.get("/:id",getPurchase);
router.put("/:id",updatePurchaseDraft);
router.post("/:id/post",postPurchaseInvoice);
router.post("/:id/receipts",receivePurchaseGoods);
router.post("/:id/receipts/:receiptId/reverse",reverseGoodsReceipt);
router.post("/:id/cancel",cancelPurchase);
router.post("/:id/reverse",reversePurchase);
export default router;
