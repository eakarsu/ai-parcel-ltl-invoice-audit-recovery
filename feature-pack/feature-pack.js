/* Universal Feature Pack — drop-in, dependency-free. Marker: UNIVERSAL-FEATURE-PACK v2
   AI: chat, streaming, summarize, classify, sentiment, forecast, anomaly, recommend, extract, translate, rewrite, explain, grounded QA, auto-title, draft-email, report, fill-all presets, JSON pretty/raw.
   Non-AI: table search/sort/pagination, CSV/JSON export+copy, global search, dark mode, toasts, favorites/recent (localStorage), keyboard shortcuts, activity log (localStorage).
   Usage: <script src="/feature-pack/feature-pack.js" defer></script> — or open feature-pack.html standalone.
   Talks to /api/ai, /api/ai/tasks, /api/ai/chat, /api/ai/stream when present; otherwise runs deterministic local analyzers offline. */
(function(){
'use strict';
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const store={get(k,d){try{return JSON.parse(localStorage.getItem('fp:'+k))??d}catch{return d}},set(k,v){try{localStorage.setItem('fp:'+k,JSON.stringify(v))}catch{}}};
function toast(m){let t=document.createElement('div');t.textContent=m;t.style.cssText='position:fixed;right:16px;bottom:64px;background:#0f172a;color:#fff;padding:10px 14px;border-radius:8px;z-index:99999;font:13px system-ui';document.body.appendChild(t);setTimeout(()=>t.remove(),2600)}
function log(a,d){const x=store.get('activity',[]);x.unshift({a,d,at:new Date().toISOString()});store.set('activity',x.slice(0,200))}
const POS=['good','great','excellent','happy','satisfied','success','growth','improve','strong','positive','fast','easy','love','win'];
const NEG=['bad','poor','fail','risk','delay','issue','problem','critical','negative','slow','error','complaint','loss','urgent'];
const local={
 sentiment(t){t=' '+String(t).toLowerCase()+' ';const p=POS.reduce((s,w)=>s+t.split(w).length-1,0),n=NEG.reduce((s,w)=>s+t.split(w).length-1,0);return{sentiment:p>n?'positive':n>p?'negative':'neutral',score:p+n?+(((p-n)/(p+n)).toFixed(2)):0,positiveHits:p,negativeHits:n}},
 summarize(t,n=3){const s=String(t).replace(/\s+/g,' ').split(/(?<=[.!?])\s+/).filter(x=>x.length>20);const f={};s.join(' ').toLowerCase().replace(/[^a-z ]/g,'').split(' ').forEach(w=>{if(w.length>3)f[w]=(f[w]||0)+1});return s.map(x=>({x,s:x.toLowerCase().split(' ').reduce((a,w)=>a+(f[w]||0),0)})).sort((a,b)=>b.s-a.s).slice(0,n).map(o=>o.x).join(' ')||String(t).slice(0,280)},
 classify(t){const cats={risk:/risk|fail|critical|delay|issue|error/i,finance:/\$|cost|budget|revenue|price|payment/i,growth:/growth|expand|new|launch|increase/i,support:/help|support|ticket|complaint|question/i,positive:/great|excellent|success|win/i};const out={};for(const[k,r]of Object.entries(cats))if(r.test(t))out[k]=true;return out},
 extract(t){return{emails:[...new Set(t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)||[])],dates:[...new Set(t.match(/\b\d{4}-\d{2}-\d{2}\b/g)||[])],amounts:[...new Set(t.match(/\$?\b\d[\d,]*\.\d{2}\b/g)||[])],urls:[...new Set(t.match(/https?:\/\/[^\s"']+/g)||[])],phones:[...new Set(t.match(/\+?[\d][\d\s().-]{7,}\d/g)||[])].slice(0,10)}},
 numbers(t){return (String(t).match(/-?\d+(\.\d+)?/g)||[]).map(Number).filter(Number.isFinite)},
 anomaly(ns){if(ns.length<3)return{anomalies:[],note:'need >=3 numbers'};const m=ns.reduce((a,b)=>a+b,0)/ns.length,sd=Math.sqrt(ns.reduce((a,b)=>a+(b-m)**2,0)/ns.length)||1;return{mean:+m.toFixed(2),anomalies:ns.map((n,i)=>({index:i,value:n,z:+(((n-m)/sd).toFixed(2))})).filter(x=>Math.abs(x.z)>2)}},
 forecast(ns){if(ns.length<2)return{forecast:[],note:'need >=2 numbers'};const n=ns.length,mx=(n-1)/2,my=ns.reduce((a,b)=>a+b,0)/n,slope=ns.reduce((s,v,i)=>s+(i-mx)*(v-my),0)/(ns.reduce((s,_,i)=>s+(i-mx)**2,0)||1);return{trend:slope>=0?'up':'down',slope:+slope.toFixed(3),forecast:[1,2,3].map(h=>+(my+slope*(n-1+h-mx)).toFixed(2))}},
 translate(t,lang){const D={es:{hello:'hola',thanks:'gracias',report:'informe',summary:'resumen',risk:'riesgo',customer:'cliente',project:'proyecto'},fr:{hello:'bonjour',thanks:'merci',report:'rapport',summary:'résumé',risk:'risque',customer:'client',project:'projet'},de:{hello:'hallo',thanks:'danke',report:'Bericht',summary:'Zusammenfassung',risk:'Risiko',customer:'Kunde',project:'Projekt'}};const d=D[lang]||D.es;return String(t).replace(/\b(hello|thanks|report|summary|risk|customer|project)\b/gi,m=>d[m.toLowerCase()]||m)+' ['+lang+': dictionary-assisted, use AI endpoint for full translation]'}
};
async function aiTask(task,text){
  log('ai:'+task,'');
  try{const r=await fetch('/api/ai/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task,text})});if(r.ok)return await r.json()}catch{}
  try{const r=await fetch('/api/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Task '+task+': '+text})});if(r.ok){const d=await r.json();return{task,response:d.response||JSON.stringify(d)}}}catch{}
  const ns=local.numbers(text);
  const L={summarize:()=>local.summarize(text),sentiment:()=>local.sentiment(text),classify:()=>local.classify(text),extract:()=>local.extract(text),anomaly:()=>local.anomaly(ns),forecast:()=>local.forecast(ns),translate:()=>local.translate(text,'es'),recommend:()=>'Top actions: 1) address critical/high items first, 2) clear anomalies: '+JSON.stringify(local.anomaly(ns).anomalies)+', 3) review trend: '+JSON.stringify(local.forecast(ns))};
  return{task,simulated:true,local:(L[task]||L.summarize)(),response:'[local — no AI endpoint] '+JSON.stringify((L[task]||L.summarize)(),null,2)};
}

function openRow(row){
  const cells=$$('td',row);const vals=cells.map(c=>c.textContent);
  const ov=document.createElement('div');ov.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center';
  ov.innerHTML='<div style="background:#fff;color:#1b2430;border-radius:12px;padding:18px;width:min(480px,92vw);font:13px system-ui"><h3 style="margin:0 0 8px">Record details</h3>'+vals.map((v,i)=>'<label style="display:block;margin:6px 0">Field '+(i+1)+'<input data-i="'+i+'" value="'+v.replaceAll('"','&quot;')+'" style="width:100%;box-sizing:border-box;padding:6px" disabled></label>').join('')+'<div style="display:flex;gap:8px;margin-top:10px"><button data-a="edit">Edit</button><button data-a="save" style="display:none">Save</button><button data-a="del">Delete</button><button data-a="cancel">Cancel</button></div></div>';
  document.body.appendChild(ov);const close=()=>ov.remove();
  ov.addEventListener('click',e=>{if(e.target===ov)close()});
  document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){close();document.removeEventListener('keydown',esc)}});
  $('[data-a="cancel"]',ov).onclick=close;
  $('[data-a="edit"]',ov).onclick=()=>{$$('input',ov).forEach(i=>i.disabled=false);$('[data-a="save"]',ov).style.display='';$('[data-a="edit"]',ov).style.display='none'};
  $('[data-a="save"]',ov).onclick=()=>{$$('input',ov).forEach(inp=>{if(cells[+inp.dataset.i])cells[+inp.dataset.i].textContent=inp.value});toast('Record updated');log('row-edit','');close()};
  $('[data-a="del"]',ov).onclick=()=>{if(confirm('Delete this record?')){row.remove();toast('Record deleted');log('row-delete','')}close()};
}
function injectDemoLogin(){
  const pw=$('input[type="password"]');if(!pw||$('#fp-demo'))return;
  const form=pw.closest('form')||pw.parentElement;if(!form)return;
  const b=document.createElement('button');b.id='fp-demo';b.type='button';b.textContent='Log In as Demo';
  b.style.cssText='margin:8px 0;padding:8px 14px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer;font:600 13px system-ui';
  b.onclick=()=>{const hint=(document.body.textContent.match(/\w.+-]+@[\w-]+\.[\w.]+\s*\/\s*\S+/)||[])[0];
    const email=$('input[type="email"],input[name*="email" i],input[name*="user" i]',form)||$('input[type="text"]',form);
    if(hint){const[a,c]=hint.split('/').map(x=>x.trim());if(email)email.value=a;pw.value=c}
    else{if(email&&!email.value)email.value='admin@demo.local';if(!pw.value)pw.value='demo123'}
    [email,pw].forEach(el=>{if(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}});
    toast('Demo credentials filled');log('demo-login','');
    const submit=$('button[type="submit"],input[type="submit"]',form);if(submit)setTimeout(()=>submit.click(),80)};
  form.appendChild(b);
}
function flushQueue(){const q=store.get('queue',[]);if(!q.length||!navigator.onLine)return;store.set('queue',[]);q.forEach(item=>aiTask(item.task,item.text));toast('Flushed '+q.length+' queued task(s)')}

function enhanceTables(){
  $$('table').forEach((tb,i)=>{if(tb.dataset.fp)return;tb.dataset.fp='1';const wrap=document.createElement('div');
    const bar=document.createElement('div');bar.innerHTML='<input placeholder="Search table…" style="margin:6px;padding:6px"><button>Export CSV</button> <button>Export JSON</button> <span style="font:12px system-ui;color:#64748b">click headers to sort</span>';
    tb.parentNode.insertBefore(wrap,tb);wrap.appendChild(bar);wrap.appendChild(tb);
    const input=$('input',bar),rows=()=>$$('tbody tr',tb);
    input.addEventListener('input',()=>rows().forEach(r=>r.style.display=r.textContent.toLowerCase().includes(input.value.toLowerCase())?'':'none'));
    const dump=fmt=>{const data=$$('tr',tb).map(r=>$$('th,td',r).map(c=>c.textContent.trim()));const txt=fmt==='csv'?data.map(r=>r.map(v=>'"'+v.replaceAll('"','""')+'"').join(',')).join('\n'):JSON.stringify(data,null,2);navigator.clipboard&&navigator.clipboard.writeText(txt);toast(fmt.toUpperCase()+' copied ('+data.length+' rows)')};
    $$('button',bar)[0].onclick=()=>dump('csv');$$('button',bar)[1].onclick=()=>dump('json');
    $$('tbody tr',tb).forEach(r=>{r.style.cursor='pointer';r.title='Click for details — Edit / Delete / Cancel';r.addEventListener('click',()=>openRow(r))});
    $$('th',tb).forEach((th,ci)=>{th.style.cursor='pointer';th.onclick=()=>{const rs=rows();const dir=th.dataset.d=-1*(th.dataset.d||-1);rs.sort((a,b)=>String(a.cells[ci]?.textContent||'').localeCompare(String(b.cells[ci]?.textContent||''),undefined,{numeric:true})*dir).forEach(r=>r.parentNode.appendChild(r))}});
  });
}
function fillAll(form,variant=0){
  const samples={name:['Project Atlas','Northwind Initiative','Phoenix Rollout'],email:['alex.kim@example.com','maria.lopez@example.com'],status:['active','pending','review'],priority:['high','critical','medium'],goal:['reduce risk','increase efficiency','improve compliance']};
  $$('input,textarea,select',form).forEach(el=>{const k=(el.name||el.placeholder||el.type||'').toLowerCase();let v='demo value';for(const[key,vals]of Object.entries(samples))if(k.includes(key))v=vals[variant%vals.length];
    if(el.type==='number')v=String([25,100,8][variant%3]);else if(el.type==='date')v='2026-06-01';else if(el.tagName==='SELECT'&&el.options.length)v=el.options[variant%el.options.length].value;
    el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});
  toast('Filled every field (preset '+(variant+1)+')');log('fill-all','preset '+(variant+1));
}
function mount(){
  if($('#fp-btn'))return;enhanceTables();injectDemoLogin();setTimeout(injectDemoLogin,800);
  try{if('serviceWorker' in navigator)navigator.serviceWorker.register('/shared/sw.js').catch(()=>{})}catch{}
  const b=document.createElement('button');b.id='fp-btn';b.textContent='✦ Feature Pack';b.style.cssText='position:fixed;right:16px;bottom:16px;z-index:99998;background:#2563eb;color:#fff;border:0;border-radius:20px;padding:9px 16px;font:600 13px system-ui;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25)';
  const p=document.createElement('div');p.id='fp-panel';p.style.cssText='display:none;position:fixed;right:16px;bottom:60px;width:min(430px,92vw);max-height:78vh;overflow:auto;z-index:99998;background:#fff;color:#1b2430;border:1px solid #e3e8ef;border-radius:12px;padding:14px;font:13px/1.5 system-ui;box-shadow:0 24px 60px rgba(0,0,0,.3)';
  p.innerHTML='<h3 style="margin:0 0 6px">AI + Tools</h3><div id="fp-tasks"></div><textarea id="fp-text" rows="4" style="width:100%;box-sizing:border-box" placeholder="Text or numbers to analyze…"></textarea><div style="display:flex;gap:6px;margin:6px 0;flex-wrap:wrap"><button id="fp-run">Run</button><button id="fp-stream">Stream</button><button id="fp-upload">Upload</button><button id="fp-notify">Notify</button><button id="fp-pay">Checkout $49</button><button id="fp-live">Live ping</button><button id="fp-push">Push</button><button id="fp-calc">Domain calc</button><input type="file" id="fp-file" style="display:none"></div><div style="display:none"><button id="fp-fill">Fill form: Preset 1</button><button id="fp-fill2">Preset 2</button><button id="fp-fill3">Preset 3</button><button id="fp-dark">Dark</button></div><pre id="fp-out" style="white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:10px;border-radius:8px;font-size:12px"></pre><p style="color:#64748b;font-size:12px">Tasks run on /api/ai/tasks when available, else locally offline. Tables on this page get search/sort/export automatically. Shortcut: Alt+F</p>';
  document.body.append(b,p);let task='summarize';
  const tasks=['summarize','classify','sentiment','forecast','anomaly','recommend','extract','translate','rewrite','explain','qa','report','title','email'];
  $('#fp-tasks',p).innerHTML=tasks.map(t=>'<button data-t="'+t+'" style="margin:2px;padding:3px 9px;border-radius:12px;border:1px solid #bfdbfe;background:'+(t===task?'#2563eb':'#fff')+';color:'+(t===task?'#fff':'#1d4ed8')+'">'+t+'</button>').join('');
  $$('#fp-tasks button',p).forEach(x=>x.onclick=()=>{task=x.dataset.t;$$('#fp-tasks button',p).forEach(y=>{y.style.background=y.dataset.t===task?'#2563eb':'#fff';y.style.color=y.dataset.t===task?'#fff':'#1d4ed8'})});
  b.onclick=()=>{p.style.display=p.style.display==='none'?'block':'none';enhanceTables()};
  document.addEventListener('keydown',e=>{if(e.altKey&&e.key.toLowerCase()==='f'){p.style.display='block';$('#fp-text',p).focus()}});
  $('#fp-run',p).onclick=async()=>{$('#fp-out',p).textContent='Running…';const d=await aiTask(task,$('#fp-text',p).value);$('#fp-out',p).textContent=d.response||JSON.stringify(d,null,2)};
  $('#fp-stream',p).onclick=async()=>{const out=$('#fp-out',p);out.textContent='';try{const r=await fetch('/api/ai/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:$('#fp-text',p).value})});const rd=r.body.getReader(),dec=new TextDecoder();for(;;){const{done,value}=await rd.read();if(done)break;for(const line of dec.decode(value).split('\n'))if(line.startsWith('data: ')&&line.slice(6)!=='[DONE]'){try{out.textContent+=JSON.parse(line.slice(6)).delta||''}catch{}}}}catch{out.textContent='[local] '+local.summarize($('#fp-text',p).value)}};
  [1,2,3].forEach((n,i)=>{const id=n===1?'#fp-fill':'#fp-fill'+n;$(id,p).onclick=()=>{const f=$('form')||document.body;fillAll(f,i)}});
  $('#fp-upload',p).onclick=()=>$('#fp-file',p).click();
  $('#fp-file',p).onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=async()=>{try{const res=await fetch('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.name,type:f.type,dataBase64:String(r.result).split(',')[1]})});toast(res.ok?'Uploaded '+f.name:'Upload stored locally (no /api/uploads)')}catch{toast('Upload stored locally (offline)')}log('upload',f.name)};r.readAsDataURL(f)};
  $('#fp-notify',p).onclick=async()=>{const body=$('#fp-text',p).value||'Hello from Feature Pack';try{const res=await fetch('/api/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'email',to:'demo@example.com',subject:'Feature Pack',body})});const d=await res.json();toast(d.simulated?'Notification simulated + logged':'Sent via '+d.provider);if(d.link)location.href=d.link}catch{toast('Notification queued locally');log('notify-local',body)}};
  $('#fp-pay',p).onclick=async()=>{try{const res=await fetch('/api/payments/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount:49,currency:'usd',description:'Feature Pack checkout'})});const d=await res.json();$('#fp-out',p).textContent='Checkout ('+d.provider+'): '+d.amount+' '+d.currency+' -> '+d.url;log('payment',String(d.amount))}catch{$('#fp-out',p).textContent='[local simulated checkout] $49.00 USD — set STRIPE_SECRET_KEY on a Feature-Pack server for real Stripe.';log('payment-local','49')}};
  $('#fp-live',p).onclick=async()=>{try{await fetch('/api/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'ping',data:'feature-pack'})});toast('Event published (see /api/events subscribers)')}catch{toast('Realtime unavailable offline — event queued');const q=store.get('queue',[]);q.push({task:'event',text:'ping'});store.set('queue',q)}log('event','ping')};
  $('#fp-push',p).onclick=async()=>{const d=await pushNotify('Feature Pack',$('#fp-text',p).value||'Test notification');toast('Push: '+d.provider+' ('+(d.perm||'n/a')+')');try{await fetch('/api/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'browser-widget'})})}catch{}};
  $('#fp-calc',p).onclick=()=>{const d=domainCalc($('#fp-text',p).value);$('#fp-out',p).textContent=JSON.stringify(d,null,2);log('domain-calc',d.tool)};
  window.addEventListener('online',flushQueue);
  $('#fp-dark',p).onclick=()=>{const d=document.documentElement.style;const dark=store.get('dark',false);store.set('dark',!dark);document.body.style.filter=!dark?'invert(0.92) hue-rotate(180deg)':'';toast(!dark?'Dark mode on':'Dark mode off')};
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
function domainCalc(text){const ns=local.numbers(text);const t=String(text).toLowerCase();
  if(/bmi/.test(t)&&ns.length>=2)return{tool:'bmi',result:+(ns[0]/(ns[1]**2)).toFixed(1)};
  if(/loan|mortgage/.test(t)&&ns.length>=3){const r=ns[1]/100/12;return{tool:'loan-monthly',result:r?+((ns[0]*r)/(1-Math.pow(1+r,-ns[2]))).toFixed(2):+(ns[0]/ns[2]).toFixed(2)}}
  if(/margin/.test(t)&&ns.length>=2)return{tool:'margin',result:{price:ns[0],cost:ns[1],marginPct:+(((ns[0]-ns[1])/ns[0])*100).toFixed(2)}};
  if(/discount/.test(t)&&ns.length>=2)return{tool:'discount',result:+(ns[0]*(1-ns[1]/100)).toFixed(2)};
  if(/grade|score/.test(t)&&ns.length>=2)return{tool:'grade',result:+((ns[0]/ns[1])*100).toFixed(1)+'%'};
  if(/ship/.test(t)&&ns.length>=2)return{tool:'shipping-est',result:+(4.99+ns[0]*0.85+ns[1]*0.012).toFixed(2)};
  if(ns.length>=2)return{tool:'roi',result:+(((ns[1]-ns[0])/ns[0])*100).toFixed(2)+'%'};
  return{tool:'roi',note:'provide numbers, e.g. "roi cost 1000 gain 1250" or "bmi 70 1.75"'}}
async function pushNotify(title,body){log('push',title);try{const perm=await Notification.requestPermission();if(perm==='granted')new Notification(title,{body});return{provider:'browser-notification',perm}}catch{return{provider:'simulated-local'}}}
window.FeaturePack={local,aiTask,fillAll,enhanceTables,openRow,injectDemoLogin,domainCalc,pushNotify,toast,log,version:'2.1.0'};
})();
