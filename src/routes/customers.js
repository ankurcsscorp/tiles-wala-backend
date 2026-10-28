import {partyLedger,printLedger,downloadLedgerPdf} from '../controllers/financialReports.js';
import {requirePermission,requireAnyPermission} from '../middleware/permissions.js';
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  createCustomer, getCustomer, getCustomerBalance, getCustomerInvoices,
  getCustomerLedger, getCustomerPayments, listCustomers, searchCustomers,
  setCustomerActive, updateCustomer,
} from "../controllers/customers.js";

const router = express.Router();
router.use(requireAuth,(req,res,next)=>req.method==='GET'&&req.path==='/search'?requireAnyPermission('customers.view','sales.view','returns.view','reports.view')(req,res,next):requirePermission('customers')(req,res,next));
router.get("/search", searchCustomers);
router.get("/", listCustomers);
router.post("/", createCustomer);
router.get("/:id/invoices", getCustomerInvoices);
router.get("/:id/payments", getCustomerPayments);
router.get("/:id/ledger/report",(req,res)=>{req.params.partyType='customer';return partyLedger(req,res);});
router.get("/:id/ledger/print",(req,res)=>{req.params.partyType='customer';return printLedger(req,res);});
router.get("/:id/ledger/pdf",(req,res)=>{req.params.partyType='customer';return downloadLedgerPdf(req,res);});
router.get("/:id/ledger", getCustomerLedger);
router.get("/:id/balance", getCustomerBalance);
router.patch("/:id/status", setCustomerActive);
router.get("/:id", getCustomer);
router.put("/:id", updateCustomer);

export default router;
