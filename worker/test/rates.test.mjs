import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { getCurrentRates, normalizeRatePayload } from "../src/rates.js";

await import("../../rates-core.js");
const { calculateQuote, validatePayload } = globalThis.PapakhaRates;
const upstream = { code:0,message:"SUCCESS",isWorking:1,data:[
  {symbol:"USDT/RUB",askPrice:100,bidPrice:90},{symbol:"BTC/USDT",close:60000},{symbol:"ETH/USDT",close:3000},
] };
const cache = (initial = null) => { let value=initial; return { async get(){return value;},async put(_key,next){value=next;} }; };
const env = (cached = null) => ({ ALLOWED_ORIGINS:"https://jsmzj6dd9v-bit.github.io", RATE_PROVIDER_API_URL:"https://provider.example/rates", RATES_CACHE:cache(cached) });

test("normalizes required market pairs without public provider metadata", async () => {
  const updatedAt=new Date().toISOString();
  const raw=normalizeRatePayload(upstream,updatedAt);
  const original=globalThis.fetch; globalThis.fetch=async()=>new Response(JSON.stringify(upstream));
  try { const payload=await getCurrentRates(env(JSON.stringify(raw))); assert.equal(payload.rates["USDT/RUB"].sellRate,103);assert.equal(payload.rates["USDT/RUB"].buyRate,87.3);assert.equal(payload.source,undefined);assert.equal(payload.updatedAt,updatedAt);assert.equal(validatePayload(payload),true); }
  finally { globalThis.fetch=original; }
});

test("rejects missing and non-positive pairs with neutral codes", () => {
  assert.throws(()=>normalizeRatePayload({...upstream,data:upstream.data.slice(0,2)}),(error)=>error.code==="RATE_PAIR_MISSING");
  assert.throws(()=>normalizeRatePayload({...upstream,data:upstream.data.map((pair)=>pair.symbol==="USDT/RUB"?{...pair,askPrice:0}:pair)}),(error)=>error.code==="INVALID_RATE_RESPONSE");
});

test("calculates every supported direction and leaves other currencies to a manager", async () => {
  const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify(upstream));
  try { const payload=await getCurrentRates(env()); const quote=(amount,giveCurrency,receiveCurrency)=>calculateQuote({amount,giveCurrency,receiveCurrency,payload})?.outputAmount;
    assert.equal(quote(103,"RUB","USDT"),1);assert.equal(quote(1,"USDT","RUB"),87.3);assert.equal(quote(1,"BTC","USDT"),60000);assert.equal(quote(60000,"USDT","BTC"),1);assert.equal(quote(1,"ETH","USDT"),3000);assert.equal(quote(1,"BTC","ETH"),20);assert.equal(quote(1,"BTC","RUB"),5238000);assert.equal(quote(100,"KZT","USDT"),undefined);
  } finally { globalThis.fetch=original; }
});

test("serves fresh cache, stale fallback, neutral 503 and strict CORS", async () => {
  const original=globalThis.fetch;
  const request=(origin="https://jsmzj6dd9v-bit.github.io",method="GET")=>new Request("https://rates.example/rates",{method,headers:{Origin:origin}});
  try {
    const fresh=normalizeRatePayload(upstream,new Date().toISOString());globalThis.fetch=async()=>{throw new Error("cache expected");};
    let response=await worker.fetch(request(),env(JSON.stringify(fresh)));assert.equal(response.status,200);let body=await response.json();assert.equal(body.stale,false);assert.equal(body.source,undefined);assert.equal(response.headers.get("Access-Control-Allow-Origin"),"https://jsmzj6dd9v-bit.github.io");
    const old=normalizeRatePayload(upstream,new Date(Date.now()-60000).toISOString());response=await worker.fetch(request(),env(JSON.stringify(old)));body=await response.json();assert.equal(body.stale,true);
    response=await worker.fetch(request(),env());assert.equal(response.status,503);body=await response.json();assert.equal(body.error.code,"RATES_UNAVAILABLE");assert.equal(JSON.stringify(body).includes("provider.example"),false);
    response=await worker.fetch(request("https://example.com"),env(JSON.stringify(fresh)));assert.equal(response.headers.get("Access-Control-Allow-Origin"),null);
    response=await worker.fetch(request("https://example.com","OPTIONS"),env());assert.equal(response.status,403);
  } finally { globalThis.fetch=original; }
});

test("health exposes only the neutral service name", async () => {
  const response=await worker.fetch(new Request("https://rates.example/health"),env());assert.deepEqual(await response.json(),{ok:true,service:"papakha-rates"});
});
