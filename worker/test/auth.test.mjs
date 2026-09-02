import assert from "node:assert/strict";
import test from "node:test";
import { verifyTelegramInitData } from "../src/auth.js";

const encoder=new TextEncoder();
const hex=(buffer)=>[...new Uint8Array(buffer)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
const hmac=async(keyBytes,message)=>{const key=await crypto.subtle.importKey("raw",keyBytes,{name:"HMAC",hash:"SHA-256"},false,["sign"]);return crypto.subtle.sign("HMAC",key,encoder.encode(message));};
const signedData=async(token,authDate=Math.floor(Date.now()/1000))=>{
  const params=new URLSearchParams({auth_date:String(authDate),query_id:"test",user:JSON.stringify({id:42,username:"client"})});
  const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join("\n");
  const secret=await hmac(encoder.encode("WebAppData"),token);params.set("hash",hex(await hmac(new Uint8Array(secret),check)));return params.toString();
};

test("accepts a current signed Telegram user",async()=>assert.equal((await verifyTelegramInitData(await signedData("token"),"token",300)).id,42));
test("rejects a forged signature",async()=>{const forged=new URLSearchParams(await signedData("token"));forged.set("hash","bad");await assert.rejects(()=>verifyTelegramInitData(forged.toString(),"token",300),(error)=>error.code==="TELEGRAM_AUTH_INVALID");});
test("rejects expired init data",async()=>{const expired=await signedData("token",Math.floor(Date.now()/1000)-1000);await assert.rejects(()=>verifyTelegramInitData(expired,"token",300),(error)=>error.code==="TELEGRAM_AUTH_EXPIRED");});
