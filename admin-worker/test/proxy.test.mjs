import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("proxies only admin API routes through the service binding", async () => {
  let proxied = false;
  const env = {
    RATES_API: { async fetch(request) { proxied = true; return new Response(new URL(request.url).pathname); } },
    ASSETS: { async fetch() { return new Response("asset"); } },
  };
  const response = await worker.fetch(new Request("https://admin.example/api/admin/session"), env);
  assert.equal(await response.text(), "/api/admin/session");
  assert.equal(proxied, true);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
});

test("serves static assets without exposing the backend binding", async () => {
  const env = {
    RATES_API: { async fetch() { throw new Error("must not proxy"); } },
    ASSETS: { async fetch() { return new Response("admin app"); } },
  };
  const response = await worker.fetch(new Request("https://admin.example/"), env);
  assert.equal(await response.text(), "admin app");
});
