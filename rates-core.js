((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PapakhaRates = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  "use strict";

  const SUPPORTED = new Set(["RUB", "USDT", "BTC", "ETH"]);
  const DECIMALS = Object.freeze({ RUB: 2, USDT: 2, BTC: 8, ETH: 6 });

  const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

  const validatePayload = (payload) => {
    const usdt = payload?.rates?.["USDT/RUB"];
    const btc = payload?.rates?.["BTC/USDT"];
    const eth = payload?.rates?.["ETH/USDT"];
    return Boolean(
      payload?.ok &&
      payload?.updatedAt &&
      positive(usdt?.sellRate) &&
      positive(usdt?.buyRate) &&
      positive(btc?.close) &&
      positive(eth?.close)
    );
  };

  const toUsdt = (amount, currency, rates) => {
    if (currency === "USDT") return amount;
    if (currency === "BTC") return amount * Number(rates["BTC/USDT"].close);
    if (currency === "ETH") return amount * Number(rates["ETH/USDT"].close);
    if (currency === "RUB") return amount / Number(rates["USDT/RUB"].sellRate);
    return null;
  };

  const fromUsdt = (amount, currency, rates) => {
    if (currency === "USDT") return amount;
    if (currency === "BTC") return amount / Number(rates["BTC/USDT"].close);
    if (currency === "ETH") return amount / Number(rates["ETH/USDT"].close);
    if (currency === "RUB") return amount * Number(rates["USDT/RUB"].buyRate);
    return null;
  };

  const calculateQuote = ({ amount, giveCurrency, receiveCurrency, payload }) => {
    const numericAmount = Number(amount);
    if (!positive(numericAmount) || giveCurrency === receiveCurrency) return null;
    if (!SUPPORTED.has(giveCurrency) || !SUPPORTED.has(receiveCurrency)) return null;
    if (!validatePayload(payload)) return null;
    const automatic = new Set(payload.automaticCurrencies || ["RUB", "USDT", "BTC", "ETH"]);
    if (!automatic.has(giveCurrency) || !automatic.has(receiveCurrency)) return null;

    const usdtAmount = toUsdt(numericAmount, giveCurrency, payload.rates);
    const outputAmount = fromUsdt(usdtAmount, receiveCurrency, payload.rates);
    if (!positive(outputAmount)) return null;

    return {
      outputAmount,
      outputDecimals: DECIMALS[receiveCurrency],
      rate: outputAmount / numericAmount,
      rateDecimals: DECIMALS[receiveCurrency],
      giveCurrency,
      receiveCurrency,
      updatedAt: payload.updatedAt,
      stale: Boolean(payload.stale),
    };
  };

  const formatNumber = (value, decimals) => Number(value).toLocaleString("ru-RU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  });

  return Object.freeze({ calculateQuote, formatNumber, validatePayload });
});
