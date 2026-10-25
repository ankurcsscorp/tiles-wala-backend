import express from "express";
import { requireAuth,requireUserTypes } from "../middleware/auth.js";
import { cancelTransfer,createTransfer,dispatchTransfer,getTransfer,listTransfers,receiveTransfer,transferHistory,updateTransferDraft } from "../controllers/transfers.js";

const router=express.Router();
router.use(requireAuth,requireUserTypes("Admin","Salesperson"));
router.get("/",listTransfers);
router.post("/",createTransfer);
router.get("/:id/history",transferHistory);
router.get("/:id",getTransfer);
router.put("/:id",updateTransferDraft);
router.post("/:id/dispatch",dispatchTransfer);
router.post("/:id/receive",receiveTransfer);
router.post("/:id/cancel",cancelTransfer);
export default router;
