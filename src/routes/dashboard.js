import {requirePermission} from '../middleware/permissions.js';
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { dashboardReport, dashboardSummary } from "../controllers/dashboard.js";

const router = express.Router();
router.use(requireAuth, requirePermission('dashboard'));
router.get("/", dashboardSummary);
router.get("/reports", dashboardReport);
export default router;
