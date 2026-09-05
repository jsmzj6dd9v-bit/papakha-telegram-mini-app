(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.PapakhaQuestionnaire={
    mount({form,definition,baseSteps,onChange}){
      const core=['giveCurrency','amount','receiveCurrency','method'];const nodes=new Map();
      baseSteps.forEach((node,i)=>{node.dataset.questionId=core[i];nodes.set(core[i],node);});
      for(const q of definition.questions){
        if(q.type==='core')continue;
        const node=document.createElement('section');node.className='survey-step';node.dataset.questionId=q.id;
        const control=q.type==='single'||q.type==='multi'?`<fieldset class="choice-list" aria-label="${esc(q.label)}">${q.options.map((o,i)=>`<label><input type="${q.type==='multi'?'checkbox':'radio'}" name="extra_${esc(q.id)}" value="${esc(o)}"><span><b>${esc(o)}</b></span></label>`).join('')}</fieldset>`:`<label class="amount-card"><span class="field-label">${esc(q.label)}</span><input data-answer-input type="text" ${q.type==='number'?'inputmode="decimal"':''} maxlength="1000" aria-label="${esc(q.label)}" placeholder="Введите ответ"></label>`;
        node.innerHTML=`<p class="survey-hint">${q.required?'Обязательный вопрос':'Необязательный вопрос'}</p>${control}`;form.insertBefore(node,document.getElementById('survey-error'));nodes.set(q.id,node);
      }
      const value=q=>{const n=nodes.get(q.id);if(q.type==='core')return q.id==='amount'?form.querySelector('#give-amount').value:form.querySelector(`[name="${q.id}"]:checked`)?.value||'';if(q.type==='multi')return [...n.querySelectorAll('input:checked')].map(i=>i.value);return n.querySelector('[data-answer-input]')?.value||n.querySelector('input:checked')?.value||'';};
      const visible=()=>{const context={};const list=[];for(const q of definition.questions){const n=nodes.get(q.id);const show=!q.hidden&&(q.conditions||[]).every(c=>Array.isArray(context[c.field])?context[c.field].includes(c.value):String(context[c.field]??'')===c.value);if(show){context[q.id]=value(q);list.push(q);}else if(q.type!=='core'){n.querySelectorAll('input').forEach(i=>{if(['radio','checkbox'].includes(i.type))i.checked=false;else i.value='';});}n.hidden=!show;}return list;};
      const controller={
        steps:()=>visible().map(q=>nodes.get(q.id)),
        title:id=>definition.questions.find(q=>q.id===id)?.label||'',
        answers:()=>Object.fromEntries(visible().filter(q=>q.type!=='core').map(q=>[q.id,value(q)])),
        validate(id){const q=visible().find(q=>q.id===id);if(!q||q.type==='core')return null;const v=value(q);if(q.required&&(!v||Array.isArray(v)&&!v.length))return 'Ответьте на обязательный вопрос';if(q.type==='number'&&v&&!Number.isFinite(Number(v)))return 'Введите число';return null;},
        snapshot:()=>visible().filter(q=>q.type!=='core').map(q=>({label:q.label,answer:value(q)})),
      };
      form.addEventListener('change',()=>onChange(controller));return controller;
    }
  };
})();
