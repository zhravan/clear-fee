(() => {
  'use strict';

  const DB_NAME = 'clear-fee-local';
  const DB_VERSION = 1;
  const STORE_CLIENTS = 'clients';
  const STORE_INVOICES = 'invoices';
  const $ = (id) => document.getElementById(id);
  const currencySymbols = { INR:'₹', USD:'$', EUR:'€', GBP:'£', AUD:'A$', CAD:'C$', SGD:'S$', AED:'AED ' };
  const typeLabels = { deliverable:'Deliverable', hourly:'Per Hour', fixed:'Fixed Fee' };
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'cf-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const todayISO = () => new Date().toISOString().slice(0,10);
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '';
  const fmtMoney = (n, currency) => (currencySymbols[currency] || currency + ' ') + Number(n || 0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});

  function openDB() {
    return new Promise((resolve,reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const clients = db.createObjectStore(STORE_CLIENTS,{keyPath:'id'});
        clients.createIndex('name','name',{unique:false});
        clients.createIndex('updatedAt','updatedAt',{unique:false});
        const invoices = db.createObjectStore(STORE_INVOICES,{keyPath:'id'});
        invoices.createIndex('number','number',{unique:true});
        invoices.createIndex('clientId','clientId',{unique:false});
        invoices.createIndex('createdAt','createdAt',{unique:false});
        invoices.createIndex('status','status',{unique:false});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local database'));
      request.onblocked = () => reject(new Error('Close other Clear-fee tabs and reload to finish the database upgrade.'));
    });
  }

  class LocalStore {
    constructor(db){ this.db = db; }
    all(store) {
      return new Promise((resolve,reject) => {
        const tx=this.db.transaction(store,'readonly'), req=tx.objectStore(store).getAll();
        req.onsuccess=()=>resolve(req.result || []); req.onerror=()=>reject(req.error);
      });
    }
    get(store,id) {
      return new Promise((resolve,reject) => {
        const req=this.db.transaction(store,'readonly').objectStore(store).get(id);
        req.onsuccess=()=>resolve(req.result || null); req.onerror=()=>reject(req.error);
      });
    }
    put(store,value) {
      return new Promise((resolve,reject) => {
        const tx=this.db.transaction(store,'readwrite'); tx.objectStore(store).put(value);
        tx.oncomplete=()=>resolve(value); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error || new Error('Save failed'));
      });
    }
    remove(store,id) {
      return new Promise((resolve,reject) => {
        const tx=this.db.transaction(store,'readwrite'); tx.objectStore(store).delete(id);
        tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
      });
    }
  }

  const defaultItems = () => [
    {type:'deliverable',title:'Platform Architecture Audit',desc:'Review of platform architecture. Written report with findings and recommendations.',qty:1,rate:85000},
    {type:'hourly',title:'Backend Engineering',desc:'Implementation and engineering services.',qty:42,rate:3500}
  ];

  const fields = ['fromName','fromAddress','toName','toAddress','invNumber','issueDate','dueDate','project','currency','taxRate','taxLabel','discount','payment','notes','thanks'];

  function init() {
    const state = { items:defaultItems(), logoDataUrl:null, store:null, invoiceId:null, clients:[], invoices:[], status:'draft' };
    const notify = (message) => {
      const el=$('appNotice'); if(!el) return;
      el.textContent=message; el.hidden=false;
      clearTimeout(notify.timer); notify.timer=setTimeout(()=>{el.hidden=true;},3500);
    };
    const val = id => $(id)?.value ?? '';
    function invoiceData(status=state.status) {
      const subtotal=state.items.reduce((sum,it)=>sum+Math.round((Number(it.qty)||0)*(Number(it.rate)||0)*100)/100,0);
      const discountRate=Math.max(0,Math.min(100,Number(val('discount'))||0));
      const taxRate=Math.max(0,Number(val('taxRate'))||0);
      const discount=Math.round(subtotal*discountRate)/100;
      const tax=Math.round((subtotal-discount)*taxRate)/100;
      const total=Math.round((subtotal-discount+tax)*100)/100;
      return {
        id:state.invoiceId || uid(), number:val('invNumber').trim(), status,
        clientId:state.selectedClientId || null,
        currency:val('currency'), issueDate:val('issueDate'), dueDate:val('dueDate'),
        project:val('project'), seller:{name:val('fromName'),address:val('fromAddress')},
        client:{name:val('toName'),address:val('toAddress')},
        items:state.items.map(x=>({...x,qty:Number(x.qty)||0,rate:Number(x.rate)||0})),
        subtotal,discountRate,discount,taxRate,taxLabel:val('taxLabel'),tax,total,
        paymentInstructions:val('payment'),notes:val('notes'),thanks:val('thanks'),
        logoDataUrl:state.logoDataUrl, updatedAt:new Date().toISOString(),
        createdAt:state.createdAt || new Date().toISOString(), issuedAt:state.issuedAt || null,
        payments:state.payments || []
      };
    }
    function applyInvoice(inv) {
      state.invoiceId=inv.id; state.createdAt=inv.createdAt; state.issuedAt=inv.issuedAt;
      state.selectedClientId=inv.clientId; state.status=inv.status; state.items=inv.items || [];
      state.logoDataUrl=inv.logoDataUrl || null; state.payments=inv.payments || [];
      const values={
        fromName:inv.seller?.name,fromAddress:inv.seller?.address,toName:inv.client?.name,toAddress:inv.client?.address,
        invNumber:inv.number,issueDate:inv.issueDate,dueDate:inv.dueDate,project:inv.project,currency:inv.currency,
        taxRate:inv.taxRate,taxLabel:inv.taxLabel,discount:inv.discountRate,payment:inv.paymentInstructions,
        notes:inv.notes,thanks:inv.thanks
      };
      Object.entries(values).forEach(([id,v])=>{ if($(id)) $(id).value=v ?? ''; });
      if(state.logoDataUrl) {
        $('logoContent').innerHTML='<img alt="Business logo" src="'+state.logoDataUrl+'">';
        $('logoDrop').classList.add('has-logo'); $('logoActions').style.display='flex';
      } else {
        $('logoContent').innerHTML='<div class="hint">Click to upload · PNG / JPG / SVG</div>';
        $('logoDrop').classList.remove('has-logo'); $('logoActions').style.display='none';
      }
      $('statusLabel').textContent=inv.status.toUpperCase();
      renderItems(); render(); updateLockState();
    }
    function calcStatus(inv) {
      if(inv.status==='void') return 'void';
      const paid=(inv.payments||[]).reduce((s,p)=>s+Number(p.amount||0),0);
      if(paid>=inv.total && inv.total>0) return 'paid';
      if(paid>0) return 'partially paid';
      if(inv.status==='issued' && inv.dueDate && inv.dueDate<todayISO()) return 'overdue';
      return inv.status || 'draft';
    }
    function updateLockState() {
      const locked=state.status==='issued' || state.status==='void';
      fields.forEach(id=>{ if($(id)) $(id).disabled=locked; });
      $('addItem').disabled=locked; $('resetBtn').disabled=false;
      $('issueBtn').disabled=locked;
      $('saveBtn').textContent=locked?'Issued invoice':'Save draft';
      $('statusLabel').textContent=state.status.toUpperCase();
    }
    function renderItems() {
      const c=$('items'); c.innerHTML='';
      state.items.forEach((it,i)=>{
        const el=document.createElement('div'); el.className='item';
        const qtyLabel=it.type==='hourly'?'Hours':it.type==='deliverable'?'Qty':'Units';
        const rateLabel=it.type==='hourly'?'Rate / hr':'Rate';
        el.innerHTML='<div class="item-head"><span class="item-index">'+String(i+1).padStart(2,'0')+'</span><div style="display:flex;align-items:center;gap:8px"><span class="item-type"><select data-k="type" data-i="'+i+'"><option value="deliverable" '+(it.type==='deliverable'?'selected':'')+'>Deliverable</option><option value="hourly" '+(it.type==='hourly'?'selected':'')+'>Per Hour</option><option value="fixed" '+(it.type==='fixed'?'selected':'')+'>Fixed Fee</option></select></span><button class="item-remove" data-rm="'+i+'" type="button" aria-label="Remove line item">✕</button></div></div><div class="row"><label>Title</label><input type="text" data-k="title" data-i="'+i+'" value="'+esc(it.title)+'"></div><div class="row"><label>Description</label><textarea data-k="desc" data-i="'+i+'">'+esc(it.desc)+'</textarea></div><div class="row two"><div><label>'+qtyLabel+'</label><input type="number" step="0.01" min="0" data-k="qty" data-i="'+i+'" value="'+Number(it.qty||0)+'"></div><div><label>'+rateLabel+'</label><input type="number" step="0.01" min="0" data-k="rate" data-i="'+i+'" value="'+Number(it.rate||0)+'"></div></div>';
        c.appendChild(el);
      });
      c.querySelectorAll('[data-k]').forEach(input=>input.addEventListener('input',e=>{
        const i=Number(e.target.dataset.i),k=e.target.dataset.k; let v=e.target.value;
        if(k==='qty'||k==='rate') v=Math.max(0,Number(v)||0);
        state.items[i][k]=v; if(k==='type') renderItems(); render();
      }));
      c.querySelectorAll('[data-rm]').forEach(btn=>btn.addEventListener('click',e=>{
        state.items.splice(Number(e.currentTarget.dataset.rm),1);
        if(!state.items.length) state.items.push({type:'deliverable',title:'',desc:'',qty:1,rate:0});
        renderItems(); render();
      }));
      updateLockState();
    }
    function render() {
      const inv=invoiceData();
      $('pvLogo').innerHTML=state.logoDataUrl?'<img alt="logo" src="'+state.logoDataUrl+'">':'<div class="placeholder">'+esc((val('fromName')[0]||'C').toUpperCase())+'</div>';
      $('pvCompany').textContent=val('fromName')||'Your Company'; $('pvCompanyMeta').textContent=val('fromAddress');
      $('pvNumber').textContent=val('invNumber'); $('pvToName').textContent=val('toName'); $('pvToAddress').textContent=val('toAddress');
      $('pvIssue').textContent=fmtDate(val('issueDate')); $('pvDue').textContent=fmtDate(val('dueDate')); $('pvProject').textContent=val('project');
      $('pvNotes').textContent=val('notes'); $('pvPayment').textContent=val('payment'); $('pvFromFooter').textContent=val('fromName')+'\n'+val('fromAddress'); $('pvThanks').textContent=val('thanks');
      const tbody=$('pvItems'); tbody.innerHTML='';
      inv.items.forEach(it=>{
        const amount=it.qty*it.rate, tr=document.createElement('tr');
        tr.innerHTML='<td><div class="item-title">'+esc(it.title||'Untitled')+'</div>'+(it.desc?'<div class="item-desc">'+esc(it.desc)+'</div>':'')+'<div class="item-mode">'+(typeLabels[it.type]||'Item')+'</div></td><td class="num">'+(it.type==='hourly'?it.qty+' hr':it.qty)+'</td><td class="num">'+fmtMoney(it.rate,inv.currency)+(it.type==='hourly'?' /hr':'')+'</td><td class="num">'+fmtMoney(amount,inv.currency)+'</td>';
        tbody.appendChild(tr);
      });
      $('pvSubtotal').textContent=fmtMoney(inv.subtotal,inv.currency);
      $('rowDiscount').style.display=inv.discountRate>0?'flex':'none'; $('pvDiscRate').textContent=inv.discountRate;
      $('pvDiscount').textContent='− '+fmtMoney(inv.discount,inv.currency);
      $('pvTaxLabel').textContent=inv.taxLabel||'Tax'; $('pvTaxRate').textContent=inv.taxRate;
      $('pvTax').textContent=fmtMoney(inv.tax,inv.currency); $('rowTax').style.display=inv.taxRate>0?'flex':'none';
      $('pvTotal').textContent=fmtMoney(inv.total,inv.currency);
    }
    async function refreshLists() {
      state.clients=await state.store.all(STORE_CLIENTS);
      state.invoices=await state.store.all(STORE_INVOICES);
      state.clients.sort((a,b)=>a.name.localeCompare(b.name));
      state.invoices.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
      renderClientOptions(); renderInvoiceList(); renderDashboard();
    }
    function renderClientOptions() {
      const select=$('clientSelect'); select.innerHTML='<option value="">Choose a saved client…</option>';
      state.clients.forEach(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name;select.appendChild(o);});
      select.value=state.selectedClientId||'';
    }
    function renderDashboard() {
      const invoices=state.invoices;
      const total=invoices.filter(x=>x.status!=='draft'&&x.status!=='void').reduce((s,x)=>s+x.total,0);
      const outstanding=invoices.filter(x=>x.status!=='draft'&&x.status!=='void').reduce((s,x)=>s+x.total-(x.payments||[]).reduce((p,a)=>p+a.amount,0),0);
      $('metricInvoices').textContent=invoices.length;
      $('metricClients').textContent=state.clients.length;
      $('metricOutstanding').textContent=fmtMoney(outstanding,'INR');
      $('metricIssued').textContent=fmtMoney(total,'INR');
    }
    function renderInvoiceList() {
      const list=$('invoiceList'); list.innerHTML='';
      if(!state.invoices.length){list.innerHTML='<p class="empty-state">No invoices saved yet. Create your first invoice below.</p>';return;}
      state.invoices.forEach(inv=>{
        const row=document.createElement('div');row.className='saved-row';
        const status=calcStatus(inv);
        row.innerHTML='<div class="saved-main"><strong>'+esc(inv.number||'Untitled')+'</strong><span>'+esc(inv.client?.name||'No client')+' · '+fmtDate(inv.issueDate)+'</span></div><div class="saved-side"><b>'+fmtMoney(inv.total,inv.currency)+'</b><span class="status-pill '+status.replace(/\s/g,'-')+'">'+esc(status)+'</span><button class="small-btn" data-open="'+esc(inv.id)+'" type="button">Open</button></div>';
        list.appendChild(row);
      });
      list.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>loadInvoice(b.dataset.open)));
    }
    function validateInvoice(inv) {
      if(!inv.number) throw new Error('Add an invoice number.');
      if(!inv.client.name.trim()) throw new Error('Add a client name.');
      if(!inv.issueDate||!inv.dueDate) throw new Error('Choose issue and due dates.');
      if(inv.dueDate<inv.issueDate) throw new Error('Due date cannot be earlier than issue date.');
      if(!inv.items.length||inv.items.some(x=>!x.title.trim()||x.qty<=0||x.rate<0)) throw new Error('Each line item needs a title, positive quantity and non-negative rate.');
    }
    async function saveDraft() {
      const inv=invoiceData('draft'); validateInvoice(inv);
      const duplicate=state.invoices.find(x=>x.number===inv.number&&x.id!==inv.id);
      if(duplicate) throw new Error('That invoice number is already in use. Choose a unique number.');
      await state.store.put(STORE_INVOICES,inv);
      state.invoiceId=inv.id;state.createdAt=inv.createdAt;state.status='draft';
      await refreshLists(); notify('Draft saved on this device.');
    }
    async function issueInvoice() {
      const inv=invoiceData('issued'); validateInvoice(inv);
      const duplicate=state.invoices.find(x=>x.number===inv.number&&x.id!==inv.id);
      if(duplicate) throw new Error('That invoice number is already in use. Choose a unique number.');
      if(!confirm('Issue this invoice? Issued invoice details will be locked.')) return;
      inv.issuedAt=new Date().toISOString();inv.seller=structuredClone(inv.seller);inv.client=structuredClone(inv.client);
      await state.store.put(STORE_INVOICES,inv);
      state.invoiceId=inv.id;state.createdAt=inv.createdAt;state.issuedAt=inv.issuedAt;state.status='issued';
      await refreshLists();updateLockState();notify('Invoice issued and saved locally.');
    }
    async function loadInvoice(id) {
      const inv=await state.store.get(STORE_INVOICES,id); if(!inv) return notify('Invoice not found.');
      applyInvoice(inv); notify('Invoice loaded.');
      window.scrollTo({top:0,behavior:'smooth'});
    }
    async function saveClient() {
      const name=$('clientName').value.trim(); if(!name) throw new Error('Enter a client name.');
      const id=$('clientEditId').value||uid(), now=new Date().toISOString();
      const client={id,name,email:$('clientEmail').value.trim(),phone:$('clientPhone').value.trim(),address:$('clientAddress').value.trim(),updatedAt:now,createdAt:(state.clients.find(x=>x.id===id)||{}).createdAt||now};
      await state.store.put(STORE_CLIENTS,client);
      $('clientForm').reset();$('clientEditId').value='';
      await refreshLists();notify('Client saved locally.');
    }
    async function recordPayment() {
      const inv=await state.store.get(STORE_INVOICES,state.invoiceId);
      if(!inv||inv.status!=='issued') throw new Error('Open an issued invoice before recording a payment.');
      const amount=Number($('paymentAmount').value);
      if(!Number.isFinite(amount)||amount<=0) throw new Error('Enter a payment amount greater than zero.');
      const paid=(inv.payments||[]).reduce((s,p)=>s+p.amount,0);
      if(Math.round((paid+amount)*100)>Math.round(inv.total*100)) throw new Error('Payment exceeds the remaining balance.');
      inv.payments=inv.payments||[];inv.payments.push({id:uid(),amount:Math.round(amount*100)/100,date:$('paymentDate').value||todayISO(),method:$('paymentMethod').value,reference:$('paymentReference').value.trim(),createdAt:new Date().toISOString()});
      inv.updatedAt=new Date().toISOString();await state.store.put(STORE_INVOICES,inv);
      $('paymentAmount').value='';$('paymentReference').value='';await refreshLists();applyInvoice(inv);notify('Payment recorded.');
    }
    async function exportBackup() {
      const payload={format:'clear-fee-backup',version:1,exportedAt:new Date().toISOString(),clients:await state.store.all(STORE_CLIENTS),invoices:await state.store.all(STORE_INVOICES)};
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='clear-fee-backup-'+todayISO()+'.json';a.click();URL.revokeObjectURL(url);
    }
    async function importBackup(file) {
      const payload=JSON.parse(await file.text());
      if(payload.format!=='clear-fee-backup'||payload.version!==1||!Array.isArray(payload.clients)||!Array.isArray(payload.invoices)) throw new Error('This is not a supported Clear-fee backup.');
      for(const c of payload.clients) if(!c.id||!c.name) throw new Error('Backup contains an invalid client record.');
      for(const i of payload.invoices) if(!i.id||!i.number||!i.client||!Array.isArray(i.items)||!Number.isFinite(i.total)) throw new Error('Backup contains an invalid invoice record.');
      if(!confirm('Import will add records. Duplicate IDs and invoice numbers will be skipped. Continue?')) return;
      const existing=await state.store.all(STORE_INVOICES), numbers=new Set(existing.map(x=>x.number)), ids=new Set(existing.map(x=>x.id));
      for(const c of payload.clients) if(!(await state.store.get(STORE_CLIENTS,c.id))) await state.store.put(STORE_CLIENTS,c);
      let added=0;
      for(const inv of payload.invoices) if(!ids.has(inv.id)&&!numbers.has(inv.number)){await state.store.put(STORE_INVOICES,inv);added++;numbers.add(inv.number);}
      await refreshLists();notify('Imported '+added+' invoices. Backup data remains on this device.');
    }
    function resetEditor() {
      if(state.status!=='draft'&&!confirm('Start a new invoice? The issued invoice will remain saved.')) return;
      state.invoiceId=null;state.createdAt=null;state.issuedAt=null;state.status='draft';state.selectedClientId=null;state.payments=[];
      state.items=[{type:'deliverable',title:'',desc:'',qty:1,rate:0}];state.logoDataUrl=null;
      $('logoContent').innerHTML='<div class="hint">Click to upload · PNG / JPG / SVG</div>';$('logoDrop').classList.remove('has-logo');$('logoActions').style.display='none';
      $('clientSelect').value='';$('fromName').value=localStorage.getItem('cf-business-name')||'';
      $('fromAddress').value=localStorage.getItem('cf-business-address')||'';
      $('toName').value='';$('toAddress').value='';$('invNumber').value='';$('issueDate').value=todayISO();
      const due=new Date();due.setDate(due.getDate()+15);$('dueDate').value=due.toISOString().slice(0,10);
      $('project').value='';$('currency').value='INR';$('taxRate').value='0';$('taxLabel').value='GST';$('discount').value='0';
      $('payment').value='';$('notes').value='';$('thanks').value='Thank you for your business.';
      renderItems();render();updateLockState();
    }

    $('logoDrop').addEventListener('click',()=>$('logoInput').click());
    $('logoDrop').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('logoInput').click();}});
    $('logoChange').addEventListener('click',e=>{e.stopPropagation();$('logoInput').click();});
    $('logoRemove').addEventListener('click',e=>{e.stopPropagation();state.logoDataUrl=null;$('logoContent').innerHTML='<div class="hint">Click to upload · PNG / JPG / SVG</div>';$('logoDrop').classList.remove('has-logo');$('logoActions').style.display='none';render();});
    $('logoInput').addEventListener('change',e=>{
      const file=e.target.files?.[0];if(!file)return;
      if(!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return notify('Choose a PNG, JPG, WebP or SVG image.');
      if(file.size>1024*1024) return notify('Logo must be smaller than 1 MB.');
      const reader=new FileReader();reader.onload=ev=>{state.logoDataUrl=ev.target.result;$('logoContent').innerHTML='<img alt="Business logo" src="'+state.logoDataUrl+'">';$('logoDrop').classList.add('has-logo');$('logoActions').style.display='flex';render();};reader.readAsDataURL(file);
    });
    $('addItem').addEventListener('click',()=>{state.items.push({type:'deliverable',title:'',desc:'',qty:1,rate:0});renderItems();render();});
    fields.forEach(id=>$(id).addEventListener('input',()=>{render();if(id==='fromName'||id==='fromAddress'){localStorage.setItem(id==='fromName'?'cf-business-name':'cf-business-address',val(id));}}));
    $('clientSelect').addEventListener('change',async e=>{
      const client=state.clients.find(c=>c.id===e.target.value);state.selectedClientId=client?.id||null;
      if(client){$('toName').value=client.name;$('toAddress').value=[client.address,client.email,client.phone].filter(Boolean).join('\n');render();}
    });
    $('saveClientBtn').addEventListener('click',()=>saveClient().catch(e=>notify(e.message)));
    $('clientForm').addEventListener('submit',e=>{e.preventDefault();saveClient().catch(err=>notify(err.message));});
    $('saveBtn').addEventListener('click',()=>saveDraft().catch(e=>notify(e.message)));
    $('issueBtn').addEventListener('click',()=>issueInvoice().catch(e=>notify(e.message)));
    $('newInvoiceBtn').addEventListener('click',resetEditor);
    $('recordPaymentBtn').addEventListener('click',()=>recordPayment().catch(e=>notify(e.message)));
    $('backupBtn').addEventListener('click',()=>exportBackup().catch(e=>notify(e.message)));
    $('restoreInput').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importBackup(f).catch(err=>notify('Import failed: '+err.message));e.target.value='';});
    $('printBtn').addEventListener('click',()=>window.print());
    $('resetBtn').addEventListener('click',()=>{if(confirm('Clear the current editor? Saved clients and invoices will not be deleted.'))resetEditor();});
    document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();window.print();}});
    const due=new Date();due.setDate(due.getDate()+15);
    $('issueDate').value=todayISO();$('dueDate').value=due.toISOString().slice(0,10);
    $('fromName').value=localStorage.getItem('cf-business-name')||'';
    $('fromAddress').value=localStorage.getItem('cf-business-address')||'';
    openDB().then(async db=>{
      state.store=new LocalStore(db);await refreshLists();renderItems();render();updateLockState();
      if(location.hash.startsWith('#invoice=')) await loadInvoice(decodeURIComponent(location.hash.slice(9)));
    }).catch(err=>{
      console.error('Clear-fee database initialization failed',err);
      notify('Local database could not start. Use a modern browser with IndexedDB enabled, then reload.');
    });
  }

  document.addEventListener('DOMContentLoaded',init,{once:true});
})();
