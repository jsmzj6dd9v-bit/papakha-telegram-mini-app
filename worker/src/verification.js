import { ApiError, assert } from "./errors.js";
import { requireDatabase } from "./db.js";
import { sha256Bytes, mapSumsubReview } from "./sumsub.js";

const nowIso = () => new Date().toISOString();
const allowedStatuses = new Set(["unverified", "pending", "approved", "review", "retry", "declined", "expired", "error"]);

const upsertTelegramUser = (db, user, now) => db.prepare(`INSERT INTO telegram_users
  (telegram_id, username, first_name, last_name, language_code, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET
  username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name,
  language_code=excluded.language_code, updated_at=excluded.updated_at`)
  .bind(user.id, user.username || null, user.first_name || null, user.last_name || null, user.language_code || null, now, now);

export const kycRequiredForUser = (env, telegramId) => {
  const enforcement = String(env.KYC_ENFORCEMENT || "off");
  if (enforcement === "off") return false;
  if (enforcement === "all") throw new ApiError(503, "KYC_PRODUCTION_BLOCKED", "Обязательная production-верификация пока заблокирована");
  if (enforcement !== "owner_only") return false;
  return String(env.KYC_TEST_TELEGRAM_IDS || "").split(",").map((value) => value.trim()).includes(String(telegramId));
};

export const verificationIsValid = (verification, now = Date.now()) => Boolean(
  verification?.status === "approved" && verification.aml_status === "clear" && !verification.revoked_at
  && (!verification.document_expires_at || new Date(verification.document_expires_at).getTime() > now)
);

export const publicVerification = (verification, required) => ({
  required,
  status: verification ? (verificationIsValid(verification) ? "approved" : verification.status === "approved" ? "expired" : verification.status) : "unverified",
  amlStatus: verification?.aml_status || "unknown",
  canCreateDeal: !required || verificationIsValid(verification),
  verifiedAt: verification?.verified_at || null,
  updatedAt: verification?.updated_at || null,
});

export const getVerificationForUser = async (env, user) => {
  const db = requireDatabase(env);
  const verification = await db.prepare("SELECT * FROM identity_verifications WHERE telegram_user_id = ?").bind(user.id).first();
  return { verification, public: publicVerification(verification, kycRequiredForUser(env, user.id)) };
};

export const ensureVerification = async (env, user) => {
  const db = requireDatabase(env);
  const existing = await db.prepare("SELECT * FROM identity_verifications WHERE telegram_user_id = ?").bind(user.id).first();
  if (existing) return existing;
  const now = nowIso();
  const id = crypto.randomUUID();
  const externalUserId = crypto.randomUUID();
  await db.batch([
    upsertTelegramUser(db, user, now),
    db.prepare(`INSERT INTO identity_verifications
      (id, telegram_user_id, external_user_id, status, aml_status, created_at, updated_at)
      VALUES (?, ?, ?, 'unverified', 'unknown', ?, ?)`).bind(id, user.id, externalUserId, now, now),
    db.prepare(`INSERT INTO verification_events
      (id, verification_id, actor_type, event_type, to_status, created_at)
      VALUES (?, ?, 'system', 'verification_created', 'unverified', ?)`).bind(crypto.randomUUID(), id, now),
  ]);
  return db.prepare("SELECT * FROM identity_verifications WHERE id = ?").bind(id).first();
};

export const markVerificationSessionStarted = async (env, verification) => {
  if (verificationIsValid(verification)) return verification;
  const db = requireDatabase(env);
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE identity_verifications SET status='pending', review_reason_code=NULL, revoked_at=NULL, updated_at=? WHERE id=?")
      .bind(now, verification.id),
    db.prepare(`INSERT INTO verification_events
      (id, verification_id, actor_type, event_type, from_status, to_status, created_at)
      VALUES (?, ?, 'system', 'sdk_session_started', ?, 'pending', ?)`)
      .bind(crypto.randomUUID(), verification.id, verification.status, now),
  ]);
  return db.prepare("SELECT * FROM identity_verifications WHERE id = ?").bind(verification.id).first();
};

export const requireApprovedVerification = async (env, user) => {
  const required = kycRequiredForUser(env, user.id);
  if (!required) return null;
  const verification = (await getVerificationForUser(env, user)).verification;
  if (verificationIsValid(verification)) return verification;
  const status = verification?.status || "unverified";
  const codes = { unverified: "KYC_REQUIRED", pending: "KYC_PENDING", review: "KYC_REVIEW", retry: "KYC_RETRY", declined: "KYC_DECLINED", expired: "KYC_REQUIRED", error: "KYC_UNAVAILABLE" };
  const messages = { unverified: "Перед отправкой заявки пройдите проверку", pending: "Данные ещё проверяются", review: "Требуется решение специалиста", retry: "Продолжите проверку данных", declined: "Создание сделки недоступно", expired: "Требуется повторная проверка", error: "Сервис проверки временно недоступен" };
  throw new ApiError(status === "declined" ? 403 : 409, codes[status] || "KYC_REQUIRED", messages[status] || messages.unverified);
};

export const processVerificationWebhook = async (env, payload, rawBody) => {
  const db = requireDatabase(env);
  const payloadHash = await sha256Bytes(rawBody);
  const eventKey = String(payload.id || payload.correlationId || payloadHash);
  const existing = await db.prepare("SELECT id FROM verification_webhook_events WHERE provider_event_key = ?").bind(eventKey).first();
  if (existing) return { duplicate: true };
  const applicantId = String(payload.applicantId || "");
  const externalUserId = String(payload.externalUserId || "");
  const verification = applicantId
    ? await db.prepare("SELECT * FROM identity_verifications WHERE provider_applicant_id = ? OR external_user_id = ?").bind(applicantId, externalUserId).first()
    : await db.prepare("SELECT * FROM identity_verifications WHERE external_user_id = ?").bind(externalUserId).first();
  if (!verification || (verification.provider_applicant_id && applicantId && verification.provider_applicant_id !== applicantId)) {
    throw new ApiError(409, "KYC_APPLICANT_MISMATCH", "Событие относится к неизвестной проверке");
  }
  const mapped = ["applicantReviewed", "applicantOnHold"].includes(payload.type) ? mapSumsubReview(payload) : { status: "pending", amlStatus: verification.aml_status || "unknown", reasonCode: null };
  assert(allowedStatuses.has(mapped.status), 400, "KYC_EVENT_INVALID", "Некорректный статус проверки");
  const now = nowIso();
  const verifiedAt = mapped.status === "approved" ? now : verification.verified_at;
  try { await db.batch([
    db.prepare(`UPDATE identity_verifications SET provider_applicant_id = COALESCE(provider_applicant_id, ?),
      status = ?, aml_status = ?, review_reason_code = ?, verified_at = ?, last_event_at = ?, updated_at = ? WHERE id = ?`)
      .bind(applicantId || null, mapped.status, mapped.amlStatus, mapped.reasonCode, verifiedAt, now, now, verification.id),
    db.prepare(`INSERT INTO verification_events
      (id, verification_id, actor_type, actor_id, event_type, from_status, to_status, reason_code, created_at)
      VALUES (?, ?, 'provider', NULL, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), verification.id, String(payload.type || "verification_event").slice(0, 100), verification.status, mapped.status, mapped.reasonCode, now),
    db.prepare(`INSERT INTO verification_webhook_events
      (id, provider_event_key, provider_applicant_id, event_type, payload_sha256, outcome, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), eventKey, applicantId || null, String(payload.type || "unknown").slice(0, 100), payloadHash, mapped.status, now),
  ]); } catch (error) {
    const duplicate = await db.prepare("SELECT id FROM verification_webhook_events WHERE provider_event_key = ?").bind(eventKey).first();
    if (duplicate) return { duplicate: true };
    throw error;
  }
  return { duplicate: false, status: mapped.status };
};

export const listVerifications = async (env, filters = {}) => {
  const db = requireDatabase(env);
  const bindings = [];
  let where = "";
  if (filters.status && allowedStatuses.has(filters.status)) { where = "WHERE v.status = ?"; bindings.push(filters.status); }
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 200);
  const result = await db.prepare(`SELECT v.id, v.telegram_user_id, v.status, v.aml_status, v.review_reason_code,
    v.verified_at, v.last_event_at, v.created_at, v.updated_at, u.username, u.first_name
    FROM identity_verifications v JOIN telegram_users u ON u.telegram_id = v.telegram_user_id
    ${where} ORDER BY v.updated_at DESC LIMIT ?`).bind(...bindings, limit).all();
  return result.results || [];
};

export const getAdminVerification = async (env, id) => {
  const db = requireDatabase(env);
  const verification = await db.prepare(`SELECT v.id, v.telegram_user_id, v.status, v.aml_status, v.review_reason_code,
    v.verified_at, v.last_event_at, v.document_expires_at, v.created_at, v.updated_at, u.username, u.first_name
    FROM identity_verifications v JOIN telegram_users u ON u.telegram_id = v.telegram_user_id WHERE v.id = ?`).bind(id).first();
  if (!verification) throw new ApiError(404, "KYC_NOT_FOUND", "Проверка не найдена");
  const events = await db.prepare("SELECT * FROM verification_events WHERE verification_id = ? ORDER BY created_at DESC LIMIT 100").bind(id).all();
  return { ...verification, events: events.results || [] };
};

export const decideVerification = async (env, { id, admin, action, reason }) => {
  const cleanReason = String(reason || "").trim();
  assert(cleanReason.length >= 10 && cleanReason.length <= 500, 400, "KYC_REASON_REQUIRED", "Укажите причину от 10 до 500 символов");
  const db = requireDatabase(env);
  const current = await db.prepare("SELECT * FROM identity_verifications WHERE id = ?").bind(id).first();
  if (!current) throw new ApiError(404, "KYC_NOT_FOUND", "Проверка не найдена");
  if (["approve", "reject"].includes(action)) assert(current.status === "review", 409, "KYC_STATUS_INVALID", "Ручное решение доступно только для статуса review");
  if (action === "approve") assert(current.aml_status !== "blocked", 409, "KYC_AML_BLOCKED", "Проверку с блокирующим AML-сигналом нельзя одобрить вручную");
  const next = action === "approve" ? { status: "approved", aml: "clear" } : action === "reject" ? { status: "declined", aml: "blocked" } : action === "reset" ? { status: "unverified", aml: "unknown" } : null;
  if (!next) throw new ApiError(404, "ACTION_NOT_FOUND", "Действие не найдено");
  const now = nowIso();
  await db.batch([
    db.prepare(`UPDATE identity_verifications SET status=?, aml_status=?, review_reason_code=?,
      verified_at=?, revoked_at=?, external_user_id=?, provider_applicant_id=?, document_expires_at=?, updated_at=? WHERE id=?`)
      .bind(next.status, next.aml, action === "reset" ? "OWNER_RESET" : "OWNER_DECISION", action === "approve" ? now : null,
        action === "reset" ? now : current.revoked_at, action === "reset" ? crypto.randomUUID() : current.external_user_id,
        action === "reset" ? null : current.provider_applicant_id, action === "reset" ? null : current.document_expires_at, now, id),
    db.prepare(`INSERT INTO verification_events
      (id, verification_id, actor_type, actor_id, event_type, from_status, to_status, reason_code, created_at)
      VALUES (?, ?, 'admin', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, String(admin.telegram_id), `manual_${action}`, current.status, next.status, cleanReason, now),
    db.prepare(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, old_value, new_value)
      VALUES (?, ?, ?, 'identity_verification', ?, ?, ?)`)
      .bind(crypto.randomUUID(), admin.telegram_id, `verification_${action}`, id, JSON.stringify({ status: current.status, amlStatus: current.aml_status }), JSON.stringify({ status: next.status, amlStatus: next.aml, reason: cleanReason })),
  ]);
  return getAdminVerification(env, id);
};
