import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import {
  createSupplier, getSupplier, getSupplierBalance, getSupplierInvoices,
  getSupplierLedger, getSupplierPayments, listSuppliers, searchSuppliers,
  setSupplierActive, updateSupplier,
} from "../controllers/suppliers.js";

const router=express.Router();
router.use(requireAuth,requireUserTypes("Admin","Salesperson"));
router.get("/search",searchSuppliers);
router.get("/",listSuppliers);
router.post("/",createSupplier);
router.get("/:id/invoices",getSupplierInvoices);
router.get("/:id/payments",getSupplierPayments);
router.get("/:id/ledger",getSupplierLedger);
router.get("/:id/balance",getSupplierBalance);
router.patch("/:id/status",setSupplierActive);
router.get("/:id",getSupplier);
router.put("/:id",updateSupplier);
export default router;
