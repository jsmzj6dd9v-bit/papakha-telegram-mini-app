import { ApiError } from "./errors.js";
import { applyBasisPoints } from "./money.js";

const CACHE_KEY = "market-rates-v2";
const CACHE_FRESH_MS = 30000;
const UPSTREAM_TIMEOUT_MS = 5000;
const DEFAULT_SELL_BPS = 300;
const DEFAULT_BUY_BPS = -300;

const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const roundRate = (value) => Number(Number(value).toFixed(8));

export const normalizeRatePayload = (upstream, updatedAt = new Date().toISOString()) => {
  if (upstream?.code !== 0 || upstream?.message !== "SUCCESS" || upstream?.isWorking !== 1) {
    throw new ApiError(503, "RATES_UNAVAILABLE", "Сервис курсов недоступен");
  }

  const pairs = new Map((upstream.data || []).map((item) => [item.symbol, item]));
  const usdtRub = pairs.get("USDT/RUB");
  const btcUsdt = pairs.get("BTC/USDT");
  const ethUsdt = pairs.get("ETH/USDT");

  if (!usdtRub || !btcUsdt || !ethUsdt) {
    throw new ApiError(503, "RATE_PAIR_MISSING", "Обязательная валютная пара отсутствует");
  }
  if (!positive(usdtRub.askPrice) || !positive(usdtRub.bidPrice) || !positive(btcUsdt.close) || !positive(ethUsdt.close)) {
    throw new ApiError(503, "INVALID_RATE_RESPONSE", "Получен некорректный курс");
  }

  return {
    ok: true,
    updatedAt,
    stale: false,
    marketRates: {
      "USDT/RUB": { askPrice: Number(usdtRub.askPrice), bidPrice: Number(usdtRub.bidPrice) },
      "BTC/USDT": { close: Number(btcUsdt.close) },
      "ETH/USDT": { close: Number(ethUsdt.close) },
    },
  };
};

const parseCached = (value) => {
  if (!value) return null;
  try {
    const payload = JSON.parse(value);
    return payload?.ok && payload?.updatedAt && payload?.marketRates ? payload : null;
  } catch {
    return null;
  }
};

const fetchMarketRates = async (env) => {
  if (!env.RATE_PROVIDER_API_URL) throw new ApiError(503, "RATES_UNAVAILABLE", "Сервис курсов не настроен");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(env.RATE_PROVIDER_API_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(503, "RATES_UNAVAILABLE", "Сервис курсов недоступен");
    return normalizeRatePayload(await response.json());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "RATES_UNAVAILABLE", "Сервис курсов недоступен");
  } finally {
    clearTimeout(timeout);
  }
};

const readSettings = async (env) => {
  const defaults = { sellBps: DEFAULT_SELL_BPS, buyBps: DEFAULT_BUY_BPS, automaticCurrencies: ["RUB", "USDT", "BTC", "ETH"] };
  if (!env.DB) return defaults;
  try {
    const result = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('sell_markup_bps', 'buy_markup_bps', 'automatic_currencies')",
    ).all();
    for (const row of result.results || []) {
      if (row.key === "sell_markup_bps") defaults.sellBps = Number(JSON.parse(row.value));
      if (row.key === "buy_markup_bps") defaults.buyBps = Number(JSON.parse(row.value));
      if (row.key === "automatic_currencies") defaults.automaticCurrencies = JSON.parse(row.value);
    }
  } catch {
    // Defaults keep the public rate endpoint available before D1 is initialized.
  }
  return defaults;
};

const toPublicPayload = async (raw, env, stale = false) => {
  const settings = await readSettings(env);
  const usdt = raw.marketRates["USDT/RUB"];
  return {
    ok: true,
    updatedAt: raw.updatedAt,
    stale,
    automaticCurrencies: settings.automaticCurrencies,
    rates: {
      "USDT/RUB": {
        askPrice: usdt.askPrice,
        bidPrice: usdt.bidPrice,
        sellRate: roundRate(applyBasisPoints(usdt.askPrice, settings.sellBps)),
        buyRate: roundRate(applyBasisPoints(usdt.bidPrice, settings.buyBps)),
      },
      "BTC/USDT": { close: raw.marketRates["BTC/USDT"].close },
      "ETH/USDT": { close: raw.marketRates["ETH/USDT"].close },
    },
  };
};

export const getCurrentRates = async (env) => {
  const cached = parseCached(await env.RATES_CACHE?.get(CACHE_KEY));
  const cachedTime = cached ? new Date(cached.updatedAt).getTime() : 0;
  if (cached && Number.isFinite(cachedTime) && Date.now() - cachedTime <= CACHE_FRESH_MS) {
    return toPublicPayload(cached, env, false);
  }

  try {
    const raw = await fetchMarketRates(env);
    await env.RATES_CACHE?.put(CACHE_KEY, JSON.stringify(raw));
    return toPublicPayload(raw, env, false);
  } catch (error) {
    if (cached) return toPublicPayload(cached, env, true);
    throw error instanceof ApiError ? error : new ApiError(503, "RATES_UNAVAILABLE", "Сервис курсов недоступен");
  }
};

export const rateConstants = Object.freeze({ CACHE_KEY, CACHE_FRESH_MS });
