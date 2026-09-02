const isLocalPreview = ["localhost", "127.0.0.1"].includes(window.location.hostname);

window.PAPAKHA_CONFIG = Object.freeze({
  apiBaseUrl: isLocalPreview
    ? "http://127.0.0.1:8787"
    : "https://papakha-rates.jsmzj6dd9v.workers.dev",
  developmentUserId: isLocalPreview ? 1001 : null,
});
