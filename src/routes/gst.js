import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireUserTypes } from '../middleware/auth.js';
import { lookupGSTController, requireGSTAccess } from '../controllers/gst.js';
const router = express.Router();
router.use((req,res,next)=>{
  const send=res.json.bind(res);
  res.json=(body)=>send(res.statusCode>=400?{success:false,code:body.code||(res.statusCode===401?'GST_UNAUTHENTICATED':'GST_FORBIDDEN'),...body}:body);
  next();
});
router.use(requireAuth, requireUserTypes('Admin', 'Salesperson'));
router.use(rateLimit({ windowMs: 60000, limit: 10, keyGenerator: (req) => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, code: 'GST_RATE_LIMITED', message: 'Too many GST lookups. Please try again in a minute.' } }));
router.get('/lookup/:gstin', requireGSTAccess, lookupGSTController);
router.use((error,req,res,next)=>{res.status(503).json({success:false,code:'GST_UNAVAILABLE',message:'Unable to complete GST lookup. Please retry later.'});});
export default router;
