import {partyLedger,printLedger,downloadLedgerPdf} from '../controllers/financialReports.js';
import {requirePermission,requireAnyPermission} from '../middleware/permissions.js';
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  createSupplier, getSupplier, getSupplierBalance, getSupplierInvoices,
  getSupplierLedger, getSupplierPayments, listSuppliers, searchSuppliers,
  setSupplierActive, updateSupplier,
} from "../controllers/suppliers.js";

const router=express.Router();
router.use(requireAuth,(req,res,next)=>req.method==='GET'&&req.path==='/search'?requireAnyPermission('suppliers.view','purchases.view','returns.view','reports.view')(req,res,next):requirePermission('suppliers')(req,res,next));
router.get("/search",searchSuppliers);
router.get("/",listSuppliers);
router.post("/",createSupplier);
router.get("/:id/invoices",getSupplierInvoices);
router.get("/:id/payments",getSupplierPayments);
router.get("/:id/ledger/report",(req,res)=>{req.params.partyType='supplier';return partyLedger(req,res);});
router.get("/:id/ledger/print",(req,res)=>{req.params.partyType='supplier';return printLedger(req,res);});
router.get("/:id/ledger/pdf",(req,res)=>{req.params.partyType='supplier';return downloadLedgerPdf(req,res);});
router.get("/:id/ledger",getSupplierLedger);
router.get("/:id/balance",getSupplierBalance);
router.patch("/:id/status",setSupplierActive);
router.get("/:id",getSupplier);
router.put("/:id",updateSupplier);
export default router;
