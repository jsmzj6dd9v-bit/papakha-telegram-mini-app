(() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const types={text:'Текст',number:'Число',single:'Один вариант',multi:'Несколько вариантов'};
  const currencies=['RUB','USDT','BTC','ETH','KZT','AED','USD'];
  let api,root,state,previewAnswers={},busy=false;
  const field=(name,value,label,type='text')=>`<label>${label}<input data-field="${name}" type="${type}" value="${esc(value)}"></label>`;
  const collect=()=>{root.querySelectorAll('[data-q]').forEach(node=>{const q=state.draft.questions.find(q=>q.id===node.dataset.q);q.label=node.querySelector('[data-field="label"]').value;q.required=node.querySelector('[data-field="required"]').checked;q.hidden=node.querySelector('[data-field="hidden"]')?.checked||false;if(q.type!=='core'){q.type=node.querySelector('[data-field="type"]').value;q.options=node.querySelector('[data-field="options"]').value.split('\n').map(s=>s.trim()).filter(Boolean);}q.conditions=[...node.querySelectorAll('[data-condition]')].map(c=>({field:c.querySelector('[data-source]').value,value:c.querySelector('[data-value]').value}));});};
  const render=()=>{
    root.innerHTML=`<p class="eyebrow">ТОЛЬКО ВЛАДЕЛЕЦ</p><h2>Анкета обмена</h2><p>Опубликована версия: ${state.published?.version||'текущая анкета из четырёх шагов'}. Изменения ниже — черновик до публикации.</p><p>«Перевод» означает онлайн-обмен. Все условия вопроса должны выполняться. Условия могут ссылаться только на предыдущие вопросы.</p><div id="form-questions">${state.draft.questions.map((q,i)=>`<article class="question-card" data-q="${esc(q.id)}"><div class="question-tools"><strong>Вопрос ${i+1}${q.type==='core'?' · Основной':''}</strong><button data-move="-1" ${i===0?'disabled':''} aria-label="Поднять вопрос">↑</button><button data-move="1" ${i===state.draft.questions.length-1?'disabled':''} aria-label="Опустить вопрос">↓</button>${q.type!=='core'?'<button data-remove>Удалить</button>':''}</div>${field('label',q.label,'Текст вопроса')}<label class="check"><input type="checkbox" data-field="required" ${q.required?'checked':''} ${q.type==='core'?'disabled':''}> Обязательный</label>${q.type!=='core'?`<label class="check"><input type="checkbox" data-field="hidden" ${q.hidden?'checked':''}> Скрыть</label><label>Тип ответа<select data-field="type">${Object.entries(types).map(([v,l])=>`<option value="${v}" ${v===q.type?'selected':''}>${l}</option>`).join('')}</select></label><label>Варианты выбора — каждый с новой строки<textarea data-field="options" placeholder="Bybit\nHTX (Huobi)\nMEXC">${esc((q.options||[]).join('\n'))}</textarea></label><div class="question-conditions">${(q.conditions||[]).map((c,j)=>`<div data-condition><label>Показывать, если<select data-source>${state.draft.questions.slice(0,i).map(p=>`<option value="${esc(p.id)}" ${p.id===c.field?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label><label>Ответ равен<input data-value value="${esc(c.value)}" placeholder="Например: Наличные"></label><button data-remove-condition="${j}">Убрать условие</button></div>`).join('')}</div><button data-add-condition ${i===0?'disabled':''}>Добавить условие</button>`:''}</article>`).join('')}</div><div class="actions"><button class="quiet" id="add-question">Добавить вопрос</button><button class="quiet" id="preview-form">Предпросмотр</button><button class="quiet" id="save-form">Сохранить черновик</button><button class="primary" id="publish-form">Опубликовать</button><button class="quiet" id="reload-form">Загрузить сохранённый</button></div><p id="form-message" role="status"></p><section id="form-preview" hidden></section>`;
  };
  const preview=()=>{
    collect();const container=root.querySelector('#form-preview');container.hidden=false;
    const valid={};let html='<h3>Предпросмотр для клиента</h3><p>Ответы здесь тестовые и не создают заявку.</p>';
    for(const q of state.draft.questions){if(q.hidden||!(q.conditions||[]).every(c=>Array.isArray(valid[c.field])?valid[c.field].includes(c.value):String(valid[c.field]??'')===c.value)){delete previewAnswers[q.id];continue;}valid[q.id]=previewAnswers[q.id]||'';
      const options=q.type==='core'?(q.id==='method'?['Наличные','Перевод']:q.id==='amount'?null:currencies):['single','multi'].includes(q.type)?q.options:null;
      html+=`<label>${esc(q.label)} ${q.required?'*':''}${options?`<select data-preview="${esc(q.id)}" ${q.type==='multi'?'multiple':''}><option value="">Выберите</option>${options.map(o=>`<option ${Array.isArray(valid[q.id])?valid[q.id].includes(o)?'selected':'':valid[q.id]===o?'selected':''}>${esc(o)}</option>`).join('')}</select>`:`<input data-preview="${esc(q.id)}" value="${esc(valid[q.id])}">`}</label>`;
    }container.innerHTML=html;
  };
  const load=async()=>{state=(await api('/api/admin/questionnaire')).form;render();};
  window.PapakhaFormEditor={async init(request){api=request;root=document.getElementById('questionnaire-editor');try{await load();}catch(e){root.textContent=e.message;return;}
    root.addEventListener('change',event=>{if(event.target.dataset.preview){previewAnswers[event.target.dataset.preview]=event.target.multiple?[...event.target.selectedOptions].map(o=>o.value).filter(Boolean):event.target.value;preview();}});
    root.addEventListener('click',async event=>{const b=event.target.closest('button');if(!b||busy)return;try{
      const article=b.closest('[data-q]');collect();
      if(article){const list=state.draft.questions;const i=list.findIndex(q=>q.id===article.dataset.q);const q=list[i];
        if(b.hasAttribute('data-remove')){if(list.some(p=>(p.conditions||[]).some(c=>c.field===q.id)))throw new Error('Сначала удалите условия других вопросов, связанные с этим вопросом');list.splice(i,1);}
        if(b.dataset.move){const j=i+Number(b.dataset.move);if(j>=0&&j<list.length){const copy=[...list];[copy[i],copy[j]]=[copy[j],copy[i]];const seen=new Set();for(const p of copy){if((p.conditions||[]).some(c=>!seen.has(c.field)))throw new Error('Вопрос с условием должен идти после вопроса, от которого зависит');seen.add(p.id);}state.draft.questions=copy;}}
        if(b.hasAttribute('data-add-condition'))(q.conditions||=[]).push({field:list[0].id,value:''});
        if(b.hasAttribute('data-remove-condition'))q.conditions.splice(Number(b.dataset.removeCondition),1);render();return;
      }
      if(b.id==='add-question'){state.draft.questions.push({id:'q_'+crypto.randomUUID().replaceAll('-',''),type:'text',label:'Новый вопрос',required:false,options:[],conditions:[]});render();}
      if(b.id==='preview-form')preview();
      if(b.id==='reload-form'){if(window.confirm('Загрузить сохранённую анкету? Несохранённые правки будут потеряны.'))await load();}
      if(['save-form','publish-form'].includes(b.id)){
        const publish=b.id==='publish-form';if(publish&&!window.confirm('Опубликовать эту анкету для новых обменов? Начатые анкеты сохранят прежнюю версию на сутки.'))return;
        busy=true;root.querySelectorAll('button').forEach(n=>{n.dataset.previousDisabled=String(n.disabled);n.disabled=true;});
        state=(await api('/api/admin/questionnaire',{method:'POST',body:JSON.stringify({...state.draft,publish})})).form;render();root.querySelector('#form-message').textContent=publish?'Анкета опубликована':'Черновик сохранён';
      }
    }catch(e){root.querySelector('#form-message').textContent=e.message;}finally{busy=false;root.querySelectorAll('[data-previous-disabled]').forEach(n=>{n.disabled=n.dataset.previousDisabled==='true';delete n.dataset.previousDisabled;});}});
  }};
})();
