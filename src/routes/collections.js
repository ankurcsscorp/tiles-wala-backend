import express from "express";
import {
  createCollection,
  getCollections,
  updateCollection,
  updateFeaturedCollection,
} from "../controllers/collections.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const router = express.Router();

router.get("/", getCollections);
router.post("/", requireAuth, requireUserTypes("Admin"), createCollection);
router.put("/featured/:featuredId", requireAuth, requireUserTypes("Admin"), updateFeaturedCollection);
router.put("/:id", requireAuth, requireUserTypes("Admin"), updateCollection);

export default router;
