import { requireDatabase } from "./db.js";

const neutralError = (error) => error?.name === "AbortError" ? "NOTIFICATION_TIMEOUT" : "NOTIFICATION_FAILED";

export const deliverNotification = async (env, outboxId) => {
  const db = requireDatabase(env);
  const item = await db.prepare(`SELECT o.*, d.public_id FROM notification_outbox o
    LEFT JOIN deals d ON d.id = o.deal_id WHERE o.id = ?`).bind(outboxId).first();
  if (!item || item.status === "sent") return;
  await db.prepare("UPDATE notification_outbox SET status = 'processing', attempt_count = attempt_count + 1 WHERE id = ?").bind(item.id).run();
  try {
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error("NOTIFICATION_NOT_CONFIGURED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let response;
    try {
      const appUrl = env.MINI_APP_URL ? new URL(env.MINI_APP_URL) : null;
      if (appUrl && item.public_id) appUrl.searchParams.set("deal", item.public_id);
      response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ chat_id: item.telegram_user_id, text: item.message,
          reply_markup: appUrl ? { inline_keyboard: [[{ text: "Открыть заявку", web_app: { url: appUrl.toString() } }]] } : undefined }),
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) {
      console.error("Telegram notification rejected", { status: response.status });
      throw new Error("NOTIFICATION_REJECTED");
    }
    await db.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(new Date().toISOString(), item.id).run();
  } catch (error) {
    const nextAttempt = new Date(Date.now() + Math.min(300000, 5000 * (2 ** Math.min(item.attempt_count, 6)))).toISOString();
    await db.prepare("UPDATE notification_outbox SET status = 'failed', last_error = ?, next_attempt_at = ? WHERE id = ?").bind(neutralError(error), nextAttempt, item.id).run();
    throw error;
  }
};

export const processPendingNotifications = async (env, limit = 20) => {
  const rows = await requireDatabase(env).prepare("SELECT id FROM notification_outbox WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?")
    .bind(new Date().toISOString(), limit).all();
  for (const row of rows.results || []) {
    try { await deliverNotification(env, row.id); } catch { /* The next scheduled run retries it. */ }
  }
};

export const createExpiryNotifications = async (env) => {
  const db = requireDatabase(env);
  const rows = await db.prepare(`SELECT rl.id, d.id AS deal_id, d.public_id, d.telegram_user_id, rl.expires_at
    FROM rate_locks rl JOIN deals d ON d.id = rl.deal_id
    WHERE d.status = 'rate_offered' AND rl.accepted_at IS NULL AND rl.rejected_at IS NULL
      AND rl.expires_at > ? AND rl.expires_at <= ?`)
    .bind(new Date().toISOString(), new Date(Date.now() + 2 * 60000).toISOString()).all();
  for (const row of rows.results || []) {
    const eventType = `rate_expiring_${row.id}`;
    await db.prepare(`INSERT INTO notification_outbox (id, deal_id, telegram_user_id, event_type, message, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM notification_outbox WHERE event_type = ?)`)
      .bind(crypto.randomUUID(), row.deal_id, row.telegram_user_id, eventType, `Предварительный курс по заявке ${row.public_id} скоро истечёт.`, new Date().toISOString(), eventType).run();
  }
};
