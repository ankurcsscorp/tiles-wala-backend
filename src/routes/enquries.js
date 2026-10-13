import express from "express";
import { getEnquiries, createEnquiry, updateEnquiry } from "../controllers/enquries.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const router = express.Router();

router.get(
  "/enquiries",
  requireAuth,
  requireUserTypes("Admin", "Salesperson"),
  getEnquiries
);
router.post("/enquiries", createEnquiry);
router.patch(
  "/enquiries/:id",
  requireAuth,
  requireUserTypes("Admin", "Salesperson"),
  updateEnquiry
);
export default router;