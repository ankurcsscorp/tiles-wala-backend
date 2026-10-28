import {requirePermission} from '../middleware/permissions.js';
import { getInvoiceSettings, putInvoiceSettings } from "../controllers/invoiceSettings.js";
import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import {
  createStore, getNumberingConfig, getStore, getStoreSettings, listAssignments,
  listStores, removeAssignment, saveAssignment, searchAssignableUsers, setStoreActive, updateStore,
  updateStoreSettings,
} from "../controllers/stores.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", listStores);
router.get("/users/search", requireUserTypes("Admin"), searchAssignableUsers);
router.post("/", requireUserTypes("Admin"), createStore);
router.get("/:id/invoice-settings", (req,res,next)=>req.user.permissions?.['sales.view']||req.user.permissions?.['purchases.view']?next():requirePermission('invoice_settings','view')(req,res,next), getInvoiceSettings);
router.put("/:id/invoice-settings", requirePermission("invoice_settings","manage"), putInvoiceSettings);
router.get("/:id", getStore);
router.put("/:id", requireUserTypes("Admin"), updateStore);
router.patch("/:id/status", requireUserTypes("Admin"), setStoreActive);
router.get("/:id/settings", getStoreSettings);
router.put("/:id/settings", requireUserTypes("Admin"), updateStoreSettings);
router.get("/:id/numbering", getNumberingConfig);
router.get("/:id/assignments", requireUserTypes("Admin"), listAssignments);
router.post("/:id/assignments", requireUserTypes("Admin"), saveAssignment);
router.delete("/assignments/:assignmentId", requireUserTypes("Admin"), removeAssignment);

export default router;
