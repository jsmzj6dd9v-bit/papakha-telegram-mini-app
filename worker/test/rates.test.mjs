import assert from "node:assert/strict";
import test from "node:test";
import worker, { normalizeRapiraPayload } from "../src/index.js";

await import("../../rates-core.js");
const { calculateQuote, validatePayload } = globalThis.PapakhaRates;

const upstream = {
  code: 0,
  message: "SUCCESS",
  isWorking: 1,
  data: [
    { symbol: "USDT/RUB", askPrice: 100, bidPrice: 90 },
    { symbol: "BTC/USDT", close: 60000 },
    { symbol: "ETH/USDT", close: 3000 },
  ],
};

test("normalizes Rapira rates and applies only the USDT markup", () => {
  const payload = normalizeRapiraPayload(upstream, "2026-09-01T12:00:00.000Z");
  assert.equal(payload.rates["USDT/RUB"].sellRate, 103);
  assert.equal(payload.rates["USDT/RUB"].buyRate, 87.3);
  assert.equal(payload.rates["BTC/USDT"].close, 60000);
  assert.equal(payload.rates["ETH/USDT"].close, 3000);
  assert.equal(validatePayload(payload), true);
});

test("rejects missing or non-positive required pairs", () => {
  assert.throws(() => normalizeRapiraPayload({ ...upstream, data: upstream.data.slice(0, 2) }));
  assert.throws(() => normalizeRapiraPayload({
    ...upstream,
    data: upstream.data.map((pair) => pair.symbol === "USDT/RUB" ? { ...pair, askPrice: 0 } : pair),
  }));
});

test("calculates all supported directional conversions", () => {
  const payload = normalizeRapiraPayload(upstream, "2026-09-01T12:00:00.000Z");
  const quote = (amount, giveCurrency, receiveCurrency) => calculateQuote({
    amount,
    giveCurrency,
    receiveCurrency,
    payload,
  }).outputAmount;

  assert.equal(quote(103, "RUB", "USDT"), 1);
  assert.equal(quote(1, "USDT", "RUB"), 87.3);
  assert.equal(quote(1, "BTC", "USDT"), 60000);
  assert.equal(quote(60000, "USDT", "BTC"), 1);
  assert.equal(quote(1, "ETH", "USDT"), 3000);
  assert.equal(quote(1, "BTC", "ETH"), 20);
  assert.equal(quote(1, "BTC", "RUB"), 5238000);
});

test("leaves unsupported currencies for manager confirmation", () => {
  const payload = normalizeRapiraPayload(upstream);
  assert.equal(calculateQuote({ amount: 100, giveCurrency: "KZT", receiveCurrency: "USDT", payload }), null);
  assert.equal(calculateQuote({ amount: 100, giveCurrency: "USD", receiveCurrency: "RUB", payload }), null);
});

test("serves cache, stale fallback, unavailable state and strict CORS", async () => {
  const originalFetch = globalThis.fetch;
  const createEnv = (cachedValue = null) => ({
    ALLOWED_ORIGIN: "https://jsmzj6dd9v-bit.github.io",
    RATES_CACHE: {
      async get() { return cachedValue; },
      async put(_key, value) { cachedValue = value; },
    },
  });
  const request = (origin = "https://jsmzj6dd9v-bit.github.io", method = "GET") => new Request(
    "https://rates.example/rates",
    { method, headers: { Origin: origin } },
  );

  try {
    const fresh = normalizeRapiraPayload(upstream, new Date().toISOString());
    globalThis.fetch = async () => { throw new Error("Fresh cache must avoid upstream"); };
    const freshResponse = await worker.fetch(request(), createEnv(JSON.stringify(fresh)));
    assert.equal(freshResponse.status, 200);
    assert.equal((await freshResponse.json()).stale, false);
    assert.equal(freshResponse.headers.get("Access-Control-Allow-Origin"), "https://jsmzj6dd9v-bit.github.io");

    const old = normalizeRapiraPayload(upstream, new Date(Date.now() - 60000).toISOString());
    globalThis.fetch = async () => { throw new Error("Rapira offline"); };
    const staleResponse = await worker.fetch(request(), createEnv(JSON.stringify(old)));
    assert.equal(staleResponse.status, 200);
    assert.equal((await staleResponse.json()).stale, true);

    const unavailableResponse = await worker.fetch(request(), createEnv());
    assert.equal(unavailableResponse.status, 503);
    assert.equal((await unavailableResponse.json()).code, "RATES_UNAVAILABLE");

    const forbiddenOriginResponse = await worker.fetch(request("https://example.com"), createEnv(JSON.stringify(fresh)));
    assert.equal(forbiddenOriginResponse.headers.get("Access-Control-Allow-Origin"), null);
    const forbiddenPreflight = await worker.fetch(request("https://example.com", "OPTIONS"), createEnv());
    assert.equal(forbiddenPreflight.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
