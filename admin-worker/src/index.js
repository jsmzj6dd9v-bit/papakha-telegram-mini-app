const securityHeaders = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const withSecurityHeaders = (response) => {
  const secured = new Response(response.body, response);
  Object.entries(securityHeaders).forEach(([key, value]) => secured.headers.set(key, value));
  return secured;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return withSecurityHeaders(new Response(JSON.stringify({ ok: true, service: "papakha-admin" }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      }));
    }
    if (url.pathname.startsWith("/api/admin/")) {
      return withSecurityHeaders(await env.RATES_API.fetch(request));
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
