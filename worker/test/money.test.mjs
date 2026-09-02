import assert from "node:assert/strict";
import test from "node:test";
import { calculateServerQuote } from "../src/money.js";

const rates={"USDT/RUB":{sellRate:103,buyRate:87.3},"BTC/USDT":{close:60000},"ETH/USDT":{close:3000}};
test("server quote uses fixed-point arithmetic and currency precision",()=>{
  assert.deepEqual(calculateServerQuote({amount:"103",giveCurrency:"RUB",receiveCurrency:"USDT",rates}).outputAmount,"1.00");
  assert.equal(calculateServerQuote({amount:"1",giveCurrency:"BTC",receiveCurrency:"ETH",rates}).outputAmount,"20.000000");
  assert.equal(calculateServerQuote({amount:"1",giveCurrency:"USDT",receiveCurrency:"BTC",rates}).outputAmount,"0.00001666");
});
test("unsupported directions are deliberately not auto-calculated",()=>assert.equal(calculateServerQuote({amount:"100",giveCurrency:"KZT",receiveCurrency:"USDT",rates}),null));
