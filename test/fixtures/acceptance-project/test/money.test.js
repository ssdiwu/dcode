import { test } from "node:test";
import assert from "node:assert/strict";
import { roundToCents } from "../src/money.js";

test("已经是整分的金额保持不变", () => {
  assert.equal(roundToCents(10), 10);
  assert.equal(roundToCents(1.23), 1.23);
});

test("不足一分时向下舍入", () => {
  assert.equal(roundToCents(1.234), 1.23);
});

test("超过半分时进位到下一分", () => {
  assert.equal(roundToCents(1.236), 1.24);
  assert.equal(roundToCents(10.01), 10.01);
});
