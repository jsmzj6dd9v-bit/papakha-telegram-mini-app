import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { availableActions } from "../src/admin-workflow.js";
import { getAdminDeal, listAdminDeals, transitionAdminDeal } from "../src/db.js";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for(const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir),"utf8"));
  sqlite.exec(`INSERT INTO admins (telegram_id,role) VALUES (1,'owner'),(2,'manager'),(3,'manager'),(4,'viewer');
    INSERT INTO telegram_users (telegram_id) VALUES (100);
    INSERT INTO deals (id,public_id,telegram_user_id,client_request_id,status,give_currency,give_amount,receive_currency,payment_method) VALUES ('deal','TEST',100,'request','new','RUB','100','USDT','Перевод');`);
  const DB = {prepare(sql) {const statement={values:[],bind(...values){this.values=values;return this;},async first(){return sqlite.prepare(sql).get(...this.values)||null;},async all(){return {results:sqlite.prepare(sql).all(...this.values)};},async run(){return {meta:sqlite.prepare(sql).run(...this.values)};}};return statement;},async batch(statements){sqlite.exec("BEGIN");try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec("COMMIT");return results;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
  return {sqlite,env:{DB}, manager:{telegram_id:2,role:"manager"}};
}
test("stage actions respect ownership, roles, payment and expiry",()=>{
  const d={status:"payment_review",assigned_admin_id:2,payment_method:"Перевод",rate_expires_at:new Date(Date.now()+60000).toISOString()};
  const a={telegram_id:2,role:"manager"};
  assert.ok(availableActions(d,a).includes("payment-confirmed"));
  assert.ok(!availableActions(d,a).includes("start-exchange"));
  assert.ok(availableActions({...d,payment_confirmed_at:"now"},a).includes("start-exchange"));
  assert.deepEqual(availableActions(d,{telegram_id:3,role:"manager"}),[]);
  assert.deepEqual(availableActions(d,{telegram_id:2,role:"viewer"}),[]);
  assert.ok(!availableActions({...d,payment_confirmed_at:"now",rate_expires_at:"2000-01-01"},a).includes("start-exchange"));
});
test("concurrent claims roll back all losing side effects; retries are idempotent",async()=>{
  const {sqlite,env,manager}=setup();const snapshot=await getAdminDeal(env,"deal");
  await transitionAdminDeal(env,{deal:snapshot,admin:manager,action:"assign",idempotencyKey:"claim"});
  await assert.rejects(transitionAdminDeal(env,{deal:snapshot,admin:{telegram_id:3,role:"manager"},action:"assign",idempotencyKey:"other"}),e=>e.code==="DEAL_CONCURRENTLY_UPDATED");
  await transitionAdminDeal(env,{deal:await getAdminDeal(env,"deal"),admin:manager,action:"assign",idempotencyKey:"claim"});
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM deal_events").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM admin_operations").get().n,1);
});
test("transfer requires reason and active manager; previous manager loses write access",async()=>{
  const {env,manager}=setup();
  await transitionAdminDeal(env,{deal:await getAdminDeal(env,"deal"),admin:manager,action:"assign"});
  const deal=await getAdminDeal(env,"deal");
  await assert.rejects(transitionAdminDeal(env,{deal,admin:manager,action:"transfer",input:{adminId:3}}));
  await assert.rejects(transitionAdminDeal(env,{deal,admin:manager,action:"transfer",input:{adminId:4,reason:"Передача"}}));
  await transitionAdminDeal(env,{deal,admin:manager,action:"transfer",input:{adminId:3,reason:"Передача смены"}});
  const updated=await getAdminDeal(env,"deal");assert.equal(updated.assigned_admin_id,3);
  await assert.rejects(transitionAdminDeal(env,{deal:updated,admin:manager,action:"message",input:{message:"text"}}));
  assert.equal((await listAdminDeals(env,{view:"mine",adminId:3})).length,1);
  assert.equal((await listAdminDeals(env,{view:"mine",adminId:2})).length,0);
});
test("complete flow and stale revision preserve correct state",async()=>{
  const {env,manager,sqlite}=setup();
  const act=async(action,input={})=>transitionAdminDeal(env,{deal:await getAdminDeal(env,"deal"),admin:manager,action,input});
  await act("assign");await act("offer-rate",{rate:"100",receiveAmount:"1",paymentInstructions:"Test"});
  sqlite.exec("UPDATE deals SET status='payment_review'");
  await act("payment-confirmed");await act("start-exchange",{}).catch(e=>{assert.equal(e.code,"IDEMPOTENCY_KEY_REQUIRED");});
  await transitionAdminDeal(env,{deal:await getAdminDeal(env,"deal"),admin:manager,action:"start-exchange",idempotencyKey:"start"});
  await assert.rejects(act("complete",{expectedRevision:0}),e=>e.code==="DEAL_CONCURRENTLY_UPDATED");
  await act("complete");assert.equal((await getAdminDeal(env,"deal")).status,"completed");
  assert.equal((await listAdminDeals(env,{view:"archive"})).length,1);
});
