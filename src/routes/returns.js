import express from "express";
import { requireAuth,requireUserTypes } from "../middleware/auth.js";
import { approveSalesReturn,createReturn,getReturnById,listReturns,postReturn } from "../controllers/returns.js";

const router=express.Router();
router.use(requireAuth,requireUserTypes("Admin","Salesperson"));
router.get("/",listReturns);
router.get("/:id",getReturnById);
router.post("/:type",createReturn);
router.post("/sales/:id/approve",approveSalesReturn);
router.post("/:type/:id/post",postReturn);
export default router;
