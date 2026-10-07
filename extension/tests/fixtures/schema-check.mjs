import assert from 'node:assert/strict';
// Structural JSON Schema checks used for shipped MCP fixtures. Formats are
// annotations, as in JSON Schema's default vocabulary; these contracts use no refs.
export function assertSchema(schema,value,label='result') {
  const failures=(schema,value,path)=>{
    if(schema===true)return [];
    if(schema===false)return [path+' forbidden'];
    let errors=[];
    if(schema.anyOf && !schema.anyOf.some(s=>!failures(s,value,path).length))errors.push(path+' matches no anyOf branch');
    if(schema.oneOf && schema.oneOf.filter(s=>!failures(s,value,path).length).length!==1)errors.push(path+' must match exactly one oneOf branch');
    if(schema.allOf)errors.push(...schema.allOf.flatMap(s=>failures(s,value,path)));
    if(schema.const!==undefined && value!==schema.const)errors.push(path+' const');
    if(schema.enum && !schema.enum.includes(value))errors.push(path+' enum');
    const types=schema.type?Array.isArray(schema.type)?schema.type:[schema.type]:null;
    const isType=t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?value!==null && typeof value==='object' && !Array.isArray(value):t==='integer'?Number.isInteger(value):typeof value===t;
    if(types && !types.some(isType))return [...errors,path+' type'];
    if(typeof value==='string') {
      if(schema.pattern && !new RegExp(schema.pattern).test(value))errors.push(path+' pattern');
      if(schema.minLength!==undefined && [...value].length<schema.minLength)errors.push(path+' minLength');
      if(schema.maxLength!==undefined && [...value].length>schema.maxLength)errors.push(path+' maxLength');
    }
    if(typeof value==='number')for(const [name,test] of Object.entries({minimum:n=>value>=n,maximum:n=>value<=n,exclusiveMinimum:n=>value>n,exclusiveMaximum:n=>value<n})){
      if(schema[name]!==undefined && !test(schema[name]))errors.push(path+' '+name);
    }
    if(Array.isArray(value)) {
      if(schema.minItems!==undefined && value.length<schema.minItems)errors.push(path+' minItems');
      if(schema.maxItems!==undefined && value.length>schema.maxItems)errors.push(path+' maxItems');
      if(schema.items)errors.push(...value.flatMap((v,i)=>failures(schema.items,v,`${path}[${i}]`)));
    } else if(value!==null && typeof value==='object') {
      for(const key of schema.required??[])if(!Object.hasOwn(value,key))errors.push(path+'.'+key+' required');
      for(const [key,v] of Object.entries(value)) {
        if(schema.properties?.[key])errors.push(...failures(schema.properties[key],v,path+'.'+key));
        else if(schema.additionalProperties===false)errors.push(path+'.'+key+' additionalProperty');
      }
    }
    return errors;
  };
  assert.deepEqual(failures(schema,value,label),[],label+' must match the published schema');
}
