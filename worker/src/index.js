const RAPIRA_RATES_URL = "https://api.rapira.net/open/market/rates";
const CACHE_KEY = "rapira-rates-v1";
const CACHE_FRESH_MS = 30000;
const UPSTREAM_TIMEOUT_MS = 5000;
const DEFAULT_ALLOWED_ORIGIN = "https://jsmzj6dd9v-bit.github.io";

const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const roundRate = (value) => Number(Number(value).toFixed(8));

export const normalizeRapiraPayload = (upstream, fetchedAt = new Date().toISOString()) => {
  if (upstream?.code !== 0 || upstream?.message !== "SUCCESS" || upstream?.isWorking !== 1) {
    throw new Error("Rapira market is unavailable");
  }

  const pairs = new Map((upstream.data || []).map((item) => [item.symbol, item]));
  const usdtRub = pairs.get("USDT/RUB");
  const btcUsdt = pairs.get("BTC/USDT");
  const ethUsdt = pairs.get("ETH/USDT");

  if (!positive(usdtRub?.askPrice) || !positive(usdtRub?.bidPrice)) {
    throw new Error("USDT/RUB quote is invalid");
  }
  if (!positive(btcUsdt?.close) || !positive(ethUsdt?.close)) {
    throw new Error("BTC/USDT or ETH/USDT quote is invalid");
  }

  return {
    ok: true,
    source: "Rapira",
    fetchedAt,
    stale: false,
    rates: {
      "USDT/RUB": {
        askPrice: Number(usdtRub.askPrice),
        bidPrice: Number(usdtRub.bidPrice),
        sellRate: roundRate(Number(usdtRub.askPrice) * 1.03),
        buyRate: roundRate(Number(usdtRub.bidPrice) * 0.97),
      },
      "BTC/USDT": { close: Number(btcUsdt.close) },
      "ETH/USDT": { close: Number(ethUsdt.close) },
    },
  };
};

const parseCached = (value) => {
  if (!value) return null;
  try {
    const payload = JSON.parse(value);
    return payload?.ok && payload?.fetchedAt ? payload : null;
  } catch {
    return null;
  }
};

const corsHeaders = (request, env) => {
  const origin = request.headers.get("Origin");
  const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  if (origin !== allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

const json = (request, env, body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": status === 200 ? "public, max-age=15, s-maxage=30" : "no-store",
    ...corsHeaders(request, env),
  },
});

const fetchRapira = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(RAPIRA_RATES_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Rapira returned ${response.status}`);
    return normalizeRapiraPayload(await response.json());
  } finally {
    clearTimeout(timeout);
  }
};

const readCache = async (env) => parseCached(await env.RATES_CACHE?.get(CACHE_KEY));

const handleRates = async (request, env) => {
  const cached = await readCache(env);
  const cachedTime = cached ? new Date(cached.fetchedAt).getTime() : 0;
  if (cached && Number.isFinite(cachedTime) && Date.now() - cachedTime <= CACHE_FRESH_MS) {
    return json(request, env, { ...cached, stale: false });
  }

  try {
    const payload = await fetchRapira();
    await env.RATES_CACHE?.put(CACHE_KEY, JSON.stringify(payload));
    return json(request, env, payload);
  } catch {
    if (cached) return json(request, env, { ...cached, stale: true });
    return json(request, env, {
      ok: false,
      code: "RATES_UNAVAILABLE",
      message: "Котировки временно недоступны",
    }, 503);
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      const allowed = Object.keys(corsHeaders(request, env)).length > 0;
      return new Response(null, { status: allowed ? 204 : 403, headers: corsHeaders(request, env) });
    }
    if (request.method !== "GET") return json(request, env, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
    if (url.pathname === "/rates") return handleRates(request, env);
    if (url.pathname === "/health") return json(request, env, { ok: true, service: "papakha-rates" });
    return json(request, env, { ok: false, code: "NOT_FOUND" }, 404);
  },
};
