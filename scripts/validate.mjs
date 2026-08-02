const config=(await import('../app.config.mjs')).default;
const errors=[];
if(config.features.length<12)errors.push('Expected at least 12 features');
for(const feature of config.features){if(feature.fields.length<4)errors.push(`${feature.id}: expected at least four custom fields`);if(!feature.seedSubjects?.length)errors.push(`${feature.id}: missing seed subjects`);for(const field of feature.fields)if(field.sample==null)errors.push(`${feature.id}.${field.key}: missing standard scenario value`);}
if(errors.length){console.error(errors.join('\n'));process.exit(1);}console.log(`Validated ${config.title}: ${config.features.length} domain features, ${config.features.reduce((n,f)=>n+f.fields.length,0)} custom fields.`);
