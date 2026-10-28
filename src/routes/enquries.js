import {requirePermission} from '../middleware/permissions.js';
import express from "express";
import { getEnquiries, createEnquiry, updateEnquiry } from "../controllers/enquries.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get(
  "/enquiries",
  requireAuth,
  requirePermission('enquiries'),
  getEnquiries
);
router.post("/enquiries", createEnquiry);
router.patch(
  "/enquiries/:id",
  requireAuth,
  requirePermission('enquiries'),
  updateEnquiry
);
export default router;