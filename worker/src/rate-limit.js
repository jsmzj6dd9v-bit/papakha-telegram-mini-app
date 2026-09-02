import { ApiError } from "./errors.js";
import { sha256 } from "./auth.js";

export const enforceRateLimit = async (env, request, scope, { limit = 60, windowSeconds = 60, identity } = {}) => {
  if (!env.RATES_CACHE) return;
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const fingerprint = await sha256(`${scope}:${identity || ip}`);
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `limit:${fingerprint}:${bucket}`;
  const count = Number(await env.RATES_CACHE.get(key) || 0);
  if (count >= limit) throw new ApiError(429, "RATE_LIMITED", "Слишком много запросов. Повторите немного позже");
  await env.RATES_CACHE.put(key, String(count + 1), { expirationTtl: Math.max(windowSeconds * 2, 60) });
};
