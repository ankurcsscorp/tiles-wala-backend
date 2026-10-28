import {requirePermission} from '../middleware/permissions.js';
import express from "express";
import {
  createCollection,
  getCollections,
  updateCollection,
  updateFeaturedCollection,
} from "../controllers/collections.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/", getCollections);
router.post("/", requireAuth, requirePermission('collections','manage'), createCollection);
router.put("/featured/:featuredId", requireAuth, requirePermission('collections','manage'), updateFeaturedCollection);
router.put("/:id", requireAuth, requirePermission('collections','manage'), updateCollection);

export default router;
