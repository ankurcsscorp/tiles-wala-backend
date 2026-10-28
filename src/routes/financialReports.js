import {requirePermission} from '../middleware/permissions.js';
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { agingReport,exportLedger,printLedger,downloadLedgerPdf,outstandingReport,outstandingSummary,partyLedger,transactionDetails } from "../controllers/financialReports.js";

const router=express.Router();
router.use(requireAuth,requirePermission('reports'));
router.get("/summary",outstandingSummary);
router.get("/outstanding",outstandingReport);
router.get("/aging",agingReport);
router.get("/ledger/:partyType/:id/export",exportLedger);
router.get("/ledger/:partyType/:id/print",printLedger);
router.get("/ledger/:partyType/:id/pdf",downloadLedgerPdf);
router.get("/ledger/:partyType/:id",partyLedger);
router.get("/transactions/:type/:id",transactionDetails);
export default router;
