import 'dotenv/config';
import { amount as parseAmount } from '../recovery-domain.mjs';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const config=(await import('../../app.config.mjs')).default;
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const password=process.env.DEMO_PASSWORD||'LocalDemo!2026';
const users=[
  ['runtime-admin@example.com','Runtime Administrator','admin'],
  ['operations@example.com','Operations Lead','operator'],
  ['reviewer@example.com','Independent Reviewer','reviewer']
];
const owners=['Maya Chen','Noah Williams','Priya Shah','Daniel Ortiz','Avery Brooks'];
const statuses=['Open','Investigating','Review','Approved','Closed'];
const risks=['Low','Moderate','High','Critical'];

function valuesFor(feature,index){
  const scenario=index%5===1?'high':index%5===2?'exception':'standard';
  return Object.fromEntries(feature.fields.map(field=>{
    let value=field[scenario] ?? field.sample ?? '';
    if(typeof value==='number') value=Math.round(value*(1+(index%4)*0.07)*100)/100;
    return [field.key,value];
  }));
}

try{
  const hash=await bcrypt.hash(password,10);
  for(const [email,name,role] of users) await pool.query(`INSERT INTO app_users(email,password_hash,name,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING`,[email,hash,name,role]);
  for(const [featureIndex,feature] of config.features.entries()){
    for(let index=1;index<=15;index+=1){
      const reference=`${feature.code}-${String(index).padStart(3,'0')}`;
      const payload={...valuesFor(feature,index),__example:true,__version:1};
      const amount=(feature.amountField && payload[feature.amountField] !== undefined ? parseAmount(payload[feature.amountField])/100 : 0);
      const risk='Not assessed';
      const status=statuses[(index+featureIndex)%statuses.length];
      const title=`EXAMPLE · ${feature.title} · ${feature.seedSubjects[(index-1)%feature.seedSubjects.length]}`;
      const due=new Date(Date.UTC(2026,7,1+((index*3+featureIndex)%85))).toISOString().slice(0,10);
      await pool.query(`INSERT INTO feature_records(feature_id,reference,title,status,owner,risk,due_date,amount,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(reference) DO NOTHING`,[feature.id,reference,title,status,owners[(index+featureIndex)%owners.length],risk,due,amount,payload]);
    }
  }
  const count=(await pool.query('SELECT count(*)::int AS count FROM feature_records')).rows[0].count;
  if(count>=config.features.length*15){
    await pool.query(`INSERT INTO audit_events(actor,action,object_type,object_reference,detail) SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE action=$2 AND object_reference=$4)`,['system','seeded','application',config.id,`Provisioned ${config.features.length} domain capabilities with at least 15 PostgreSQL records each.`]);
  }
  console.log(`Seeded ${config.features.length} features and ${count} operational records.`);
}finally{await pool.end();}
