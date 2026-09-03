import { ApiError, assert } from "./errors.js";
import { randomToken, sha256 } from "./auth.js";
import { parseDecimal } from "./money.js";

const nowIso = () => new Date().toISOString();
const eventId = () => crypto.randomUUID();

const publicDealId = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `PX-${date}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
};

const jsonValue = (value) => value == null ? null : JSON.stringify(value);

export const requireDatabase = (env) => {
  if (!env.DB) throw new ApiError(503, "DATABASE_UNAVAILABLE", "База сделок недоступна");
  return env.DB;
};

export const enqueueNotification = async (env, outboxId) => {
  try {
    await env.NOTIFICATION_QUEUE?.send({ outboxId });
  } catch {
    // D1 outbox remains the source of truth and can be retried later.
  }
};

export const createDeal = async (env, { user, requestId, input, quote, rates, verification = null }) => {
  const db = requireDatabase(env);
  const existing = await db.prepare(
    "SELECT * FROM deals WHERE telegram_user_id = ? AND client_request_id = ?",
  ).bind(user.id, requestId).first();
  if (existing) return { deal: existing, created: false };

  const id = crypto.randomUUID();
  const publicId = publicDealId();
  const createdAt = nowIso();
  const outboxId = eventId();
  const message = `Заявка ${publicId} создана. Менеджер проверит условия и пришлёт подтверждение.`;
  const markupRows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('sell_markup_bps','buy_markup_bps')").all();
  const markupSnapshot = Object.fromEntries((markupRows.results || []).map((row) => [row.key, Number(JSON.parse(row.value))]));

  const statements = [
    db.prepare(
      `INSERT INTO telegram_users
       (telegram_id, username, first_name, last_name, language_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET
         username = excluded.username,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         language_code = excluded.language_code,
         updated_at = excluded.updated_at`,
    ).bind(user.id, user.username || null, user.first_name || null, user.last_name || null, user.language_code || null, createdAt, createdAt),
    db.prepare(
      `INSERT INTO deals
       (id, public_id, telegram_user_id, client_request_id, status, give_currency, give_amount,
        receive_currency, receive_amount, payment_method, quoted_rate, market_rate_snapshot,
        markup_snapshot, quote_updated_at, quote_stale, verification_id,
        verification_status_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, publicId, user.id, requestId, input.giveCurrency, input.amount,
      input.receiveCurrency, quote?.outputAmount || null, input.method,
      quote?.rate || null, jsonValue(rates?.rates || null), jsonValue(markupSnapshot),
      rates?.updatedAt || null, rates?.stale ? 1 : 0, verification?.id || null,
      verification?.status || null, createdAt, createdAt,
    ),
    db.prepare(
      `INSERT INTO deal_events
       (id, deal_id, actor_type, actor_id, event_type, from_status, to_status, payload, created_at)
       VALUES (?, ?, 'client', ?, 'deal_created', NULL, 'new', ?, ?)`,
    ).bind(eventId(), id, String(user.id), jsonValue({ input, quote }), createdAt),
    db.prepare(
      `INSERT INTO notification_outbox
       (id, deal_id, telegram_user_id, event_type, message, created_at)
       VALUES (?, ?, ?, 'deal_created', ?, ?)`,
    ).bind(outboxId, id, user.id, message, createdAt),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    const duplicate = await db.prepare(
      "SELECT * FROM deals WHERE telegram_user_id = ? AND client_request_id = ?",
    ).bind(user.id, requestId).first();
    if (duplicate) return { deal: duplicate, created: false };
    throw error;
  }

  await enqueueNotification(env, outboxId);
  return { deal: await db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first(), created: true };
};

export const getClientDeal = async (env, id, telegramUserId) => {
  const deal = await requireDatabase(env).prepare(
    `SELECT d.*, rl.expires_at AS rate_expires_at, rl.accepted_at AS lock_accepted_at,
            pi.instructions AS payment_instructions
     FROM deals d
     LEFT JOIN rate_locks rl ON rl.id = (
       SELECT id FROM rate_locks WHERE deal_id = d.id ORDER BY created_at DESC LIMIT 1
     )
     LEFT JOIN payment_instructions pi ON pi.id = (
       SELECT id FROM payment_instructions WHERE deal_id = d.id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1
     )
     WHERE (d.id = ? OR d.public_id = ?) AND d.telegram_user_id = ?`,
  ).bind(id, id, telegramUserId).first();
  if (!deal) throw new ApiError(404, "DEAL_NOT_FOUND", "Сделка не найдена");
  return deal;
};

export const addDealEvent = (db, { dealId, actorType, actorId, eventType, fromStatus, toStatus, payload }) => db.prepare(
  `INSERT INTO deal_events
   (id, deal_id, actor_type, actor_id, event_type, from_status, to_status, payload, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(eventId(), dealId, actorType, actorId == null ? null : String(actorId), eventType, fromStatus || null, toStatus || null, jsonValue(payload), nowIso());

export const transitionClientDeal = async (env, { deal, user, action }) => {
  const db = requireDatabase(env);
  const now = nowIso();
  let nextStatus;
  let eventType;

  if (action === "accept-rate") {
    assert(deal.status === "rate_offered", 409, "INVALID_DEAL_STATUS", "Курс уже недоступен");
    assert(deal.rate_expires_at && new Date(deal.rate_expires_at).getTime() > Date.now(), 409, "RATE_EXPIRED", "Срок действия курса истёк");
    nextStatus = deal.payment_instructions ? "awaiting_payment" : "rate_accepted";
    eventType = "rate_accepted";
  } else if (action === "reject-rate") {
    assert(deal.status === "rate_offered", 409, "INVALID_DEAL_STATUS", "Курс уже обработан");
    nextStatus = "cancelled";
    eventType = "rate_rejected";
  } else if (action === "payment-sent") {
    assert(["rate_accepted", "awaiting_payment"].includes(deal.status), 409, "INVALID_DEAL_STATUS", "Оплата пока не ожидается");
    nextStatus = "payment_review";
    eventType = "payment_sent";
  } else {
    throw new ApiError(404, "ACTION_NOT_FOUND", "Действие не найдено");
  }

  const updateFields = action === "accept-rate"
    ? "status = ?, rate_accepted_at = ?, updated_at = ?"
    : action === "reject-rate"
      ? "status = ?, cancelled_at = ?, updated_at = ?"
      : "status = ?, updated_at = ?";
  const values = action === "payment-sent" ? [nextStatus, now, deal.id] : [nextStatus, now, now, deal.id];
  const statements = [
    db.prepare(`UPDATE deals SET ${updateFields} WHERE id = ? AND status = ?`).bind(...values, deal.status),
    addDealEvent(db, {
      dealId: deal.id, actorType: "client", actorId: user.id, eventType,
      fromStatus: deal.status, toStatus: nextStatus,
    }),
  ];
  const outboxId = eventId();
  const clientMessage = action === "accept-rate"
    ? `${deal.payment_instructions ? `Курс принят. ${deal.payment_instructions}` : "Курс принят. Менеджер отправит дальнейшие инструкции."}`
    : action === "payment-sent"
      ? `По заявке ${deal.public_id} отмечена отправка оплаты. Менеджер проверяет поступление.`
      : `Заявка ${deal.public_id} отменена по вашему запросу.`;
  statements.push(db.prepare(`INSERT INTO notification_outbox
    (id, deal_id, telegram_user_id, event_type, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(outboxId, deal.id, user.id, eventType, clientMessage, now));
  if (action === "accept-rate") {
    statements.push(db.prepare("UPDATE rate_locks SET accepted_at = ? WHERE deal_id = ? AND accepted_at IS NULL AND rejected_at IS NULL").bind(now, deal.id));
  }
  if (action === "reject-rate") {
    statements.push(db.prepare("UPDATE rate_locks SET rejected_at = ? WHERE deal_id = ? AND accepted_at IS NULL AND rejected_at IS NULL").bind(now, deal.id));
  }
  const result = await db.batch(statements);
  if (!result[0]?.meta?.changes) throw new ApiError(409, "DEAL_CONCURRENTLY_UPDATED", "Статус сделки уже изменён");
  await enqueueNotification(env, outboxId);
  return getClientDeal(env, deal.id, user.id);
};

export const listAdminDeals = async (env, filters = {}) => {
  const db = requireDatabase(env);
  const clauses = [];
  const bindings = [];
  if (filters.status) {
    clauses.push("d.status = ?");
    bindings.push(filters.status);
  }
  if (filters.search) {
    clauses.push("(d.public_id LIKE ? OR u.username LIKE ? OR CAST(d.telegram_user_id AS TEXT) LIKE ?)");
    const term = `%${filters.search.slice(0, 80)}%`;
    bindings.push(term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 200);
  const result = await db.prepare(
    `SELECT d.*, u.username, u.first_name, u.last_name, a.display_name AS manager_name
     FROM deals d
     JOIN telegram_users u ON u.telegram_id = d.telegram_user_id
     LEFT JOIN admins a ON a.telegram_id = d.assigned_admin_id
     ${where}
     ORDER BY d.created_at DESC LIMIT ?`,
  ).bind(...bindings, limit).all();
  return result.results || [];
};

export const getAdminDeal = async (env, id) => {
  const db = requireDatabase(env);
  const deal = await db.prepare(
    `SELECT d.*, u.username, u.first_name, u.last_name, u.language_code,
            a.display_name AS manager_name, rl.expires_at AS rate_expires_at,
            pi.instructions AS payment_instructions
     FROM deals d
     JOIN telegram_users u ON u.telegram_id = d.telegram_user_id
     LEFT JOIN admins a ON a.telegram_id = d.assigned_admin_id
     LEFT JOIN rate_locks rl ON rl.id = (SELECT id FROM rate_locks WHERE deal_id = d.id ORDER BY created_at DESC LIMIT 1)
     LEFT JOIN payment_instructions pi ON pi.id = (SELECT id FROM payment_instructions WHERE deal_id = d.id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1)
     WHERE d.id = ? OR d.public_id = ?`,
  ).bind(id, id).first();
  if (!deal) throw new ApiError(404, "DEAL_NOT_FOUND", "Сделка не найдена");
  const [events, notifications, executions] = await Promise.all([
    db.prepare("SELECT * FROM deal_events WHERE deal_id = ? ORDER BY created_at ASC").bind(deal.id).all(),
    db.prepare("SELECT * FROM notification_outbox WHERE deal_id = ? ORDER BY created_at DESC").bind(deal.id).all(),
    db.prepare("SELECT * FROM execution_attempts WHERE deal_id = ? ORDER BY created_at DESC").bind(deal.id).all(),
  ]);
  return { ...deal, events: events.results || [], notifications: notifications.results || [], executions: executions.results || [] };
};

export const createAdminSession = async (env, telegramUser) => {
  const db = requireDatabase(env);
  const admin = await db.prepare("SELECT * FROM admins WHERE telegram_id = ? AND active = 1 AND revoked_at IS NULL").bind(telegramUser.id).first();
  if (!admin) throw new ApiError(403, "ADMIN_ACCESS_DENIED", "Нет доступа к админ-панели");
  const token = randomToken();
  const csrfToken = randomToken();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await db.prepare(
    "INSERT INTO admin_sessions (id, telegram_id, token_hash, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, admin.telegram_id, await sha256(token), csrfToken, expiresAt).run();
  return { admin, token, csrfToken, expiresAt };
};

export const createAdminHandoff = async (env, telegramUser) => {
  const db = requireDatabase(env);
  const admin = await db.prepare("SELECT telegram_id, role, display_name FROM admins WHERE telegram_id = ? AND active = 1 AND revoked_at IS NULL")
    .bind(telegramUser.id).first();
  if (!admin) throw new ApiError(403, "ADMIN_ACCESS_DENIED", "Нет доступа к админ-панели");
  if (!env.ADMIN_APP_URL) throw new ApiError(503, "ADMIN_APP_UNAVAILABLE", "Админ-панель временно недоступна");
  const code = randomToken();
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  await db.prepare("INSERT INTO admin_handoffs (id, code_hash, telegram_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), await sha256(code), admin.telegram_id, expiresAt).run();
  const adminUrl = new URL(env.ADMIN_APP_URL);
  adminUrl.searchParams.set("code", code);
  return { adminUrl: adminUrl.toString(), expiresAt };
};

export const exchangeAdminHandoff = async (env, code) => {
  if (!code || String(code).length > 200) throw new ApiError(400, "ADMIN_HANDOFF_INVALID", "Ссылка входа недействительна");
  const db = requireDatabase(env);
  const codeHash = await sha256(String(code));
  const handoff = await db.prepare(
    "SELECT id, telegram_id FROM admin_handoffs WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?",
  ).bind(codeHash, nowIso()).first();
  if (!handoff) throw new ApiError(401, "ADMIN_HANDOFF_INVALID", "Ссылка входа недействительна или устарела");
  const consumed = await db.prepare(
    "UPDATE admin_handoffs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
  ).bind(nowIso(), handoff.id, nowIso()).run();
  if (!consumed.meta?.changes) throw new ApiError(401, "ADMIN_HANDOFF_CONSUMED", "Ссылка входа уже использована");
  return createAdminSession(env, { id: handoff.telegram_id });
};

const parseCookies = (request) => Object.fromEntries((request.headers.get("Cookie") || "").split(";").map((part) => {
  const [key, ...value] = part.trim().split("=");
  return [key, value.join("=")];
}).filter(([key]) => key));

export const authenticateAdminSession = async (request, env, { requireCsrf = false } = {}) => {
  const token = parseCookies(request).papakha_admin;
  if (!token) throw new ApiError(401, "ADMIN_AUTH_REQUIRED", "Требуется вход в админ-панель");
  const tokenHash = await sha256(token);
  const session = await requireDatabase(env).prepare(
    `SELECT s.*, a.role, a.display_name, a.active, a.revoked_at
     FROM admin_sessions s JOIN admins a ON a.telegram_id = s.telegram_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.active = 1 AND a.revoked_at IS NULL`,
  ).bind(tokenHash, nowIso()).first();
  if (!session) throw new ApiError(401, "ADMIN_SESSION_INVALID", "Сессия недействительна");
  if (requireCsrf && request.headers.get("X-CSRF-Token") !== session.csrf_token) {
    throw new ApiError(403, "CSRF_INVALID", "Защитный токен недействителен");
  }
  return session;
};

export const requireRole = (admin, roles) => {
  if (!roles.includes(admin.role)) throw new ApiError(403, "ADMIN_PERMISSION_DENIED", "Недостаточно прав");
};

export const getSettings = async (env) => {
  const result = await requireDatabase(env).prepare("SELECT key, value, updated_at, updated_by FROM settings ORDER BY key").all();
  return Object.fromEntries((result.results || []).map((row) => {
    try { return [row.key, JSON.parse(row.value)]; } catch { return [row.key, row.value]; }
  }));
};

export const patchSettings = async (env, admin, updates) => {
  const db = requireDatabase(env);
  const allowed = new Set([
    "sell_markup_bps", "buy_markup_bps", "minimum_amount", "maximum_amount",
    "supported_currencies", "automatic_currencies", "rate_lock_minutes",
    "maximum_stale_seconds", "maintenance_mode", "execution_mode",
  ]);
  const entries = Object.entries(updates || {}).filter(([key]) => allowed.has(key));
  if (!entries.length) throw new ApiError(400, "SETTINGS_EMPTY", "Нет настроек для изменения");
  for (const [key, value] of entries) {
    if (key === "sell_markup_bps") assert(Number.isInteger(value) && value >= 0 && value <= 3000, 400, "SETTING_INVALID", "Наценка продажи должна быть от 0% до 30%");
    if (key === "buy_markup_bps") assert(Number.isInteger(value) && value <= 0 && value >= -3000, 400, "SETTING_INVALID", "Корректировка покупки должна быть от −30% до 0%");
    if (key === "rate_lock_minutes") assert(Number.isInteger(value) && value >= 1 && value <= 60, 400, "SETTING_INVALID", "Фиксация курса должна быть от 1 до 60 минут");
    if (key === "maintenance_mode") assert(typeof value === "boolean", 400, "SETTING_INVALID", "Некорректный режим обслуживания");
    if (["minimum_amount", "maximum_amount"].includes(key)) parseDecimal(value);
    if (key === "maximum_stale_seconds") assert(Number.isInteger(value) && value >= 30 && value <= 3600, 400, "SETTING_INVALID", "Допустимый возраст курса должен быть от 30 до 3600 секунд");
    if (["supported_currencies", "automatic_currencies"].includes(key)) {
      const currencies = new Set(["RUB", "USDT", "BTC", "ETH", "KZT", "AED", "USD"]);
      assert(Array.isArray(value) && value.length > 0 && value.every((currency) => currencies.has(currency)), 400, "SETTING_INVALID", "Список валют некорректен");
    }
  }
  if (entries.some(([key, value]) => key === "execution_mode" && value !== "manual")) {
    throw new ApiError(409, "PROVIDER_MODE_NOT_CONFIGURED", "Автоматическое исполнение не настроено");
  }
  const statements = [];
  for (const [key, value] of entries) {
    const previous = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
    statements.push(db.prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(key, JSON.stringify(value), admin.telegram_id, nowIso()));
    statements.push(db.prepare(
      "INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, old_value, new_value) VALUES (?, ?, 'settings_updated', 'setting', ?, ?, ?)",
    ).bind(eventId(), admin.telegram_id, key, previous?.value || null, JSON.stringify(value)));
  }
  await db.batch(statements);
  return getSettings(env);
};

const adminTransitions = Object.freeze({
  assign: { from: ["new", "reviewing"], to: "reviewing", event: "manager_assigned" },
  "payment-confirmed": { from: ["payment_review"], to: "payment_review", event: "payment_confirmed" },
  complete: { from: ["exchange_in_progress"], to: "completed", event: "exchange_completed" },
  cancel: { from: ["new", "reviewing", "rate_offered", "rate_accepted", "awaiting_payment", "payment_review"], to: "cancelled", event: "deal_cancelled" },
  dispute: { from: ["reviewing", "rate_offered", "rate_accepted", "awaiting_payment", "payment_review", "exchange_in_progress"], to: "dispute", event: "dispute_opened" },
});

const notificationText = (action, deal) => ({
  assign: `Заявка ${deal.public_id} принята в работу.`,
  "payment-confirmed": `Оплата по заявке ${deal.public_id} подтверждена.`,
  "start-exchange": `Обмен по заявке ${deal.public_id} начат.`,
  complete: `Заявка ${deal.public_id} завершена.`,
  cancel: `Заявка ${deal.public_id} отменена. Свяжитесь с менеджером, если нужна помощь.`,
  dispute: `По заявке ${deal.public_id} открыта проверка. Менеджер свяжется с вами.`,
}[action]);

export const transitionAdminDeal = async (env, { deal, admin, action, input = {}, idempotencyKey }) => {
  const db = requireDatabase(env);
  const now = nowIso();

  if (action === "message") {
    const message = String(input.message || "").trim().slice(0, 2000);
    assert(message, 400, "MESSAGE_EMPTY", "Введите сообщение клиенту");
    const outboxId = eventId();
    await db.batch([
      db.prepare(`INSERT INTO notification_outbox (id, deal_id, telegram_user_id, event_type, message, created_at)
        VALUES (?, ?, ?, 'manager_message', ?, ?)`)
        .bind(outboxId, deal.id, deal.telegram_user_id, message, now),
      addDealEvent(db, { dealId: deal.id, actorType: "admin", actorId: admin.telegram_id, eventType: "manager_message_queued", fromStatus: deal.status, toStatus: deal.status }),
    ]);
    await enqueueNotification(env, outboxId);
    return getAdminDeal(env, deal.id);
  }

  if (action === "offer-rate") {
    assert(["new", "reviewing", "rate_offered"].includes(deal.status), 409, "INVALID_DEAL_STATUS", "Для этой сделки нельзя предложить курс");
    assert(input.rate && input.receiveAmount, 400, "RATE_OFFER_INVALID", "Укажите курс и сумму получения");
    const minutes = Math.min(Math.max(Number(input.lockMinutes) || 10, 1), 60);
    const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
    const outboxId = eventId();
    const statements = [
      db.prepare(`UPDATE deals SET status = 'rate_offered', quoted_rate = ?, receive_amount = ?, quote_updated_at = ?,
        assigned_admin_id = COALESCE(assigned_admin_id, ?), updated_at = ? WHERE id = ? AND status = ?`)
        .bind(String(input.rate), String(input.receiveAmount), now, admin.telegram_id, now, deal.id, deal.status),
      db.prepare("UPDATE rate_locks SET rejected_at = ? WHERE deal_id = ? AND accepted_at IS NULL AND rejected_at IS NULL").bind(now, deal.id),
      db.prepare(`INSERT INTO rate_locks (id, deal_id, rate, receive_amount, expires_at, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(eventId(), deal.id, String(input.rate), String(input.receiveAmount), expiresAt, admin.telegram_id, now),
      addDealEvent(db, { dealId: deal.id, actorType: "admin", actorId: admin.telegram_id, eventType: "rate_offered", fromStatus: deal.status, toStatus: "rate_offered", payload: { rate: input.rate, receiveAmount: input.receiveAmount, expiresAt } }),
      db.prepare(`INSERT INTO notification_outbox (id, deal_id, telegram_user_id, event_type, message, created_at)
        VALUES (?, ?, ?, 'rate_offered', ?, ?)`)
        .bind(outboxId, deal.id, deal.telegram_user_id, `По заявке ${deal.public_id} предложен предварительный курс. Подтвердите его до ${expiresAt}.`, now),
    ];
    if (input.paymentInstructions) {
      statements.push(db.prepare("UPDATE payment_instructions SET revoked_at = ? WHERE deal_id = ? AND revoked_at IS NULL").bind(now, deal.id));
      statements.push(db.prepare(`INSERT INTO payment_instructions (id, deal_id, instructions, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .bind(eventId(), deal.id, String(input.paymentInstructions).slice(0, 2000), admin.telegram_id, now));
    }
    const result = await db.batch(statements);
    if (!result[0]?.meta?.changes) throw new ApiError(409, "DEAL_CONCURRENTLY_UPDATED", "Статус сделки уже изменён");
    await enqueueNotification(env, outboxId);
    return getAdminDeal(env, deal.id);
  }

  if (action === "start-exchange") {
    assert(["rate_accepted", "payment_review"].includes(deal.status), 409, "INVALID_DEAL_STATUS", "Сделка ещё не готова к обмену");
    assert(deal.rate_expires_at && new Date(deal.rate_expires_at).getTime() > Date.now(), 409, "RATE_EXPIRED", "Срок действия курса истёк");
    if (deal.payment_method !== "Наличные") assert(deal.payment_confirmed_at, 409, "PAYMENT_NOT_CONFIRMED", "Сначала подтвердите оплату");
    assert(idempotencyKey, 400, "IDEMPOTENCY_KEY_REQUIRED", "Отсутствует ключ операции");
    const existing = await db.prepare("SELECT * FROM execution_attempts WHERE deal_id = ? AND idempotency_key = ?").bind(deal.id, idempotencyKey).first();
    if (existing) return getAdminDeal(env, deal.id);
    const outboxId = eventId();
    const result = await db.batch([
      db.prepare("UPDATE deals SET status = 'exchange_in_progress', assigned_admin_id = COALESCE(assigned_admin_id, ?), updated_at = ? WHERE id = ? AND status = ?")
        .bind(admin.telegram_id, now, deal.id, deal.status),
      db.prepare(`INSERT INTO execution_attempts (id, deal_id, idempotency_key, mode, status, created_by, created_at)
        VALUES (?, ?, ?, 'manual', 'started', ?, ?)`)
        .bind(eventId(), deal.id, idempotencyKey, admin.telegram_id, now),
      addDealEvent(db, { dealId: deal.id, actorType: "admin", actorId: admin.telegram_id, eventType: "exchange_started", fromStatus: deal.status, toStatus: "exchange_in_progress" }),
      db.prepare(`INSERT INTO notification_outbox (id, deal_id, telegram_user_id, event_type, message, created_at)
        VALUES (?, ?, ?, 'exchange_started', ?, ?)`)
        .bind(outboxId, deal.id, deal.telegram_user_id, notificationText(action, deal), now),
    ]);
    if (!result[0]?.meta?.changes) throw new ApiError(409, "DEAL_CONCURRENTLY_UPDATED", "Статус сделки уже изменён");
    await enqueueNotification(env, outboxId);
    return getAdminDeal(env, deal.id);
  }

  const transition = adminTransitions[action];
  if (!transition) throw new ApiError(404, "ACTION_NOT_FOUND", "Действие не найдено");
  assert(transition.from.includes(deal.status), 409, "INVALID_DEAL_STATUS", "Действие недоступно для текущего статуса");
  const fields = ["status = ?", "updated_at = ?"];
  const values = [transition.to, now];
  if (action === "assign") { fields.push("assigned_admin_id = ?"); values.push(Number(input.adminId || admin.telegram_id)); }
  if (action === "payment-confirmed") { fields.push("payment_confirmed_at = ?"); values.push(now); }
  if (action === "complete") { fields.push("completed_at = ?"); values.push(now); }
  if (action === "cancel") { fields.push("cancelled_at = ?"); values.push(now); }
  const outboxId = eventId();
  const statements = [
    db.prepare(`UPDATE deals SET ${fields.join(", ")} WHERE id = ? AND status = ?`).bind(...values, deal.id, deal.status),
    addDealEvent(db, { dealId: deal.id, actorType: "admin", actorId: admin.telegram_id, eventType: transition.event, fromStatus: deal.status, toStatus: transition.to, payload: input.reason ? { reason: String(input.reason).slice(0, 500) } : null }),
    db.prepare(`INSERT INTO notification_outbox (id, deal_id, telegram_user_id, event_type, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(outboxId, deal.id, deal.telegram_user_id, transition.event, notificationText(action, deal), now),
  ];
  if (action === "complete") statements.push(db.prepare("UPDATE execution_attempts SET status = 'completed', completed_at = ? WHERE deal_id = ? AND status = 'started'").bind(now, deal.id));
  const result = await db.batch(statements);
  if (!result[0]?.meta?.changes) throw new ApiError(409, "DEAL_CONCURRENTLY_UPDATED", "Статус сделки уже изменён");
  await enqueueNotification(env, outboxId);
  return getAdminDeal(env, deal.id);
};

export const getDashboard = async (env) => {
  const db = requireDatabase(env);
  const [statuses, completed, pending, volumes, stale] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS count FROM deals GROUP BY status").all(),
    db.prepare("SELECT COUNT(*) AS completed_today FROM deals WHERE status = 'completed' AND completed_at >= datetime('now', 'start of day')").first(),
    db.prepare("SELECT COUNT(*) AS pending_notifications FROM notification_outbox WHERE status IN ('pending', 'failed')").first(),
    db.prepare("SELECT give_currency, printf('%.8f', SUM(CAST(give_amount AS REAL))) AS amount FROM deals WHERE created_at >= datetime('now', 'start of day') GROUP BY give_currency").all(),
    db.prepare("SELECT COUNT(*) AS count FROM deals WHERE quote_stale = 1 AND status NOT IN ('completed','cancelled')").first(),
  ]);
  return { statuses: Object.fromEntries((statuses.results || []).map((row) => [row.status, row.count])), completedToday: completed?.completed_today || 0, pendingNotifications: pending?.pending_notifications || 0, volumeToday: volumes.results || [], staleDeals: stale?.count || 0 };
};

export const getAuditLog = async (env, limit = 100) => {
  const result = await requireDatabase(env).prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").bind(Math.min(Math.max(Number(limit) || 100, 1), 200)).all();
  return result.results || [];
};

export const revokeAdminSession = async (env, sessionId) => {
  await requireDatabase(env).prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ?").bind(nowIso(), sessionId).run();
};

export const listAdmins = async (env) => {
  const result = await requireDatabase(env).prepare("SELECT telegram_id, role, display_name, active, created_at, revoked_at FROM admins ORDER BY created_at").all();
  return result.results || [];
};

export const patchAdmin = async (env, owner, input) => {
  const db = requireDatabase(env);
  const telegramId = Number(input?.telegramId);
  assert(Number.isSafeInteger(telegramId) && telegramId > 0, 400, "ADMIN_ID_INVALID", "Некорректный Telegram ID");
  assert(["owner", "manager", "viewer"].includes(input.role), 400, "ADMIN_ROLE_INVALID", "Некорректная роль");
  assert(typeof input.active === "boolean", 400, "ADMIN_STATE_INVALID", "Некорректное состояние доступа");
  assert(telegramId !== owner.telegram_id || input.active, 409, "OWNER_SELF_REVOKE", "Нельзя отозвать собственный доступ");
  const previous = await db.prepare("SELECT * FROM admins WHERE telegram_id = ?").bind(telegramId).first();
  const now = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO admins (telegram_id, role, display_name, active, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET
      role = excluded.role, display_name = excluded.display_name, active = excluded.active, revoked_at = excluded.revoked_at`)
      .bind(telegramId, input.role, String(input.displayName || "").slice(0, 100) || null, input.active ? 1 : 0, input.active ? null : now, now),
    db.prepare(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, old_value, new_value)
      VALUES (?, ?, 'admin_access_updated', 'admin', ?, ?, ?)`)
      .bind(eventId(), owner.telegram_id, String(telegramId), jsonValue(previous), jsonValue({ role: input.role, displayName: input.displayName || null, active: input.active })),
  ]);
  if (!input.active) await db.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE telegram_id = ? AND revoked_at IS NULL").bind(now, telegramId).run();
  return db.prepare("SELECT telegram_id, role, display_name, active, created_at, revoked_at FROM admins WHERE telegram_id = ?").bind(telegramId).first();
};
