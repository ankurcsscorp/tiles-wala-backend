import express from "express";
import { requireAuth,requireUserTypes } from "../middleware/auth.js";
import { agingReport,exportLedger,outstandingReport,outstandingSummary,partyLedger,transactionDetails } from "../controllers/financialReports.js";

const router=express.Router();
router.use(requireAuth,requireUserTypes("Admin","Salesperson"));
router.get("/summary",outstandingSummary);
router.get("/outstanding",outstandingReport);
router.get("/aging",agingReport);
router.get("/ledger/:partyType/:id/export",exportLedger);
router.get("/ledger/:partyType/:id",partyLedger);
router.get("/transactions/:type/:id",transactionDetails);
export default router;
