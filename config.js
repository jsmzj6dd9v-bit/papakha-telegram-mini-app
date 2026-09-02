const isLocalPreview = ["localhost", "127.0.0.1"].includes(window.location.hostname);

window.PAPAKHA_CONFIG = Object.freeze({
  ratesApiUrl: isLocalPreview
    ? "http://127.0.0.1:8787/rates"
    : "https://papakha-rapira-rates.jsmzj6dd9v.workers.dev/rates",
});
