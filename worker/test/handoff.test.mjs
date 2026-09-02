import assert from "node:assert/strict";
import test from "node:test";
import { createAdminHandoff, exchangeAdminHandoff } from "../src/db.js";

const fakeEnvironment = () => {
  const state = { handoff: null, sessions: [] };
  const admin = { telegram_id: 8321831931, role: "owner", display_name: "Владелец", active: 1, revoked_at: null };
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM admins")) return Number(values[0]) === admin.telegram_id ? admin : null;
              if (sql.includes("FROM admin_handoffs")) {
                return state.handoff && state.handoff.code_hash === values[0] && !state.handoff.consumed_at && state.handoff.expires_at > values[1]
                  ? state.handoff : null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO admin_handoffs")) {
                state.handoff = { id: values[0], code_hash: values[1], telegram_id: values[2], expires_at: values[3], consumed_at: null };
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE admin_handoffs")) {
                if (!state.handoff || state.handoff.id !== values[1] || state.handoff.consumed_at) return { meta: { changes: 0 } };
                state.handoff.consumed_at = values[0];
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO admin_sessions")) {
                state.sessions.push(values);
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return { env: { DB, ADMIN_APP_URL: "https://admin.example/" }, state };
};

test("creates a 60-second handoff and consumes it only once", async () => {
  const { env, state } = fakeEnvironment();
  const handoff = await createAdminHandoff(env, { id: 8321831931 });
  const code = new URL(handoff.adminUrl).searchParams.get("code");
  assert.ok(code);
  assert.equal(state.handoff.telegram_id, 8321831931);
  const session = await exchangeAdminHandoff(env, code);
  assert.equal(session.admin.role, "owner");
  assert.equal(state.sessions.length, 1);
  await assert.rejects(() => exchangeAdminHandoff(env, code), (error) => error.code === "ADMIN_HANDOFF_INVALID");
});

test("denies handoff creation for a Telegram user outside the admin list", async () => {
  const { env } = fakeEnvironment();
  await assert.rejects(() => createAdminHandoff(env, { id: 42 }), (error) => error.code === "ADMIN_ACCESS_DENIED");
});
