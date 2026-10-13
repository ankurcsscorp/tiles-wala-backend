import express from "express";
import { getEnquiries , createEnquiry} from "../controllers/enquries.js";

const router = express.Router();

router.get("/enquiries", getEnquiries);
router.post("/enquiries", createEnquiry);
export default router;