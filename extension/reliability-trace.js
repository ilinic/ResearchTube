// Bounded, best-effort diagnostic batching; no payloads or credentials.
export function createReliabilityTrace({send,version,now=()=>Date.now(),uuid=()=>crypto.randomUUID(),schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}) {
  const allowed=new Set(["event","component","requestId","tool","instanceId","version","level","stage","code","method","status","executionState","exceptionType","schedulerTickId","taskId"]);
  const numbers=new Set(["attempt","tabId","chatTabId","groupId","durationMs","monoMs","atMs","bytes","statementCount","rowsAffected","httpStatus","queueDepth"]);
  let instance=null,timer=null,due=Infinity,flushing=false,dropped=0,bytes=0,retryAfter=0;
  const pending=[];
  const prune=()=>{const cutoff=now()-3600000;while(pending.length&&pending[0].created<cutoff){bytes-=pending.shift().size;dropped++;}};
  function plan(delay=30000){const target=Math.max(now()+delay,retryAfter);if(timer!==null&&due<=target)return;if(timer!==null)cancel(timer);due=target;timer=schedule(()=>{timer=null;due=Infinity;void flush();},Math.max(0,target-now()));}
  function add(event,fields={}){
    try {
      instance ||= uuid();
      const value={component:"extension",version,instanceId:instance,event,level:"INFO",atMs:now(),...fields};
      const clean={};
      for(const [k,v] of Object.entries(value)){
        if(allowed.has(k)&&typeof v==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v))clean[k]=v;
        else if(numbers.has(k)&&typeof v==="number"&&Number.isFinite(v))clean[k]=v;
      }
      const size=JSON.stringify(clean).length+1;
      if(size>4096)return;
      prune();
      while(pending.length&&(pending.length>=25000||bytes+size>16*1024*1024)){
        let index=pending.findIndex(item=>!["WARN","ERROR"].includes(item.value.level));
        if(index<0)index=0;
        bytes-=pending.splice(index,1)[0].size;dropped++;
      }
      pending.push({value:clean,size,created:now()});bytes+=size;
      if(!flushing)plan(bytes>=256*1024||clean.level==="ERROR"?1000:30000);
    }catch{}
  }
  async function flush(){
    if(flushing||now()<retryAfter)return;
    if(timer!==null){cancel(timer);timer=null;due=Infinity;}
    flushing=true;
    try{
      prune();
      // Keep requests below Agent's HTTP body limit. Yield after four batches.
      for(let i=0;i<4&&pending.length;i++){
        const batch=[];let size=2;
        for(const item of pending){if(batch.length>=200||size+item.size>48000)break;batch.push(item);size+=item.size;}
        const lost=dropped;
        const events=batch.map(item=>item.value);
        if(lost)events.push({component:"extension",event:"TRACE_DROPPED",level:"WARN",atMs:now(),rowsAffected:lost,instanceId:instance,version});
        await send(events);
        for(const item of batch){const index=pending.indexOf(item);if(index>=0){pending.splice(index,1);bytes-=item.size;}}
        dropped=Math.max(0,dropped-lost);
      }
    }catch{retryAfter=now()+30000;}finally{flushing=false;if(pending.length)plan();}
  }
  return {add,flush,status:()=>({queued:pending.length,dropped,bytes})};
}
