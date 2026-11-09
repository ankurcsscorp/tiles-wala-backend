import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateInvoiceNumber, invoicePeriod, invoicePeriodRange, suggestInvoicePrefix } from "./invoiceNumbering.js";

test("formats store invoice numbers by Indian financial year with a four digit minimum", async () => {
  assert.deepEqual(invoicePeriod("2026-03-31", "yearly"), { key: "2025-2026", label: "25" });
  assert.deepEqual(invoicePeriod("2026-04-01", "yearly"), { key: "2026-2027", label: "26" });
  assert.deepEqual(invoicePeriod("2026-10-01", "monthly"), { key: "2026-10", label: "26-10" });
  assert.deepEqual(invoicePeriod("2026-10-01", "never"), { key: "all", label: "" });
  assert.deepEqual(invoicePeriodRange("2026-03-31", "yearly"), { start: "2025-04-01", end: "2026-04-01" });
  const calls=[];
  const db={query:async(sql)=>{calls.push(sql);if(sql.includes("SELECT next_number"))return {rows:[{next_number:2}]};return {rows:[]};}};
  assert.equal(await allocateInvoiceNumber(db,{storeId:3,documentType:"sale",series:"AA",date:"2026-04-02",policy:"yearly"}),"AA26-0002");
  assert.match(calls[0],/ON CONFLICT/);
  assert.match(calls[1],/FOR UPDATE/);
});

test("number width expands naturally and store codes are suggested from names", async () => {
  const db={query:async(sql)=>sql.includes("SELECT next_number")?{rows:[{next_number:10000}]}:{rows:[]}};
  assert.equal(await allocateInvoiceNumber(db,{storeId:3,documentType:"sale",series:"PT",date:"2026-04-02",policy:"never"}),"PT-10000");
  assert.equal(suggestInvoicePrefix("A & A Home Decor"),"AA");
  assert.equal(suggestInvoicePrefix("Partusha Tiles"),"PT");
});
