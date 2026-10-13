import express from "express";
import { getEnquiries, createEnquiry, updateEnquiry } from "../controllers/enquries.js";

const router = express.Router();

router.get("/enquiries", getEnquiries);
router.post("/enquiries", createEnquiry);
router.patch("/enquiries/:id", updateEnquiry);
export default router;