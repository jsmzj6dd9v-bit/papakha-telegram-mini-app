(() => {
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const eventNames = {deal_created:"Заявка создана",manager_assigned:"Менеджер взял заявку",manager_transferred:"Сделка передана",rate_offered:"Курс предложен",rate_accepted:"Клиент принял курс",payment_reported:"Клиент сообщил об оплате",payment_confirmed:"Поступление подтверждено",exchange_started:"Обмен начат",exchange_completed:"Обмен завершён",deal_cancelled:"Сделка отменена",dispute_opened:"Назначена проверка",manager_message_queued:"Сообщение отправлено в очередь Telegram"};
  const actions = {assign:"Взять в работу","payment-confirmed":"Подтвердить поступление","start-exchange":"Начать обмен",complete:"Завершить сделку",cancel:"Отменить сделку",dispute:"На проверку"};
  const waiting = {new:"Заявка ожидает менеджера",reviewing:"Подготовьте предложение курса",rate_offered:"Ожидаем подтверждения курса клиентом",rate_accepted:"Клиент принял условия",awaiting_payment:"Ожидаем оплату клиента",payment_review:"Клиент сообщил об оплате — проверьте поступление",exchange_in_progress:"Выполните перевод и подтвердите завершение",completed:"Обмен завершён",cancelled:"Заявка отменена",dispute:"Требуется разобраться в ситуации"};
  window.PapakhaWorkflow = {
    hint: deal => deal.status === "payment_review" && deal.payment_confirmed_at ? "Поступление подтверждено — можно перейти к обмену" : waiting[deal.status] || "Проверьте статус сделки",
    detail(deal, admin, team, labels, stamp) {
      const allowed = deal.availableActions || [];
      const manager = team.find(a => Number(a.telegramId) === Number(deal.assigned_admin_id));
      const name = manager?.displayName || deal.manager_name || deal.assigned_admin_id || "Не назначен";
      const button = action => `<button class="${["cancel","dispute"].includes(action)?"quiet":"primary"}" data-action="${action}">${actions[action]}</button>`;
      const primary = ["assign","payment-confirmed","start-exchange","complete"].find(a => allowed.includes(a));
      const expired = deal.rate_expires_at && new Date(deal.rate_expires_at).getTime() <= Date.now() && !["completed","cancelled"].includes(deal.status);
      let questionnaire={};try{questionnaire=JSON.parse(deal.questionnaire_snapshot||'{}')||{};}catch{}
      const timeline = (deal.events || []).map(e => {
        let data={};try{data=JSON.parse(e.payload||"{}");}catch{}
        const actor=team.find(a=>String(a.telegramId)===String(e.actor_id));
        return `<article><strong>${esc(eventNames[e.event_type] || "Статус сделки обновлён")}</strong><small>${esc(stamp(e.created_at))} · ${esc(actor?.displayName || (e.actor_type === "client" ? "Клиент" : e.actor_id || "Система"))}</small>${data.reason?`<p>${esc(data.reason)}</p>`:""}${data.to?`<p>Ответственный: ${esc(data.to)}</p>`:""}${data.rate?`<p>Курс: ${esc(data.rate)} · Получает: ${esc(data.receiveAmount)} ${esc(deal.receive_currency)}</p>`:""}</article>`;
      }).join("");
      const notifications=(deal.notifications||[]).filter(n=>n.event_type==="manager_message").map(n=>`<article><p>${esc(n.message)}</p><small>${esc(stamp(n.created_at))} · ${n.status==="sent"?"Доставлено":n.status==="failed"?"Ожидает повторной отправки":"Отправляется"}</small></article>`).join("");
      return `<div class="deal-head"><p class="eyebrow">${esc(deal.public_id)}</p><h2>${esc(labels[deal.status] || deal.status)}</h2><p>${esc(deal.username?`@${deal.username}`:deal.telegram_user_id)}</p><small>Ответственный: ${esc(name)}</small></div>
      <div class="amounts"><div><small>КЛИЕНТ ОТДАЁТ</small><strong>${esc(deal.give_amount)} <span>${esc(deal.give_currency)}</span></strong></div><div><small>КЛИЕНТ ПОЛУЧАЕТ</small><strong>${esc(deal.receive_amount || "После подтверждения")} <span>${esc(deal.receive_currency)}</span></strong></div></div>
      <p class="next-step">${esc(this.hint(deal))}</p>${expired?'<p class="error">Срок курса истёк. Проверьте условия перед дальнейшими действиями.</p>':""}
      <div class="detail-tabs" role="group" aria-label="Раздел карточки"><button data-detail-tab="payment" class="selected">Оплата</button><button data-detail-tab="terms">Условия</button><button data-detail-tab="history">История</button></div>
      <section data-detail-panel="payment"><h3>Оплата и перевод</h3><p>${esc(deal.payment_method)}</p><div class="payment-note">${esc(deal.payment_instructions || "Инструкция по оплате пока не указана")}</div><p>${deal.payment_confirmed_at?`Поступление подтверждено: ${esc(stamp(deal.payment_confirmed_at))}`:"Поступление ещё не подтверждено менеджером"}</p></section>
      <section data-detail-panel="terms" hidden><h3>Условия обмена</h3><p>Предварительный курс: <strong>${esc(deal.quoted_rate || "Подтверждается")}</strong></p><p>Срок предложения: ${esc(stamp(deal.rate_expires_at))}</p><details><summary>Подробнее о расчёте</summary><p>Курс обновлён: ${esc(stamp(deal.quote_updated_at))}</p><p>${deal.quote_stale?"Курс устарел":"Финальные условия подтверждает менеджер"}</p></details></section>
      <section data-detail-panel="history" hidden><h3>История сделки</h3><div class="timeline">${timeline || "Событий пока нет"}</div><h3>Сообщения клиенту</h3><div class="timeline">${notifications || "Сообщений пока нет"}</div></section>
      ${allowed.includes("offer-rate")?`<form id="rate-form" class="deal-form card"><h3>${deal.status==="rate_offered"?"Обновить предложение":"Предложить курс"}</h3><label>Курс<input name="rate" required inputmode="decimal" value="${esc(deal.quoted_rate || "")}"></label><label>Клиент получит, ${esc(deal.receive_currency)}<input name="receiveAmount" required inputmode="decimal" value="${esc(deal.receive_amount || "")}"></label><label>Действует, минут<input name="lockMinutes" type="number" min="1" max="60" value="10"></label><label>Инструкция по оплате<textarea name="paymentInstructions">${esc(deal.payment_instructions || "")}</textarea></label><button class="primary">Предложить курс клиенту</button></form>`:""}
      ${allowed.includes("message")?'<details><summary>Написать клиенту</summary><form id="message-form" class="deal-form"><label>Сообщение<textarea name="message" required maxlength="2000"></textarea></label><button class="quiet">Отправить через Telegram</button></form></details>':""}
      ${allowed.includes("transfer")?`<details><summary>Передать сделку</summary><form id="transfer-form" class="deal-form"><label>Ответственный<select name="adminId" required>${team.filter(a=>Number(a.telegramId)!==Number(deal.assigned_admin_id)).map(a=>`<option value="${esc(a.telegramId)}">${esc(a.displayName||a.telegramId)}</option>`).join("")}</select></label><label>Причина<textarea name="reason" required minlength="3" maxlength="500"></textarea></label><button class="quiet">Передать</button></form></details>`:""}
      ${allowed.some(a=>["cancel","dispute"].includes(a))?`<details><summary>Другие действия</summary><div class="actions">${["cancel","dispute"].filter(a=>allowed.includes(a)).map(button).join("")}</div></details>`:""}
      ${questionnaire.answers?`<details><summary>Ответы клиента · анкета ${esc(questionnaire.version)}</summary>${questionnaire.answers.map(a=>`<p><strong>${esc(a.label)}</strong><br>${esc(Array.isArray(a.answer)?a.answer.join(', '):a.answer)}</p>`).join('')}</details>`:''}
      <p id="deal-error" class="error" role="alert"></p><button id="reload-detail" class="quiet">Обновить карточку</button>
      ${primary?`<div class="primary-dock">${button(primary)}</div>`:""}`;
    }
  };
})();
