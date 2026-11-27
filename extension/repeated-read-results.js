// A conversation-scoped exact-result cache. Store digests and request IDs only.
// Never suppress mutations, status checks, errors, widgets, or independent media.
export const REPEAT_READ_TOOLS=Object.freeze(["db_query","workspace_read_text","memory_read","plan_read","agent_memory_read","agent_memory_history","skill_list","skill_read","skill_history"]);
export function repeatReadSchema(schema) {
  const hash={type:"string",pattern:"^[a-f0-9]{64}$"};
  const ref={type:"object",additionalProperties:false,properties:{unchanged:{type:"boolean",const:true},resultHash:hash,previousRequestId:{type:"string"},message:{type:"string"}},required:["unchanged","resultHash","previousRequestId","message"]};
  return {type:"object",properties:{...schema.properties,...ref.properties},anyOf:[schema,ref]};
}
export function createRepeatedReadCache({now=()=>Date.now(),digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,"0")).join(""),ttl=3600000,capacity=4096}={}) {
  const entries=new Map();
  const prune=()=>{for(const [key,item] of entries){if(now()-item.at<ttl)break;entries.delete(key);}};
  async function prepare(tool,args,result,target,requestId) {
    prune();
    if(!REPEAT_READ_TOOLS.includes(tool)||!target?.conversationId||!target.documentId||!result||result.isError||result._meta||result.structuredContent?.error||result.structuredContent?.success===false||!Array.isArray(result.content)||result.structuredContent==null)return {result};
    const json=JSON.stringify(result.structuredContent);
    // Only plain, exact JSON copies. A different textual representation may
    // contain important independent information.
    if(result.content.length!==1||result.content[0].type!=="text"||result.content[0].text!==json||Object.keys(result.content[0]).some(k=>k!=="type"&&k!=="text")||json.length<1024)return {result};
    const input=Object.fromEntries(Object.keys(args).filter(k=>k!=="force_full"&&k!=="chatTabId").sort().map(k=>[k,args[k]]));
    const [key,hash]=await Promise.all([digest(JSON.stringify([target.conversationId,target.documentId,tool,input])),digest(json)]);
    const prior=entries.get(key);
    if(args.force_full!==true&&prior?.hash===hash&&now()-prior.at<ttl){
      const ref={unchanged:true,resultHash:hash,previousRequestId:prior.requestId,message:"Same result as previously forwarded in this conversation. Use force_full=true if the earlier data is unavailable."};
      return {result:{...result,structuredContent:ref,content:[{type:"text",text:JSON.stringify(ref)}]},repeated:true};
    }
    return {result,remember:()=>{prune();entries.delete(key);entries.set(key,{hash,requestId,at:now()});while(entries.size>capacity)entries.delete(entries.keys().next().value);}};
  }
  return {prepare,clear:()=>entries.clear(),size:()=>{prune();return entries.size;}};
}
