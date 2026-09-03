import assert from "node:assert/strict";
import test from "node:test";
import { kycRequiredForUser, publicVerification, verificationIsValid } from "../src/verification.js";
import { mapSumsubReview, timingSafeEqual, verifySumsubWebhook } from "../src/sumsub.js";

test("owner_only gates only the configured Telegram ID and all remains blocked", () => {
  const env = { KYC_ENFORCEMENT:"owner_only", KYC_TEST_TELEGRAM_IDS:"8321831931, 42" };
  assert.equal(kycRequiredForUser(env, 8321831931), true);
  assert.equal(kycRequiredForUser(env, 7), false);
  assert.throws(() => kycRequiredForUser({ KYC_ENFORCEMENT:"all" }, 7), (error) => error.code === "KYC_PRODUCTION_BLOCKED");
});

test("only a current approved verification with clear AML is valid", () => {
  const approved = { status:"approved", aml_status:"clear", revoked_at:null, document_expires_at:null, verified_at:"2026-01-01", updated_at:"2026-01-01" };
  assert.equal(verificationIsValid(approved), true);
  assert.equal(verificationIsValid({ ...approved, aml_status:"review" }), false);
  assert.equal(verificationIsValid({ ...approved, document_expires_at:"2020-01-01" }), false);
  assert.equal(publicVerification(approved, true).canCreateDeal, true);
});

test("maps provider outcomes to neutral KYC states", () => {
  assert.deepEqual(mapSumsubReview({reviewStatus:"completed",reviewResult:{reviewAnswer:"GREEN"}}),{status:"approved",amlStatus:"clear",reasonCode:null});
  assert.equal(mapSumsubReview({reviewStatus:"completed",reviewResult:{reviewAnswer:"RED",reviewRejectType:"RETRY"}}).status,"retry");
  assert.equal(mapSumsubReview({reviewStatus:"completed",reviewResult:{reviewAnswer:"RED",reviewRejectType:"FINAL"}}).status,"declined");
  assert.equal(mapSumsubReview({reviewStatus:"onHold",reviewResult:{}}).status,"review");
  assert.equal(mapSumsubReview({reviewStatus:"completed",reviewResult:{reviewAnswer:"GREEN"},amlStatus:"YELLOW"}).status,"review");
});

test("validates webhook HMAC over the exact raw body", async () => {
  const secret="sandbox-secret";
  const raw=new TextEncoder().encode('{"type":"applicantReviewed"}');
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signed=await crypto.subtle.sign("HMAC",key,raw);
  const digest=[...new Uint8Array(signed)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
  const request=new Request("https://example.test/webhook",{method:"POST",headers:{"X-Payload-Digest-Alg":"HMAC_SHA256_HEX","X-Payload-Digest":digest}});
  await verifySumsubWebhook(raw.buffer,request,{SUMSUB_WEBHOOK_SECRET:secret});
  const forged=new Request(request,{headers:{"X-Payload-Digest-Alg":"HMAC_SHA256_HEX","X-Payload-Digest":"00"}});
  await assert.rejects(()=>verifySumsubWebhook(raw.buffer,forged,{SUMSUB_WEBHOOK_SECRET:secret}),(error)=>error.code==="KYC_WEBHOOK_INVALID");
  assert.equal(timingSafeEqual(digest,digest),true);
  assert.equal(timingSafeEqual(digest,`${digest}0`),false);
});
