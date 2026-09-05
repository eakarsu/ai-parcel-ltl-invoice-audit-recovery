export function invalid(message,status=422){return Object.assign(new Error(message),{status});}
export function amount(value,label='Amount'){
 if(!['string','number'].includes(typeof value)||!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim()))throw invalid(`${label} must be a non-negative amount with at most two decimal places`);
 const [whole,fraction='']=String(value).trim().split('.');const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(cents>BigInt(Number.MAX_SAFE_INTEGER))throw invalid(`${label} exceeds supported precision`);
 return Number(cents);
}
function numeric(value,label,min=0,max=1e12){
 if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<min||Number(value)>max)throw invalid(`${label} is outside its allowed range`);
 return Number(value);
}
export function validateInputs(feature,input,required=false){
 if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('Field values must be an object');
 const output={};
 for(const field of feature.fields){const v=input[field.key];
  if(v==null||v===''){if(required&&field.required)throw invalid(`${field.label} is required`);continue;}
  if(field.type==='currency')amount(v,field.label);
  else if(field.type==='number')numeric(v,field.label);
  else if(field.type==='select'){if(!field.options.includes(v))throw invalid(`Choose a valid ${field.label}`);}
  else if(field.type==='date'){const s=String(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw invalid(`${field.label} must be a valid date`);}
  else if(typeof v!=='string'||!v.trim()||v.length>10000)throw invalid(`${field.label} must contain 1–10,000 characters`);
  output[field.key]=v;
 }
 return output;
}
const money=(cents,currency)=>new Intl.NumberFormat('en-US',{style:'currency',currency}).format(cents/100);
function report(feature,metrics,summary,extra={}){return {headline:`${feature.title} — input reconciliation`,executiveSummary:summary,risk:'Not assessed',confidence:null,provider:'Domain engine',model:'Exact input reconciliation v2',metrics,sections:[{title:'Calculation scope',detail:'Calculated only from entered amounts. Source accuracy, entitlement and realized recovery have not been independently verified.'}],actions:['Review the source amounts and governing agreement.','Record evidence and an independent review before closure.'],disclaimer:'An arithmetic variance is not a confirmed refund or a compliance determination.',...extra};}
export function calculate(config,feature,raw){
 const input=validateInputs(feature,raw),currency=config.currency||'USD';
 let rule=config.calculation;
 if(config.engine==='cam'){
  if(['pro-rata','occupancy-registry'].includes(feature.id)){
   const area=numeric(input.tenantAreaSqFt,'Tenant area'),building=numeric(input.buildingAreaSqFt,'Building area',Number.MIN_VALUE);
   if(area>building)throw invalid('Tenant area cannot exceed building area');
   const ratio=area/building*100;const metrics=[{label:'Calculated area share',value:`${ratio.toFixed(4)}%`}];
   if(input.proRataPercent!==undefined){const recorded=numeric(input.proRataPercent,'Recorded share',0,100);metrics.push({label:'Difference from recorded share',value:`${(ratio-recorded).toFixed(4)} percentage points`});}
   return report(feature,metrics,'Area ratio calculated. Apply this share only to the lease-defined eligible expense pool.',{calculatedSharePercent:ratio});
  }
  if(feature.id==='admin-fees'){
   const base=amount(input.feeBase,'Fee base'),percent=numeric(input.feePercent,'Fee percent',0,100);const expected=Math.round(base*percent/100);
   const billed=amount(input.billedAmount,'Billed fee');
   return report(feature,[{label:'Calculated fee',value:money(expected,currency)},{label:'Billed fee',value:money(billed,currency)},{label:'Signed fee variance',value:money(billed-expected,currency)}],'Fee base multiplied by the entered fee percentage; the contract must confirm the base and rate.',{expectedCents:expected,signedVarianceCents:billed-expected,potentialRecoveryCents:Math.max(0,billed-expected)});
  }
  if(feature.fields.some(f=>f.key==='allowedAmount'))rule={actualKey:'billedAmount',expectedKey:'allowedAmount',actualLabel:'Billed amount',expectedLabel:'Entered supported amount',direction:'actual-minus-expected'};
 }
 if(!rule){
  const provided=feature.fields.filter(f=>input[f.key]!==undefined);
  if(!provided.length)throw invalid('Enter source fields before reviewing the record');
  return report(feature,provided.map(f=>({label:f.label,value:f.type==='currency'?money(amount(input[f.key]),currency):String(input[f.key])})),'Input summary only. This register has no verified financial calculation; no savings have been inferred.',{calculationAvailable:false});
 }
 const actual=amount(input[rule.actualKey],rule.actualLabel||rule.actualKey),expected=amount(input[rule.expectedKey],rule.expectedLabel||rule.expectedKey);
 const signed=rule.direction==='expected-minus-actual'?expected-actual:actual-expected;
 return report(feature,[{label:rule.actualLabel,value:money(actual,currency)},{label:rule.expectedLabel,value:money(expected,currency)},{label:'Signed variance',value:money(signed,currency)},{label:'Potential recovery from entered amounts',value:money(Math.max(0,signed),currency)}],'The entered amounts have been reconciled. A positive difference is a candidate for review, not confirmed recovered revenue.',{actualCents:actual,expectedCents:expected,signedVarianceCents:signed,potentialRecoveryCents:Math.max(0,signed)});
}
export function normalizeAI(raw,feature,model){
 let data;try{data=typeof raw==='string'?JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g,'')):raw;}catch{throw invalid('AI returned invalid JSON; no draft was saved',502);}
 if(!data||typeof data!=='object'||Array.isArray(data))throw invalid('AI returned an invalid draft',502);
 for(const key of ['headline','executiveSummary'])if(typeof data[key]!=='string'||!data[key].trim()||data[key].length>20000)throw invalid(`AI draft is missing ${key}`,502);
 if(!Array.isArray(data.sections)||!data.sections.length||data.sections.length>12||!data.sections.every(s=>s&&typeof s.title==='string'&&s.title.trim()&&typeof s.detail==='string'&&s.detail.trim()))throw invalid('AI draft sections are invalid',502);
 if(!Array.isArray(data.actions)||!data.actions.every(s=>typeof s==='string'&&s.trim()))throw invalid('AI draft actions are invalid',502);
 if(!Array.isArray(data.metrics)||!data.metrics.every(m=>m&&typeof m.label==='string'&&m.label.trim()&&['string','number'].includes(typeof m.value)))throw invalid('AI draft metrics are invalid',502);
 return {...data,risk:'Not assessed',confidence:null,provider:'OpenRouter',model,status:'draft',sourceStatus:'user_supplied_unverified',disclaimer:'AI draft based on entered fields. No external records were fetched, no financial outcome was verified, and confidence was not measured.'};
}
export function authorizeTransition(user,record,next){
 const transitions={Open:['Investigating'],Investigating:['Review','Open'],Review:['Approved','Investigating'],Approved:['Closed','Investigating'],Closed:[]};
 if(!transitions[record.status]?.includes(next))throw invalid(`Cannot move from ${record.status} to ${next}`,409);
 if(!['admin','operator','reviewer'].includes(user.role))throw invalid('Workflow role required',403);
 if(next==='Approved'){
  if(!['admin','reviewer'].includes(user.role))throw invalid('Independent reviewer required',403);
  const creator=record.payload?.__createdBy;
  if(!creator)throw invalid('Legacy record has no creator evidence; recreate it for independent approval',409);
  if(String(creator)===String(user.id))throw invalid('The creator cannot approve this record',403);
 } else if(!['admin','operator'].includes(user.role))throw invalid('Operator role required',403);
 return true;
}
export function localRequest(req){
 const loop=h=>['127.0.0.1','::1','[::1]','localhost','::ffff:127.0.0.1'].includes(h);
 if(!loop(req.socket?.remoteAddress)||!loop(req.hostname))return false;
 if(req.headers?.origin){try{if(!loop(new URL(req.headers.origin).hostname))return false;}catch{return false;}}
 return true;
}
