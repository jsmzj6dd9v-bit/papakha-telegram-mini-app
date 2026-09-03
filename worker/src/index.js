import { ApiError, assert } from "./errors.js";
import { authenticateTelegram } from "./auth.js";
import { calculateServerQuote, parseDecimal } from "./money.js";
import { getCurrentRates } from "./rates.js";
import {
  authenticateAdminSession, createAdminHandoff, exchangeAdminHandoff, createAdminSession, createDeal, getAdminDeal, getAuditLog,
  getClientDeal, getDashboard, getSettings, listAdminDeals, listAdmins, patchAdmin, patchSettings, requireRole,
  revokeAdminSession, transitionAdminDeal, transitionClientDeal,
} from "./db.js";
import { createExpiryNotifications, deliverNotification, processPendingNotifications } from "./notifications.js";
import { enforceRateLimit } from "./rate-limit.js";
import { createSumsubSdkToken, verifySumsubWebhook } from "./sumsub.js";
import {
  decideVerification, ensureVerification, getAdminVerification, getVerificationForUser,
  listVerifications, markVerificationSessionStarted, processVerificationWebhook, requireApprovedVerification,
} from "./verification.js";

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});
const parseJson = async (request) => {
  try { return await request.json(); } catch { throw new ApiError(400, "INVALID_JSON", "Некорректный формат запроса"); }
};
const allowedOrigin = (request, env) => {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return origin && allowed.includes(origin) ? origin : null;
};
const corsHeaders = (request, env) => {
  const origin = allowedOrigin(request, env);
  return origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {};
};
const publicDeal = (deal) => ({
  id: deal.id, publicId: deal.public_id, status: deal.status, giveCurrency: deal.give_currency,
  giveAmount: deal.give_amount, receiveCurrency: deal.receive_currency, receiveAmount: deal.receive_amount,
  paymentMethod: deal.payment_method, quotedRate: deal.quoted_rate, quoteUpdatedAt: deal.quote_updated_at,
  quoteStale: Boolean(deal.quote_stale), rateExpiresAt: deal.rate_expires_at || null,
  paymentInstructions: ["rate_accepted", "awaiting_payment", "payment_review", "exchange_in_progress", "completed", "dispute"].includes(deal.status) ? deal.payment_instructions || null : null,
});
const sessionCookie = (token, env, maxAge = 43200) => env.ENVIRONMENT === "development"
  ? `papakha_admin=${token}; HttpOnly; SameSite=Lax; Path=/api/admin; Max-Age=${maxAge}`
  : `papakha_admin=${token}; HttpOnly; Secure; SameSite=None; Path=/api/admin; Max-Age=${maxAge}`;

const route = async (request, env) => {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (method === "GET" && path === "/health") return json({ ok: true, service: "papakha-rates" });
  if (method === "GET" && path === "/rates") return json(await getCurrentRates(env));

  if (method === "POST" && path === "/api/verification/webhook") {
    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > 262144) throw new ApiError(413, "KYC_WEBHOOK_TOO_LARGE", "Webhook слишком большой");
    if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
      throw new ApiError(415, "KYC_WEBHOOK_CONTENT_TYPE", "Требуется JSON");
    }
    const rawBody = await request.arrayBuffer();
    if (rawBody.byteLength > 262144) throw new ApiError(413, "KYC_WEBHOOK_TOO_LARGE", "Webhook слишком большой");
    await verifySumsubWebhook(rawBody, request, env);
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(rawBody)); } catch { throw new ApiError(400, "KYC_EVENT_INVALID", "Некорректное событие проверки"); }
    await processVerificationWebhook(env, payload, rawBody);
    return new Response(null, { status: 204 });
  }

  if (method === "GET" && path === "/api/verification/status") {
    const user = await authenticateTelegram(request, env);
    await enforceRateLimit(env, request, "kyc-status", { limit: 60, windowSeconds: 60, identity: user.id });
    return json({ ok: true, verification: (await getVerificationForUser(env, user)).public });
  }

  if (method === "POST" && path === "/api/verification/session") {
    const user = await authenticateTelegram(request, env);
    await enforceRateLimit(env, request, "kyc-session", { limit: 3, windowSeconds: 600, identity: user.id });
    const verification = await ensureVerification(env, user);
    if (verification.status === "declined") throw new ApiError(403, "KYC_DECLINED", "Создание сделки недоступно");
    const session = await createSumsubSdkToken(env, verification.external_user_id);
    const updated = await markVerificationSessionStarted(env, verification);
    return json({ ok: true, session: { ...session, mode: "sandbox" }, verification: (await getVerificationForUser(env, user)).public, resumed: Boolean(updated.provider_applicant_id) }, 201);
  }

  if (method === "POST" && path === "/api/admin/handoff") {
    const user = await authenticateTelegram(request, env);
    await enforceRateLimit(env, request, "admin-handoff", { limit: 10, windowSeconds: 60, identity: user.id });
    return json({ ok: true, ...(await createAdminHandoff(env, user)) }, 201);
  }

  if (method === "POST" && path === "/api/admin/session/exchange") {
    await enforceRateLimit(env, request, "admin-exchange", { limit: 20, windowSeconds: 60 });
    const session = await exchangeAdminHandoff(env, (await parseJson(request)).code);
    return json({ ok: true, admin: { telegramId: session.admin.telegram_id, role: session.admin.role, displayName: session.admin.display_name }, csrfToken: session.csrfToken, expiresAt: session.expiresAt }, 201, { "Set-Cookie": sessionCookie(session.token, env) });
  }

  if (method === "POST" && path === "/api/admin/session") {
    await enforceRateLimit(env, request, "admin-login", { limit: 10, windowSeconds: 60 });
    const user = await authenticateTelegram(request, env);
    const session = await createAdminSession(env, user);
    return json({ ok: true, admin: { telegramId: session.admin.telegram_id, role: session.admin.role, displayName: session.admin.display_name }, csrfToken: session.csrfToken, expiresAt: session.expiresAt }, 201, { "Set-Cookie": sessionCookie(session.token, env) });
  }
  if (path === "/api/admin/session") {
    const admin = await authenticateAdminSession(request, env, { requireCsrf: method === "DELETE" });
    if (method === "GET") return json({ ok: true, admin: { telegramId: admin.telegram_id, role: admin.role, displayName: admin.display_name }, csrfToken: admin.csrf_token, expiresAt: admin.expires_at });
    if (method === "DELETE") { await revokeAdminSession(env, admin.id); return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", env, 0) }); }
  }

  if (path.startsWith("/api/admin/")) {
    const admin = await authenticateAdminSession(request, env, { requireCsrf: !["GET", "HEAD"].includes(method) });
    if (method === "GET" && path === "/api/admin/dashboard") {
      const dashboard = await getDashboard(env);
      let ratesState = "unavailable";
      try { ratesState = (await getCurrentRates(env)).stale ? "stale" : "working"; } catch { /* Neutral admin state below. */ }
      return json({ ok: true, dashboard: { ...dashboard, services: {
        rates: ratesState,
        telegram: env.TELEGRAM_BOT_TOKEN ? "configured" : "unavailable",
        verification: env.KYC_MODE === "sandbox" && env.SUMSUB_APP_TOKEN && env.SUMSUB_SECRET_KEY && env.SUMSUB_WEBHOOK_SECRET ? "sandbox" : "unavailable",
      } } });
    }
    if (method === "GET" && path === "/api/admin/deals") return json({ ok: true, deals: await listAdminDeals(env, { status: url.searchParams.get("status"), search: url.searchParams.get("search"), limit: url.searchParams.get("limit") }) });
    if (method === "GET" && path === "/api/admin/settings") { requireRole(admin, ["owner", "manager", "viewer"]); return json({ ok: true, settings: await getSettings(env) }); }
    if (method === "PATCH" && path === "/api/admin/settings") { requireRole(admin, ["owner"]); return json({ ok: true, settings: await patchSettings(env, admin, await parseJson(request)) }); }
    if (method === "GET" && path === "/api/admin/audit-log") { requireRole(admin, ["owner"]); return json({ ok: true, events: await getAuditLog(env, url.searchParams.get("limit")) }); }
    if (method === "GET" && path === "/api/admin/admins") { requireRole(admin, ["owner"]); return json({ ok: true, admins: await listAdmins(env) }); }
    if (method === "POST" && path === "/api/admin/admins") { requireRole(admin, ["owner"]); return json({ ok: true, admin: await patchAdmin(env, admin, await parseJson(request)) }); }
    if (method === "GET" && path === "/api/admin/verifications") { requireRole(admin, ["owner"]); return json({ ok: true, verifications: await listVerifications(env, { status: url.searchParams.get("status"), limit: url.searchParams.get("limit") }) }); }
    const verificationMatch = path.match(/^\/api\/admin\/verifications\/([^/]+)(?:\/([^/]+))?$/);
    if (verificationMatch) {
      requireRole(admin, ["owner"]);
      const verificationId = decodeURIComponent(verificationMatch[1]);
      if (method === "GET" && !verificationMatch[2]) return json({ ok: true, verification: await getAdminVerification(env, verificationId) });
      if (method === "POST" && verificationMatch[2]) {
        return json({ ok: true, verification: await decideVerification(env, { id: verificationId, admin, action: verificationMatch[2], reason: (await parseJson(request)).reason }) });
      }
    }
    const match = path.match(/^\/api\/admin\/deals\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const deal = await getAdminDeal(env, decodeURIComponent(match[1]));
      if (method === "GET" && !match[2]) return json({ ok: true, deal });
      if (method === "POST" && match[2]) {
        requireRole(admin, ["owner", "manager"]);
        const updated = await transitionAdminDeal(env, { deal, admin, action: match[2], input: await parseJson(request), idempotencyKey: request.headers.get("Idempotency-Key") });
        return json({ ok: true, deal: updated });
      }
    }
  }

  if (method === "POST" && path === "/api/deals") {
    const user = await authenticateTelegram(request, env);
    await enforceRateLimit(env, request, "deal-create", { limit: 10, windowSeconds: 60, identity: user.id });
    const input = await parseJson(request);
    assert(input?.giveCurrency && input?.receiveCurrency && input?.amount && input?.method, 400, "DEAL_INPUT_INVALID", "Заполните все данные сделки");
    const settings = await getSettings(env);
    assert(!settings.maintenance_mode, 503, "MAINTENANCE_MODE", "Создание заявок временно приостановлено");
    const supported = new Set(settings.supported_currencies || ["RUB", "USDT", "BTC", "ETH", "KZT", "AED", "USD"]);
    assert(supported.has(input.giveCurrency) && supported.has(input.receiveCurrency) && input.giveCurrency !== input.receiveCurrency, 400, "DEAL_DIRECTION_INVALID", "Некорректное направление обмена");
    assert(["Наличные", "Перевод"].includes(input.method), 400, "PAYMENT_METHOD_INVALID", "Некорректный способ расчёта");
    const amount = parseDecimal(input.amount);
    assert(amount >= parseDecimal(settings.minimum_amount || "1") && amount <= parseDecimal(settings.maximum_amount || "100000000"), 400, "AMOUNT_OUT_OF_RANGE", "Сумма вне допустимого диапазона");
    const requestId = request.headers.get("Idempotency-Key");
    assert(requestId && requestId.length <= 100, 400, "IDEMPOTENCY_KEY_REQUIRED", "Отсутствует ключ заявки");
    const verification = await requireApprovedVerification(env, user);
    let rates = null;
    let quote = null;
    try {
      rates = await getCurrentRates(env);
      const automatic = new Set(settings.automatic_currencies || ["RUB", "USDT", "BTC", "ETH"]);
      quote = automatic.has(input.giveCurrency) && automatic.has(input.receiveCurrency)
        ? calculateServerQuote({ amount: input.amount, giveCurrency: input.giveCurrency, receiveCurrency: input.receiveCurrency, rates: rates.rates })
        : null;
    } catch (error) {
      if (!(error instanceof ApiError) || !["RATES_UNAVAILABLE", "RATE_PAIR_MISSING", "INVALID_RATE_RESPONSE"].includes(error.code)) throw error;
    }
    const result = await createDeal(env, { user, requestId, input, quote, rates, verification });
    return json({ ok: true, created: result.created, deal: publicDeal(result.deal) }, result.created ? 201 : 200);
  }
  const clientMatch = path.match(/^\/api\/deals\/([^/]+)(?:\/([^/]+))?$/);
  if (clientMatch) {
    const user = await authenticateTelegram(request, env);
    await enforceRateLimit(env, request, "client-deal", { limit: 120, windowSeconds: 60, identity: user.id });
    const deal = await getClientDeal(env, decodeURIComponent(clientMatch[1]), user.id);
    if (method === "GET" && !clientMatch[2]) return json({ ok: true, deal: publicDeal(deal) });
    if (method === "POST" && clientMatch[2]) return json({ ok: true, deal: publicDeal(await transitionClientDeal(env, { deal, user, action: clientMatch[2] })) });
  }
  throw new ApiError(404, "NOT_FOUND", "Метод не найден");
};

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(request, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, X-CSRF-Token, X-Dev-Telegram-User, Idempotency-Key", "Access-Control-Max-Age": "86400" } });
    }
    try {
      const response = await route(request, env);
      Object.entries(cors).forEach(([key, value]) => response.headers.set(key, value));
      return response;
    } catch (error) {
      const known = error instanceof ApiError;
      const response = json({ ok: false, error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "Внутренняя ошибка сервиса", ...(known && error.details ? { details: error.details } : {}) } }, known ? error.status : 500);
      Object.entries(cors).forEach(([key, value]) => response.headers.set(key, value));
      return response;
    }
  },
  async queue(batch, env) { for (const message of batch.messages) { try { await deliverNotification(env, message.body.outboxId); message.ack(); } catch { message.retry(); } } },
  async scheduled(_event, env, ctx) { ctx.waitUntil((async () => { await createExpiryNotifications(env); await processPendingNotifications(env); })()); },
};

export { normalizeRatePayload } from "./rates.js";
