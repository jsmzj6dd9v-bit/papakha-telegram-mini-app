const isLocalAdmin = ["localhost", "127.0.0.1"].includes(window.location.hostname);
window.PAPAKHA_ADMIN_CONFIG = Object.freeze({
  apiBaseUrl: isLocalAdmin ? "http://127.0.0.1:8787" : "",
  developmentUserId: isLocalAdmin ? 1001 : null,
  adminLaunchUrl: "https://t.me/papakha_exchange_bot?startapp=admin",
});
