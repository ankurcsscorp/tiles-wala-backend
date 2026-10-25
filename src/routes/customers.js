import express from "express";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";
import {
  createCustomer, getCustomer, getCustomerBalance, getCustomerInvoices,
  getCustomerLedger, getCustomerPayments, listCustomers, searchCustomers,
  setCustomerActive, updateCustomer,
} from "../controllers/customers.js";

const router = express.Router();
router.use(requireAuth, requireUserTypes("Admin", "Salesperson"));
router.get("/search", searchCustomers);
router.get("/", listCustomers);
router.post("/", createCustomer);
router.get("/:id/invoices", getCustomerInvoices);
router.get("/:id/payments", getCustomerPayments);
router.get("/:id/ledger", getCustomerLedger);
router.get("/:id/balance", getCustomerBalance);
router.patch("/:id/status", setCustomerActive);
router.get("/:id", getCustomer);
router.put("/:id", updateCustomer);

export default router;
