import { ApiError } from "./errors.js";

const SCALE_DIGITS = 8;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const CURRENCY_DECIMALS = Object.freeze({ RUB: 2, USDT: 2, BTC: 8, ETH: 6 });
const SUPPORTED = new Set(Object.keys(CURRENCY_DECIMALS));

export const parseDecimal = (value, digits = SCALE_DIGITS) => {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) throw new ApiError(400, "INVALID_AMOUNT", "Некорректная сумма");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > digits) throw new ApiError(400, "INVALID_AMOUNT_PRECISION", "Слишком много знаков после запятой");
  return BigInt(whole) * (10n ** BigInt(digits)) + BigInt((fraction + "0".repeat(digits)).slice(0, digits));
};

export const formatDecimal = (scaled, digits = SCALE_DIGITS, outputDigits = digits) => {
  const divisor = 10n ** BigInt(digits);
  const whole = scaled / divisor;
  const fraction = (scaled % divisor).toString().padStart(digits, "0").slice(0, outputDigits);
  return outputDigits ? `${whole}.${fraction}` : whole.toString();
};

const multiply = (left, right) => (left * right) / SCALE;
const divide = (left, right) => {
  if (right <= 0n) throw new ApiError(503, "INVALID_RATE_RESPONSE", "Курс недоступен");
  return (left * SCALE) / right;
};

export const calculateServerQuote = ({ amount, giveCurrency, receiveCurrency, rates }) => {
  if (!SUPPORTED.has(giveCurrency) || !SUPPORTED.has(receiveCurrency) || giveCurrency === receiveCurrency) return null;

  const input = parseDecimal(amount);
  if (input <= 0n) throw new ApiError(400, "INVALID_AMOUNT", "Сумма должна быть больше нуля");

  const sell = parseDecimal(rates?.["USDT/RUB"]?.sellRate);
  const buy = parseDecimal(rates?.["USDT/RUB"]?.buyRate);
  const btc = parseDecimal(rates?.["BTC/USDT"]?.close);
  const eth = parseDecimal(rates?.["ETH/USDT"]?.close);

  let usdt;
  if (giveCurrency === "USDT") usdt = input;
  else if (giveCurrency === "RUB") usdt = divide(input, sell);
  else if (giveCurrency === "BTC") usdt = multiply(input, btc);
  else if (giveCurrency === "ETH") usdt = multiply(input, eth);

  let output;
  if (receiveCurrency === "USDT") output = usdt;
  else if (receiveCurrency === "RUB") output = multiply(usdt, buy);
  else if (receiveCurrency === "BTC") output = divide(usdt, btc);
  else if (receiveCurrency === "ETH") output = divide(usdt, eth);

  if (!output || output <= 0n) throw new ApiError(503, "INVALID_RATE_RESPONSE", "Не удалось рассчитать сумму");

  const outputDigits = CURRENCY_DECIMALS[receiveCurrency];
  return {
    inputAmount: formatDecimal(input, SCALE_DIGITS, CURRENCY_DECIMALS[giveCurrency]),
    outputAmount: formatDecimal(output, SCALE_DIGITS, outputDigits),
    giveCurrency,
    receiveCurrency,
    rate: formatDecimal(divide(output, input), SCALE_DIGITS, outputDigits),
  };
};

export const applyBasisPoints = (value, basisPoints) => {
  const scaled = parseDecimal(value);
  const adjusted = (scaled * BigInt(10000 + Number(basisPoints))) / 10000n;
  return Number(formatDecimal(adjusted, SCALE_DIGITS, SCALE_DIGITS));
};

export const moneyConstants = Object.freeze({ SCALE_DIGITS, CURRENCY_DECIMALS, SUPPORTED });
