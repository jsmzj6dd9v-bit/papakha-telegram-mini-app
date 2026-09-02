(() => {
  "use strict";
  const config = window.PAPAKHA_ADMIN_CONFIG;
  const tg = window.Telegram?.WebApp;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { csrf: "", admin: null, currentDeal: null };
  const labels = { new:"Новая",reviewing:"Проверяется",rate_offered:"Курс предложен",rate_accepted:"Курс принят",awaiting_payment:"Ожидается оплата",payment_review:"Проверка оплаты",exchange_in_progress:"Обмен выполняется",completed:"Завершена",cancelled:"Отменена",dispute:"На проверке" };
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
    $("#admin-name").textContent = `${session.admin.displayName || session.admin.telegramId} · ${session.admin.role}`;
    if (session.admin.role !== "owner") $$('[data-tab="settings"],[data-tab="admins"],[data-tab="audit"]').forEach((node) => node.hidden = true);
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
    $("#service-state").textContent = `${dashboard.services.rates==="working"?"Сервис курсов работает":dashboard.services.rates==="stale"?"Курс устарел":"Сервис курсов недоступен"} · ${dashboard.services.telegram==="configured"?"Telegram работает":"Telegram не настроен"}`;
  };
  const loadDeals = async () => {
    const params = new URLSearchParams(); if ($("#status-filter").value) params.set("status",$("#status-filter").value); if ($("#search").value.trim()) params.set("search",$("#search").value.trim());
    const deals = (await api(`/api/admin/deals?${params}`)).deals;
    $("#deals-body").innerHTML = deals.length ? deals.map((deal) => `<tr data-id="${deal.id}"><td><strong>${escapeHtml(deal.public_id)}</strong></td><td>${escapeHtml(deal.username ? `@${deal.username}` : deal.telegram_user_id)}</td><td>${escapeHtml(deal.give_amount)} ${escapeHtml(deal.give_currency)}</td><td>${escapeHtml(deal.receive_amount||"—")} ${escapeHtml(deal.receive_currency)}</td><td><span class="badge ${["new","dispute"].includes(deal.status)?"hot":""}">${escapeHtml(labels[deal.status]||deal.status)}</span></td><td>${stamp(deal.created_at)}</td></tr>`).join("") : `<tr><td colspan="6">Заявок пока нет</td></tr>`;
  };
  const detailHtml = (deal) => {
    let market={};let markup={};try{market=JSON.parse(deal.market_rate_snapshot||"{}");markup=JSON.parse(deal.markup_snapshot||"{}");}catch{}
    const marketRub=market["USDT/RUB"]||{};
    const events = (deal.events||[]).map((event) => `<article><strong>${escapeHtml(event.event_type)}</strong><small>${stamp(event.created_at)} · ${escapeHtml(event.actor_type)}</small></article>`).join("");
    return `<div class="deal-head"><p class="eyebrow">${escapeHtml(deal.public_id)}</p><h2>${escapeHtml(labels[deal.status]||deal.status)}</h2><p>${escapeHtml(deal.username?`@${deal.username}`:deal.telegram_user_id)}</p></div>
      <div class="deal-grid"><div><small>Отдаёт</small><strong>${escapeHtml(deal.give_amount)} ${escapeHtml(deal.give_currency)}</strong></div><div><small>Получает</small><strong>${escapeHtml(deal.receive_amount||"—")} ${escapeHtml(deal.receive_currency)}</strong></div><div><small>Рыночная котировка</small><strong>ask ${escapeHtml(marketRub.askPrice||"—")} · bid ${escapeHtml(marketRub.bidPrice||"—")}</strong></div><div><small>Процент Papakha</small><strong>продажа ${Number(markup.sell_markup_bps||0)/100}% · покупка ${Number(markup.buy_markup_bps||0)/100}%</strong></div><div><small>Курс Papakha</small><strong>${escapeHtml(deal.quoted_rate||"Подтверждается")}</strong></div><div><small>Обновлено</small><strong>${stamp(deal.quote_updated_at)}</strong></div><div><small>Способ</small><strong>${escapeHtml(deal.payment_method)}</strong></div><div><small>Менеджер</small><strong>${escapeHtml(deal.manager_name||"Не назначен")}</strong></div></div>
      <div class="actions"><button class="quiet" data-action="assign">Взять в работу</button><button class="quiet" data-action="payment-confirmed">Подтвердить оплату</button><button class="primary" data-action="start-exchange">Начать обмен</button><button class="primary" data-action="complete">Завершить</button><button class="quiet" data-action="cancel">Отменить</button><button class="quiet" data-action="dispute">На проверку</button></div>
      <form id="rate-form" class="deal-form"><h3>Предложить предварительный курс</h3><input name="rate" required placeholder="Курс"><input name="receiveAmount" required placeholder="Сумма получения"><input name="lockMinutes" type="number" min="1" max="60" value="10" placeholder="Срок, минут"><textarea name="paymentInstructions" placeholder="Инструкция по оплате (необязательно)"></textarea><button class="primary">Отправить клиенту</button></form>
      <form id="message-form" class="deal-form"><h3>Сообщение клиенту</h3><textarea name="message" required maxlength="2000" placeholder="Текст сообщения"></textarea><button class="quiet">Отправить через Telegram</button></form>
      <h3>История</h3><div class="timeline">${events||"История пока пуста"}</div>`;
  };
  const openDeal = async (id) => { const deal=(await api(`/api/admin/deals/${encodeURIComponent(id)}`)).deal; state.currentDeal=deal; $("#deal-detail").innerHTML=detailHtml(deal); $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden","false"); };
  const closeDeal = () => { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden","true"); };
  const act = async (action, input={}) => { if(!state.currentDeal)return; const data=await api(`/api/admin/deals/${encodeURIComponent(state.currentDeal.id)}/${action}`,{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(input)}); toast("Сделка обновлена"); await Promise.all([openDeal(data.deal.id),loadDeals(),loadDashboard()]); };
  const loadSettings = async () => { const s=(await api("/api/admin/settings")).settings; $("#sell-markup").value=Number(s.sell_markup_bps||0)/100; $("#buy-markup").value=Number(s.buy_markup_bps||0)/100; $("#lock-minutes").value=s.rate_lock_minutes||10; $("#minimum-amount").value=s.minimum_amount||"1"; $("#maximum-amount").value=s.maximum_amount||"100000000"; $("#supported-currencies").value=(s.supported_currencies||[]).join(", "); $("#automatic-currencies").value=(s.automatic_currencies||[]).join(", "); $("#stale-seconds").value=s.maximum_stale_seconds||120; $("#maintenance").checked=Boolean(s.maintenance_mode); };
  const loadAdmins = async () => { const admins=(await api("/api/admin/admins")).admins; $("#admins-list").innerHTML=admins.map((admin)=>`<article><strong>${escapeHtml(admin.display_name||admin.telegram_id)} · ${escapeHtml(admin.role)}</strong><small>Telegram ID ${admin.telegram_id} · ${admin.active?"доступ активен":"доступ отозван"}</small></article>`).join("")||"Сотрудников пока нет"; };
  const loadAudit = async () => { const events=(await api("/api/admin/audit-log")).events; $("#audit-list").innerHTML=events.map((event)=>`<article><strong>${escapeHtml(event.action)}</strong><small>${stamp(event.created_at)} · ${escapeHtml(event.entity_type)} ${escapeHtml(event.entity_id||"")}</small></article>`).join("")||"Событий пока нет"; };
  const loadAll = async () => { try { await Promise.all([loadDashboard(),loadDeals()]); if(state.admin.role==="owner") await Promise.all([loadSettings(),loadAdmins(),loadAudit()]); } catch(error) { toast(error.message); $("#service-state").textContent="Сервис курсов недоступен"; } };

  $("#status-filter").insertAdjacentHTML("beforeend",statusOptions());
  $("#login-button").addEventListener("click",login); $("#refresh").addEventListener("click",()=>Promise.all([loadDashboard(),loadDeals()])); $("#status-filter").addEventListener("change",loadDeals); $("#search").addEventListener("change",loadDeals);
  $("#deals-body").addEventListener("click",(event)=>{const row=event.target.closest("tr[data-id]");if(row)openDeal(row.dataset.id);}); $("#drawer-close").addEventListener("click",closeDeal); $("#close-detail").addEventListener("click",closeDeal);
  $("#deal-detail").addEventListener("click",async(event)=>{const button=event.target.closest("[data-action]");if(!button)return;try{await act(button.dataset.action);}catch(error){toast(error.message);}});
  $("#deal-detail").addEventListener("submit",async(event)=>{if(!["rate-form","message-form"].includes(event.target.id))return;event.preventDefault();const form=new FormData(event.target);try{await act(event.target.id==="rate-form"?"offer-rate":"message",Object.fromEntries(form));}catch(error){toast(error.message);}});
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
