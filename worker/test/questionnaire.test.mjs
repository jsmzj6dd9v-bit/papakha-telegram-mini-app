import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {initialQuestions,validateQuestions,validateAnswers,getForm,saveForm,startForm,submissionForm} from '../src/questionnaire.js';
const input={giveCurrency:'RUB',receiveCurrency:'USDT',amount:'100',method:'Наличные'};
test('cash requires text city; online requires exactly one permitted exchange',()=>{
  const q=validateQuestions(initialQuestions);
  assert.throws(()=>validateAnswers(q,input,{}));
  const cash=validateAnswers(q,input,{city:'Тестовый город',exchange:'Bybit'});
  assert.ok(cash.some(a=>a.id==='city'));assert.ok(!cash.some(a=>a.id==='exchange'));
  for(const exchange of [undefined,['Bybit','MEXC'],'unknown'])assert.throws(()=>validateAnswers(q,{...input,method:'Перевод'},{exchange}));
  assert.equal(validateAnswers(q,{...input,method:'Перевод'},{exchange:'MEXC',city:'old'}).at(-1).answer,'MEXC');
});
test('core fields, choices, unique IDs and forward-only dependencies are validated',()=>{
  const clone=()=>structuredClone(initialQuestions);
  let q=clone();q[0].hidden=true;assert.throws(()=>validateQuestions(q));
  q=clone();q[5].options=[];assert.throws(()=>validateQuestions(q));
  q=clone();[q[3],q[4]]=[q[4],q[3]];assert.throws(()=>validateQuestions(q));
  q=clone();q.push({...q[4]});assert.throws(()=>validateQuestions(q));
  q=clone();q.push({id:'detail',type:'text',label:'Уточнение',required:true,conditions:[{field:'exchange',value:'MEXC'}]});
  validateQuestions(q);assert.throws(()=>validateAnswers(q,{...input,method:'Перевод'},{exchange:'MEXC'}));
});
function setup(){
  const sql=new DatabaseSync(':memory:');const dir=new URL('../migrations/',import.meta.url);for(const f of readdirSync(dir).sort())sql.exec(readFileSync(new URL(f,dir),'utf8'));
  sql.exec("INSERT INTO admins(telegram_id,role) VALUES(1,'owner')");
  return {sql,env:{DB:{prepare(query){return {values:[],bind(...v){this.values=v;return this;},async first(){return sql.prepare(query).get(...this.values)||null;},async run(){return {meta:sql.prepare(query).run(...this.values)};}};},async batch(list){sql.exec('BEGIN');try{const out=[];for(const s of list)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}}}};
}
test('draft does not change active form; publish preserves old issued sessions',async()=>{
  const {env,sql}=setup();const old=await startForm(env,{id:10});assert.equal(old.version,0);
  await saveForm(env,{telegram_id:1},{revision:0,questions:initialQuestions});
  assert.equal((await getForm(env)).published.version,0);
  await saveForm(env,{telegram_id:1},{revision:1,questions:initialQuestions},true);
  const current=await startForm(env,{id:10});assert.equal(current.version,1);
  const before=await submissionForm(env,{id:10},{...input,questionnaireSession:old.sessionId});assert.equal(before.version,0);
  await assert.rejects(submissionForm(env,{id:10},{...input,questionnaireSession:current.sessionId}));
  const valid=await submissionForm(env,{id:10},{...input,questionnaireSession:current.sessionId,answers:{city:'Город'}});assert.equal(valid.answers.at(-1).answer,'Город');
  await assert.rejects(submissionForm(env,{id:11},{...input,questionnaireSession:current.sessionId,answers:{city:'Город'}}));
  sql.exec("UPDATE questionnaire_sessions SET expires_at='2000-01-01'");
  await assert.rejects(submissionForm(env,{id:10},{...input,questionnaireSession:current.sessionId}));
  assert.throws(()=>sql.exec("UPDATE questionnaire_versions SET questions='[]'"));
});
test('concurrent owner edits cannot silently overwrite a saved draft',async()=>{
  const {env}=setup();const body={revision:0,questions:initialQuestions};
  const results=await Promise.allSettled([saveForm(env,{telegram_id:1},body),saveForm(env,{telegram_id:1},body)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
