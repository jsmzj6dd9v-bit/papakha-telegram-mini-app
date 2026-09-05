import {ApiError, assert} from './errors.js';
export const coreFields=['giveCurrency','amount','receiveCurrency','method'];
export const initialQuestions=[
  {id:'giveCurrency',type:'core',label:'Что отдаёте?',required:true},
  {id:'amount',type:'core',label:'Какую сумму меняем?',required:true},
  {id:'receiveCurrency',type:'core',label:'Что получаете?',required:true},
  {id:'method',type:'core',label:'Как проведём обмен?',required:true},
  {id:'city',type:'text',label:'В каком городе хотите провести обмен?',required:true,conditions:[{field:'method',value:'Наличные'}]},
  {id:'exchange',type:'single',label:'На какой бирже зафиксируем сделку?',required:true,options:['Bybit','HTX (Huobi)','MEXC'],conditions:[{field:'method',value:'Перевод'}]},
];
export function validateQuestions(questions){
  assert(Array.isArray(questions)&&questions.length>=4&&questions.length<=40,400,'FORM_INVALID','Анкета должна содержать от 4 до 40 вопросов');
  const seen=new Set();
  const result=questions.map(q=>{
    assert(q&&/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(q.id)&&!seen.has(q.id),400,'FORM_INVALID','Некорректный или повторяющийся ID вопроса');
    assert(typeof q.label==='string'&&q.label.trim().length>0&&q.label.length<=200,400,'FORM_INVALID','Укажите текст вопроса (до 200 символов)');
    assert(['core','text','number','single','multi'].includes(q.type),400,'FORM_INVALID','Некорректный тип вопроса');
    const core=coreFields.includes(q.id);
    assert(core===(q.type==='core')&&(!core||(q.required===true&&!q.hidden&&!q.conditions?.length)),400,'FORM_INVALID','Основные поля обмена обязательны и не могут быть скрыты');
    const options=['single','multi'].includes(q.type)?q.options:[];
    assert(Array.isArray(options)&&options.length<=50&&options.every(o=>typeof o==='string'&&o.trim()&&o.length<=100)&&new Set(options).size===options.length,400,'FORM_INVALID','Проверьте варианты ответа: до 50 уникальных вариантов');
    if(['single','multi'].includes(q.type)&&!q.hidden)assert(options.length>0,400,'FORM_INVALID','Добавьте хотя бы один вариант ответа');
    const conditions=q.conditions||[];
    assert(Array.isArray(conditions)&&conditions.length<=10&&conditions.every(c=>seen.has(c.field)&&typeof c.value==='string'&&c.value.length<=100),400,'FORM_INVALID','Условие может ссылаться только на предыдущий вопрос');
    seen.add(q.id);
    return {id:q.id,type:q.type,label:q.label.trim(),required:!!q.required,hidden:!!q.hidden,options,conditions:conditions.map(c=>({field:c.field,value:c.value}))};
  });
  assert(coreFields.every(id=>seen.has(id)),400,'FORM_INVALID','Сохраните четыре основных вопроса обмена');
  return result;
}
export function validateAnswers(questions,input,answers={}){
  assert(answers&&typeof answers==='object'&&!Array.isArray(answers),400,'ANSWERS_INVALID','Некорректные ответы');
  const context=Object.create(null);const snapshot=[];
  for(const q of questions){
    if(q.hidden||!(q.conditions||[]).every(c=>Array.isArray(context[c.field])?context[c.field].includes(c.value):String(context[c.field]??'')===c.value))continue;
    let answer=q.type==='core'?input[q.id]:answers[q.id];
    const empty=answer==null||answer===''||(Array.isArray(answer)&&!answer.length);
    assert(!q.required||!empty,400,'ANSWER_REQUIRED',`Ответьте на вопрос: ${q.label}`);
    if(empty)continue;
    if(q.type==='multi')assert(Array.isArray(answer)&&answer.length<=q.options.length&&new Set(answer).size===answer.length&&answer.every(v=>q.options.includes(v)),400,'ANSWER_INVALID',`Проверьте ответ: ${q.label}`);
    else {assert(typeof answer==='string'&&answer.trim().length>0&&answer.length<=1000,400,'ANSWER_INVALID',`Проверьте ответ: ${q.label}`);answer=answer.trim();}
    if(q.type==='single')assert(q.options.includes(answer),400,'ANSWER_INVALID','Выберите ровно одну биржу или вариант из списка');
    if(q.type==='number')assert(Number.isFinite(Number(answer)),400,'ANSWER_INVALID','Введите число');
    context[q.id]=answer;snapshot.push({id:q.id,label:q.label,answer});
  }
  return snapshot;
}
export async function getForm(env){
  const published=await env.DB.prepare('SELECT * FROM questionnaire_versions ORDER BY version DESC LIMIT 1').first();
  const draft=await env.DB.prepare("SELECT value FROM settings WHERE key='questionnaire_draft'").first();
  return {published:published?{version:published.version,questions:JSON.parse(published.questions)}:null,draft:draft?JSON.parse(draft.value):{revision:0,questions:initialQuestions}};
}
export async function saveForm(env,admin,input,publish=false){
  const questions=validateQuestions(input.questions);const now=new Date().toISOString();
  const current=await getForm(env);assert(input.revision===current.draft.revision,409,'FORM_CONFLICT','Анкета изменена в другом окне. Обновите страницу');
  const draft={revision:current.draft.revision+1,questions};
  const statements=[env.DB.prepare(`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('questionnaire_draft',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(JSON.stringify(draft),admin.telegram_id,now)];
  if(publish)statements.push(env.DB.prepare('INSERT INTO questionnaire_versions(version,questions,created_by,created_at) VALUES(?,?,?,?)').bind((current.published?.version||0)+1,JSON.stringify(questions),admin.telegram_id,now));
  statements.push(env.DB.prepare("INSERT INTO audit_events(id,actor_id,action,entity_type,new_value) VALUES(?,? ,?,'questionnaire',?)").bind(crypto.randomUUID(),admin.telegram_id,publish?'questionnaire_published':'questionnaire_saved',JSON.stringify(draft)));
  statements.unshift(env.DB.prepare("INSERT INTO questionnaire_writes(id,valid) VALUES(?,CASE WHEN COALESCE((SELECT json_extract(value,'$.revision') FROM settings WHERE key='questionnaire_draft'),0)=? THEN 1 ELSE 0 END)").bind(crypto.randomUUID(),input.revision));
  try{await env.DB.batch(statements);}catch(e){if(/constraint/i.test(String(e)))throw new ApiError(409,'FORM_CONFLICT','Анкета изменена в другом окне. Загрузите сохранённую версию');throw e;}return getForm(env);
}
export async function startForm(env,user){
  const form=(await getForm(env)).published;
  if(!form)return {sessionId:null,version:null,questions:initialQuestions.slice(0,4)};
  const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO questionnaire_sessions(id,telegram_id,version,expires_at) VALUES(?,?,?,?)').bind(id,user.id,form.version,new Date(Date.now()+86400000).toISOString()).run();
  return {...form,sessionId:id};
}
export async function submissionForm(env,user,input){
  const session=input.questionnaireSession?await env.DB.prepare('SELECT v.version,v.questions FROM questionnaire_sessions s JOIN questionnaire_versions v ON v.version=s.version WHERE s.id=? AND s.telegram_id=? AND s.expires_at>?').bind(input.questionnaireSession,user.id,new Date().toISOString()).first():null;
  if(!session){assert(((await getForm(env)).published?.version||0)===0&&!input.questionnaireSession,409,'FORM_SESSION_EXPIRED','Анкета обновилась или сессия истекла. Откройте приложение заново');return null;}
  return {version:session.version,answers:validateAnswers(JSON.parse(session.questions),input,input.answers||{})};
}
