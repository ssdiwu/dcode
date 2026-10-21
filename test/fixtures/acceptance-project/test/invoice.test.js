import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal } from "../src/invoice.js";

test("无折扣时含税总额按分取整", () => {
  assert.equal(invoiceTotal([{ unitPrice: 10.01, quantity: 1 }], { taxRate: 0 }), 10.01);
});

test("折扣后含税总额按分取整", () => {
  const total = invoiceTotal(
    [{ unitPrice: 99.99, quantity: 3 }],
    { discountRate: 0.1, taxRate: 0.13 },
  );
  assert.equal(total, 305.07);
});
