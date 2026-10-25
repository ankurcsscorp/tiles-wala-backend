import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import { dashboardReport, dashboardSummary } from "../controllers/dashboard.js";

const router = express.Router();
router.use(requireAuth, requireUserTypes("Admin", "Salesperson"));
router.get("/", dashboardSummary);
router.get("/reports", dashboardReport);
export default router;
