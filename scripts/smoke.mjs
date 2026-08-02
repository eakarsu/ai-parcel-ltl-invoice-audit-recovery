const base=`http://127.0.0.1:${process.env.API_PORT||5553}`;
const health=await fetch(`${base}/api/health`).then(r=>r.json());if(health.status!=='ok')throw new Error('Health failed');
const credentials=await fetch(`${base}/api/auth/demo-credentials`).then(r=>r.json());
const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:credentials.email,password:credentials.password})});if(!login.ok)throw new Error(`Login failed ${login.status}`);const {token}=await login.json();const headers={authorization:`Bearer ${token}`};
const app=await fetch(`${base}/api/app`,{headers}).then(r=>r.json());
const dashboard=await fetch(`${base}/api/dashboard`,{headers}).then(r=>r.json());if(dashboard.totals.records<app.features.length*15)throw new Error('Dashboard record total is incomplete');
for(const feature of app.features){
  const response=await fetch(`${base}/api/features/${feature.id}/records`,{headers});if(!response.ok)throw new Error(`${feature.id} records failed`);const data=await response.json();if(data.items.length<15)throw new Error(`${feature.id} has only ${data.items.length} records`);
  const values=Object.fromEntries(feature.fields.map(field=>[field.key,field.sample]));
  const calculated=await fetch(`${base}/api/features/${feature.id}/calculate`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({values})});if(!calculated.ok)throw new Error(`${feature.id} calculation failed`);const calculation=await calculated.json();if(!calculation.result?.headline||!Array.isArray(calculation.result.sections))throw new Error(`${feature.id} calculation shape invalid`);
}
const first=app.features[0];const values=Object.fromEntries(first.fields.map(field=>[field.key,field.sample]));
const createdResponse=await fetch(`${base}/api/features/${first.id}/records`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({values,title:'Automated smoke validation case'})});if(!createdResponse.ok)throw new Error('Create flow failed');const created=(await createdResponse.json()).item;
const transitioned=await fetch(`${base}/api/features/${first.id}/records/${created.id}/transition`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({status:'Review'})});if(!transitioned.ok)throw new Error('Transition flow failed');
const analytics=await fetch(`${base}/api/analytics`,{headers}).then(r=>r.json());if(analytics.modules.length!==app.features.length)throw new Error('Analytics coverage incomplete');
const audit=await fetch(`${base}/api/audit-events`,{headers}).then(r=>r.json());if(!audit.items.some(item=>item.object_reference===created.reference))throw new Error('Audit event missing');
if(process.env.LIVE_AI==='1'&&health.ai.configured){const analyzed=await fetch(`${base}/api/features/${first.id}/analyze`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({values,analysisType:'smoke-validation'})});if(!analyzed.ok)throw new Error(`OpenRouter analysis failed ${analyzed.status}`);const result=(await analyzed.json()).result;if(!result.headline||!Array.isArray(result.metrics)||!Array.isArray(result.sections)||!Array.isArray(result.actions))throw new Error('Professional AI result shape invalid');}
console.log(`Smoke passed: login, ${app.features.length} feature tables, calculations, create/transition, analytics, and audit history${process.env.LIVE_AI==='1'&&health.ai.configured?', plus live OpenRouter rendering':''}.`);
