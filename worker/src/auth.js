import { ApiError } from "./errors.js";

const encoder = new TextEncoder();

const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hmac = async (keyBytes, message) => {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
};

export const sha256 = async (value) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const timingSafeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
};

export const verifyTelegramInitData = async (initData, botToken, maxAgeSeconds = 300) => {
  if (!initData || !botToken) throw new ApiError(401, "TELEGRAM_AUTH_REQUIRED", "Требуется авторизация Telegram");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  params.delete("hash");
  const checkString = [...params.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const calculatedHash = hex(await hmac(new Uint8Array(secret), checkString));
  if (!timingSafeEqual(receivedHash, calculatedHash)) throw new ApiError(401, "TELEGRAM_AUTH_INVALID", "Подпись Telegram недействительна");

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) {
    throw new ApiError(401, "TELEGRAM_AUTH_EXPIRED", "Авторизация Telegram устарела");
  }

  try {
    const user = JSON.parse(params.get("user") || "null");
    if (!user?.id) throw new Error("missing user");
    return user;
  } catch {
    throw new ApiError(401, "TELEGRAM_USER_INVALID", "Данные пользователя Telegram некорректны");
  }
};

export const authenticateTelegram = async (request, env) => {
  const devUser = request.headers.get("X-Dev-Telegram-User");
  if (env.ENVIRONMENT === "development" && env.DEV_AUTH_ENABLED === "true" && devUser) {
    const id = Number(devUser);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(401, "DEV_AUTH_INVALID", "Некорректный тестовый пользователь");
    return { id, username: `dev_${id}`, first_name: "Local", last_name: "User", isDev: true };
  }
  const initData = request.headers.get("X-Telegram-Init-Data") || request.headers.get("Authorization")?.replace(/^tma\s+/i, "");
  return verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, Number(env.INIT_DATA_MAX_AGE_SECONDS || 300));
};

export const randomToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
