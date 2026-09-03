import { ApiError } from "./errors.js";

const encoder = new TextEncoder();
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hmacHex = async (secret, value) => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, typeof value === "string" ? encoder.encode(value) : value));
};

export const timingSafeEqual = (left, right) => {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
};

const requireSandboxConfig = (env) => {
  if (String(env.KYC_MODE || "sandbox") !== "sandbox") {
    throw new ApiError(503, "KYC_PRODUCTION_BLOCKED", "Production-верификация пока недоступна");
  }
  if (!env.SUMSUB_APP_TOKEN || !env.SUMSUB_SECRET_KEY || !env.SUMSUB_LEVEL_NAME) {
    throw new ApiError(503, "KYC_UNAVAILABLE", "Сервис проверки пока не настроен");
  }
};

export const createSumsubSdkToken = async (env, externalUserId) => {
  requireSandboxConfig(env);
  const path = "/resources/accessTokens/sdk";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ userId: externalUserId, levelName: env.SUMSUB_LEVEL_NAME, ttlInSecs: 600 });
  const signature = await hmacHex(env.SUMSUB_SECRET_KEY, `${timestamp}POST${path}${body}`);
  const response = await fetch(`${String(env.SUMSUB_API_BASE_URL || "https://api.sumsub.com").replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Token": env.SUMSUB_APP_TOKEN, "X-App-Access-Ts": timestamp, "X-App-Access-Sig": signature },
    body,
  });
  if (!response.ok) throw new ApiError(503, "KYC_UNAVAILABLE", "Сервис проверки временно недоступен");
  const payload = await response.json().catch(() => null);
  if (!payload?.token) throw new ApiError(503, "KYC_UNAVAILABLE", "Сервис проверки вернул некорректный ответ");
  return { token: payload.token, expiresAt: new Date(Date.now() + 600000).toISOString() };
};

export const verifySumsubWebhook = async (rawBody, request, env) => {
  if (!env.SUMSUB_WEBHOOK_SECRET) throw new ApiError(503, "KYC_UNAVAILABLE", "Webhook проверки не настроен");
  if (request.headers.get("X-Payload-Digest-Alg") !== "HMAC_SHA256_HEX") {
    throw new ApiError(401, "KYC_WEBHOOK_INVALID", "Подпись webhook недействительна");
  }
  const expected = await hmacHex(env.SUMSUB_WEBHOOK_SECRET, rawBody);
  if (!timingSafeEqual(request.headers.get("X-Payload-Digest"), expected)) {
    throw new ApiError(401, "KYC_WEBHOOK_INVALID", "Подпись webhook недействительна");
  }
};

export const sha256Bytes = async (value) => hex(await crypto.subtle.digest("SHA-256", value));

export const mapSumsubReview = (payload) => {
  const reviewStatus = String(payload?.reviewStatus || "").toLowerCase();
  const answer = String(payload?.reviewResult?.reviewAnswer || "").toUpperCase();
  const rejectType = String(payload?.reviewResult?.reviewRejectType || "").toUpperCase();
  const aml = String(payload?.amlStatus || payload?.reviewResult?.amlStatus || "").toUpperCase();
  if (["RED", "BLOCKED", "MATCH"].includes(aml)) return { status: "review", amlStatus: "blocked", reasonCode: "AML_SIGNAL" };
  if (["YELLOW", "REVIEW", "PENDING"].includes(aml)) return { status: "review", amlStatus: "review", reasonCode: "AML_REVIEW" };
  if (answer === "GREEN" && ["completed", "complete"].includes(reviewStatus)) return { status: "approved", amlStatus: "clear", reasonCode: null };
  if (answer === "RED" && rejectType === "RETRY") return { status: "retry", amlStatus: "unknown", reasonCode: "RETRY_REQUIRED" };
  if (answer === "RED" && rejectType === "FINAL") return { status: "declined", amlStatus: "blocked", reasonCode: "FINAL_DECLINE" };
  if (["onhold", "on_hold"].includes(reviewStatus)) return { status: "review", amlStatus: "review", reasonCode: "SPECIALIST_REVIEW" };
  if (["pending", "queued", "init"].includes(reviewStatus)) return { status: "pending", amlStatus: "unknown", reasonCode: null };
  return { status: "review", amlStatus: "review", reasonCode: "RESULT_UNCLEAR" };
};
