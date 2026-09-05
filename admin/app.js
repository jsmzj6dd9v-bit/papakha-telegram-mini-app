(() => {
  "use strict";
  const config = window.PAPAKHA_ADMIN_CONFIG;
  const tg = window.Telegram?.WebApp;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { csrf: "", admin: null, currentDeal: null, team: [], view: "attention", offset: 0, loading: false, busy: false, keys: new Map() };
  const labels = { new:"Новая",reviewing:"Проверяется",rate_offered:"Курс предложен",rate_accepted:"Курс принят",awaiting_payment:"Ожидается оплата",payment_review:"Проверка оплаты",exchange_in_progress:"Обмен выполняется",completed:"Завершена",cancelled:"Отменена",dispute:"На проверке" };
  const verificationLabels = {unverified:"Не начата",pending:"Проверяется",approved:"Одобрена",review:"Решение специалиста",retry:"Нужно продолжить",declined:"Отклонена",expired:"Истекла",error:"Ошибка сервиса"};
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (symbol) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[symbol]));
  const stamp = (value) => value ? new Date(value).toLocaleString("ru-RU", { dateStyle:"short", timeStyle:"short" }) : "—";
  const authHeaders = () => tg?.initData ? { "X-Telegram-Init-Data": tg.initData } : config.developmentUserId ? { "X-Dev-Telegram-User": String(config.developmentUserId) } : {};
  let toastTimer;
  const toast = (message) => { const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove("show"), 2400); };
  const api = async (path, options = {}) => {
    const response = await fetch(`${config.apiBaseUrl}${path}`, { credentials:"include", ...options, headers:{ Accept:"application/json", ...(options.body ? {"Content-Type":"application/json"}:{}), ...authHeaders(), ...(state.csrf && !["GET","HEAD"].includes(options.method || "GET") ? {"X-CSRF-Token":state.csrf}:{}), ...(options.headers||{}) } });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw new Error(data?.error?.message || "Сервис временно недоступен");
    return data;
  };
  const showWorkspace = (session) => {
    state.csrf = session.csrfToken; state.admin = session.admin;
    $("#login").hidden = true; $("#workspace").hidden = false; $("#logout").hidden = false;
    $("#admin-name").textContent = `${session.admin.displayName || session.admin.telegramId} · ${{owner:"Владелец",manager:"Менеджер",viewer:"Наблюдатель"}[session.admin.role] || session.admin.role}`;
    if (session.admin.role !== "owner") $$('[data-tab="verifications"],[data-tab="settings"],[data-tab="admins"],[data-tab="audit"]').forEach((node) => node.hidden = true);
    $("#workspace nav").hidden=session.admin.role!=="owner";
    if(session.admin.role==='owner'){document.querySelector('[data-tab="questionnaire"]').hidden=false;window.PapakhaFormEditor.init(api);}
    api("/api/admin/team").then(data=>{state.team=data.team;}).catch(()=>{});
    loadAll();
  };
  const login = async () => {
    $("#login-error").textContent = "";
    if (!config.developmentUserId) { window.location.href = config.adminLaunchUrl; return; }
    try { showWorkspace(await api("/api/admin/session", {method:"POST",body:"{}"})); } catch(error) { $("#login-error").textContent = error.message; }
  };
  const statusOptions = () => Object.entries(labels).map(([value,label]) => `<option value="${value}">${label}</option>`).join("");
  const loadDashboard = async () => {
    const dashboard = (await api("/api/admin/dashboard")).dashboard;
    const volume = (dashboard.volumeToday||[]).map((row)=>`${Number(row.amount).toLocaleString("ru-RU")} ${row.give_currency}`).join(" · ") || "0";
    const cards = [["Новые",dashboard.statuses.new||0],["Требуют внимания",(dashboard.statuses.new||0)+(dashboard.statuses.payment_review||0)+(dashboard.statuses.dispute||0)],["Курс устарел",dashboard.staleDeals||0],["Объём сегодня",volume]];
    $("#metrics").innerHTML = cards.map(([label,value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
    $("#service-state").textContent = `${dashboard.services.rates==="working"?"Сервис курсов работает":dashboard.services.rates==="stale"?"Курс устарел":"Сервис курсов недоступен"} · ${dashboard.services.telegram==="configured"?"Telegram работает":"Telegram не настроен"} · ${dashboard.services.verification==="sandbox"?"Проверка: Sandbox":"Проверка не настроена"}`;
  };
  const loadDeals = async () => {
    if(state.loading)return;state.loading=true;
    $("#refresh").disabled=true;
    const params = new URLSearchParams({view:state.view,offset:String(state.offset),limit:"25"}); if ($("#status-filter").value) params.set("status",$("#status-filter").value); if ($("#search").value.trim()) params.set("search",$("#search").value.trim());
    try {
    const deals = (await api(`/api/admin/deals?${params}`)).deals;
    $("#deals-body").innerHTML = deals.length ? deals.map((deal) => `<tr data-id="${escapeHtml(deal.id)}" tabindex="0" aria-label="Открыть ${escapeHtml(deal.public_id)}"><td data-label="Заявка"><strong>${escapeHtml(deal.public_id)}</strong></td><td data-label="Клиент">${escapeHtml(deal.username ? `@${deal.username}` : deal.telegram_user_id)}</td><td data-label="Отдаёт">${escapeHtml(deal.give_amount)} ${escapeHtml(deal.give_currency)}</td><td data-label="Получает">${escapeHtml(deal.receive_amount||"—")} ${escapeHtml(deal.receive_currency)}</td><td data-label="Этап"><span class="badge ${["new","payment_review","dispute"].includes(deal.status)?"hot":""}">${escapeHtml(labels[deal.status]||deal.status)}</span><small>${escapeHtml(window.PapakhaWorkflow.hint(deal))}</small><small>Ответственный: ${escapeHtml(deal.manager_name || deal.assigned_admin_id || "Не назначен")}</small></td><td data-label="Создана">${stamp(deal.created_at)}</td></tr>`).join("") : `<tr><td colspan="6">В этом разделе заявок нет</td></tr>`;
    $("#list-state").textContent=`Обновлено в ${new Date().toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}`;
    $("#page-label").textContent=`Страница ${state.offset/25+1}`;$("#page-prev").disabled=state.offset===0;$("#page-next").disabled=deals.length<25;
    } catch(error){$("#list-state").textContent=`Не удалось обновить: ${error.message}. Показаны предыдущие данные.`;}
    finally{state.loading=false;$("#refresh").disabled=false;}
  };
  const detailHtml = deal => window.PapakhaWorkflow.detail(deal,state.admin,state.team,labels,stamp);
  const openDeal = async (id) => { const deal=(await api(`/api/admin/deals/${encodeURIComponent(id)}`)).deal; state.currentDeal=deal; $("#deal-detail").innerHTML=detailHtml(deal); $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden","false"); $("#close-detail").focus(); };
  const closeDeal = () => { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden","true"); };
  const act = async (action, input={}) => {
    if(!state.currentDeal||state.busy)return;
    const deal=state.currentDeal;
    if(["payment-confirmed","complete","cancel"].includes(action)&&!window.confirm(`${{ "payment-confirmed":"Подтвердить фактическое поступление",complete:"Подтвердить выполненный перевод",cancel:"Отменить сделку"}[action]}?\n${deal.public_id}\n${action==="complete"?deal.receive_amount:deal.give_amount} ${action==="complete"?deal.receive_currency:deal.give_currency}`))return;
    state.busy=true; $$("button",$("#deal-detail")).forEach(b=>b.disabled=true);
    const body=JSON.stringify({...input,expectedUpdatedAt:deal.updated_at,expectedRevision:deal.revision});
    const operation=`${deal.id}:${action}:${body}`;
    if(!state.keys.has(operation))state.keys.set(operation,crypto.randomUUID());
    try{const data=await api(`/api/admin/deals/${encodeURIComponent(deal.id)}/${action}`,{method:"POST",headers:{"Idempotency-Key":state.keys.get(operation)},body});toast("Сделка обновлена"); await openDeal(data.deal.id); await Promise.all([loadDeals(),loadDashboard()]);}
    catch(error){$("#deal-error").textContent=error.message;toast(error.message);}
    finally{state.busy=false;$$("button",$("#deal-detail")).forEach(b=>b.disabled=false);}
  };
  const loadSettings = async () => { const s=(await api("/api/admin/settings")).settings; $("#sell-markup").value=Number(s.sell_markup_bps||0)/100; $("#buy-markup").value=Number(s.buy_markup_bps||0)/100; $("#lock-minutes").value=s.rate_lock_minutes||10; $("#minimum-amount").value=s.minimum_amount||"1"; $("#maximum-amount").value=s.maximum_amount||"100000000"; $("#supported-currencies").value=(s.supported_currencies||[]).join(", "); $("#automatic-currencies").value=(s.automatic_currencies||[]).join(", "); $("#stale-seconds").value=s.maximum_stale_seconds||120; $("#maintenance").checked=Boolean(s.maintenance_mode); };
  const loadAdmins = async () => { const admins=(await api("/api/admin/admins")).admins; $("#admins-list").innerHTML=admins.map((admin)=>`<article><strong>${escapeHtml(admin.display_name||admin.telegram_id)} · ${escapeHtml(admin.role)}</strong><small>Telegram ID ${admin.telegram_id} · ${admin.active?"доступ активен":"доступ отозван"}</small></article>`).join("")||"Сотрудников пока нет"; };
  const loadVerifications = async () => { const params=new URLSearchParams();if($("#verification-status-filter").value)params.set("status",$("#verification-status-filter").value);const rows=(await api(`/api/admin/verifications?${params}`)).verifications;$("#verifications-list").innerHTML=rows.length?rows.map((item)=>`<article class="verification-card" data-verification-id="${escapeHtml(item.id)}"><div><span class="badge ${["review","declined"].includes(item.status)?"hot":""}">${escapeHtml(verificationLabels[item.status]||item.status)}</span><h3>${escapeHtml(item.username?`@${item.username}`:item.first_name||item.telegram_user_id)}</h3><small>Telegram ID ${escapeHtml(item.telegram_user_id)} · AML: ${escapeHtml(item.aml_status)} · ${stamp(item.updated_at)}</small></div><div class="verification-actions">${item.status==="review"?'<button class="primary" data-verification-action="approve">Одобрить</button><button class="quiet" data-verification-action="reject">Отклонить</button>':""}<button class="quiet" data-verification-action="reset">Сбросить</button></div></article>`).join(""):'<div class="card">Проверок пока нет</div>'; };
  const loadAudit = async () => { const events=(await api("/api/admin/audit-log")).events; $("#audit-list").innerHTML=events.map((event)=>`<article><strong>${escapeHtml(event.action)}</strong><small>${stamp(event.created_at)} · ${escapeHtml(event.entity_type)} ${escapeHtml(event.entity_id||"")}</small></article>`).join("")||"Событий пока нет"; };
  const loadAll = async () => { try { await Promise.all([loadDashboard(),loadDeals()]); if(state.admin.role==="owner") await Promise.all([loadVerifications(),loadSettings(),loadAdmins(),loadAudit()]); } catch(error) { toast(error.message); $("#service-state").textContent="Сервис курсов недоступен"; } };

  $("#status-filter").insertAdjacentHTML("beforeend",statusOptions());
  $("#login-button").addEventListener("click",login); $("#refresh").addEventListener("click",()=>loadAll());
  const resetSearch=()=>{state.offset=0;loadDeals();};$("#status-filter").addEventListener("change",resetSearch);$("#search").addEventListener("change",resetSearch);
  $("#refresh-verifications").addEventListener("click",loadVerifications);$("#verification-status-filter").addEventListener("change",loadVerifications);
  $("#verifications-list").addEventListener("click",async(event)=>{const button=event.target.closest("[data-verification-action]");const card=event.target.closest("[data-verification-id]");if(!button||!card)return;const reason=window.prompt("Укажите нейтральную причину решения без персональных данных (10–500 символов)");if(reason===null)return;button.disabled=true;try{await api(`/api/admin/verifications/${encodeURIComponent(card.dataset.verificationId)}/${button.dataset.verificationAction}`,{method:"POST",body:JSON.stringify({reason})});toast("Решение сохранено");await Promise.all([loadVerifications(),loadAudit()]);}catch(error){toast(error.message);}finally{button.disabled=false;}});
  $("#deals-body").addEventListener("click",(event)=>{const row=event.target.closest("tr[data-id]");if(row)openDeal(row.dataset.id).catch(error=>toast(error.message));}); $("#drawer-close").addEventListener("click",()=>{if(!state.busy)closeDeal();}); $("#close-detail").addEventListener("click",()=>{if(!state.busy)closeDeal();});
  $("#deal-detail").addEventListener("click",async(event)=>{
    const tab=event.target.closest("[data-detail-tab]");if(tab){$$('[data-detail-tab]').forEach(b=>b.classList.toggle("selected",b===tab));$$('[data-detail-panel]').forEach(p=>p.hidden=p.dataset.detailPanel!==tab.dataset.detailTab);return;}
    if(event.target.closest("#reload-detail")){try{await openDeal(state.currentDeal.id);}catch(error){toast(error.message);}return;}
    const button=event.target.closest("[data-action]");if(button)await act(button.dataset.action);
  });
  $("#deal-detail").addEventListener("submit",async(event)=>{const action={"rate-form":"offer-rate","message-form":"message","transfer-form":"transfer"}[event.target.id];if(!action)return;event.preventDefault();await act(action,Object.fromEntries(new FormData(event.target)));});
  $$('[data-view]').forEach(button=>button.addEventListener("click",()=>{if(state.loading)return;state.view=button.dataset.view;state.offset=0;$$('[data-view]').forEach(b=>b.classList.toggle("selected",b===button));loadDeals();}));
  $("#page-prev").addEventListener("click",()=>{if(!state.loading){state.offset=Math.max(0,state.offset-25);loadDeals();}});
  $("#page-next").addEventListener("click",()=>{if(!state.loading){state.offset+=25;loadDeals();}});
  $("#deals-body").addEventListener("keydown",event=>{if(["Enter"," "].includes(event.key)){const row=event.target.closest("tr[data-id]");if(row){event.preventDefault();openDeal(row.dataset.id).catch(error=>toast(error.message));}}});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!state.busy)closeDeal();});
  setInterval(()=>{if(state.admin&&!document.hidden&&!state.loading)loadDeals();},15000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden&&state.admin)loadDeals();});
  $("#settings-form").addEventListener("submit",async(event)=>{event.preventDefault();try{await api("/api/admin/settings",{method:"PATCH",body:JSON.stringify({sell_markup_bps:Math.round(Number($("#sell-markup").value)*100),buy_markup_bps:Math.round(Number($("#buy-markup").value)*100),rate_lock_minutes:Number($("#lock-minutes").value),minimum_amount:$("#minimum-amount").value,maximum_amount:$("#maximum-amount").value,supported_currencies:$("#supported-currencies").value.split(",").map(v=>v.trim().toUpperCase()).filter(Boolean),automatic_currencies:$("#automatic-currencies").value.split(",").map(v=>v.trim().toUpperCase()).filter(Boolean),maximum_stale_seconds:Number($("#stale-seconds").value),maintenance_mode:$("#maintenance").checked})});$("#settings-message").textContent="Сохранено";toast("Настройки сохранены");}catch(error){$("#settings-message").textContent=error.message;}});
  $("#admin-form").addEventListener("submit",async(event)=>{event.preventDefault();try{await api("/api/admin/admins",{method:"POST",body:JSON.stringify({telegramId:Number($("#admin-id").value),displayName:$("#admin-display-name").value,role:$("#admin-role").value,active:$("#admin-active").checked})});toast("Доступ обновлён");event.target.reset();$("#admin-active").checked=true;await Promise.all([loadAdmins(),loadAudit()]);}catch(error){toast(error.message);}});
  $$(".tab").forEach(button=>button.addEventListener("click",()=>{$$(".tab").forEach(item=>item.classList.toggle("active",item===button));$$('[data-panel]').forEach(panel=>panel.hidden=panel.dataset.panel!==button.dataset.tab);}));
  $("#logout").addEventListener("click",async()=>{try{await api("/api/admin/session",{method:"DELETE"});}finally{location.reload();}});
  tg?.ready(); tg?.expand();
  const handoffCode = new URLSearchParams(window.location.search).get("code");
  if (handoffCode) {
    api("/api/admin/session/exchange", { method:"POST", body:JSON.stringify({ code:handoffCode }) })
      .then((session) => { history.replaceState({}, "", window.location.pathname); showWorkspace(session); })
      .catch((error) => { $("#login-error").textContent = error.message; });
  } else {
    api("/api/admin/session").then(showWorkspace).catch(()=>{});
  }
})();
