import express from "express";
import rateLimit from "express-rate-limit";
import { login, signup } from "../controllers/auth.js";

const router = express.Router();

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Too many authentication attempts. Try again later." },
  })
);

router.post("/signup", signup);
router.post("/login", login);

export default router;