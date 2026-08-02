function scenarioValue(type,sample,options,index){
  if(type==='select')return options[Math.min(index,options.length-1)]??sample;
  if(type==='number'||type==='currency')return Math.round(Number(sample||0)*(index===1?2.75:.43)*100)/100;
  if(type==='date')return sample;
  return `${sample}${index===1?' · High Risk':' · Exception'}`;
}

export function feature(id,code,title,description,outcome,fieldSpecs,options={}){
  const fields=fieldSpecs.map(spec=>{
    const [key,label,type,sample,fieldOptions=[],high,exception,help]=spec;
    return {key,label,type,required:true,sample,options:fieldOptions,high:high??scenarioValue(type,sample,fieldOptions,1),exception:exception??scenarioValue(type,sample,fieldOptions,2),help:help||`Required evidence for ${title.toLowerCase()}.`};
  });
  return {id,code,title,description,outcome,fields,registerTitle:options.registerTitle||`${title} register`,calculateLabel:options.calculateLabel||`Evaluate ${title}`,amountField:options.amountField||fields.find(item=>item.type==='currency')?.key,baseAmount:options.baseAmount||25000,seedSubjects:options.subjects||[`${title} standard case`,`${title} priority case`,`${title} exception case`,`${title} review case`,`${title} approved case`]};
}

export function defineApp(meta,features){return {...meta,features};}
