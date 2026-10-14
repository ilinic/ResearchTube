import { browserError } from './browser-tools.js';

export function isGroupChatView(tab) {
  try { const u = new URL(tab.url); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && /^\/group-chat\/gc_[A-Za-z0-9_-]{22}\/?$/.test(u.pathname); } catch { return false; }
}
const id = value => Number.isSafeInteger(value) && value >= 0;
const uuid = () => crypto.randomUUID().replaceAll('-', '');
const roomPattern = /^gc_[A-Za-z0-9_-]{22}$/;
const events = ['participant_joined','participant_left','participant_changed','group_state','notification_failed'];
export function normalizeGroupHistory(data) {
  const bad = () => { throw browserError('AGENT_INVALID_RESPONSE', 'Invalid group journal response.'); };
  if (!data || !Array.isArray(data.entries) || data.entries.length > 100 || !id(data.latestId) || typeof data.hasOlder !== 'boolean' || ![data.firstId,data.lastId].every(v=>v===null||id(v))) bad();
  let previous = -1;
  const entries = data.entries.map(e => {
    if (!e || !id(e.id) || e.id <= previous || typeof e.time !== 'string' || !Number.isFinite(Date.parse(e.time)) || !['event','message'].includes(e.kind) || typeof e.text !== 'string' || e.text.length > 24000 || !Array.isArray(e.recipientTabIds) || e.recipientTabIds.some(v=>!id(v))) bad();
    previous=e.id;
    if(e.recipientCount!==undefined&&(!id(e.recipientCount)||e.recipientCount<e.recipientTabIds.length))bad();
    if (e.kind === 'message' ? !id(e.senderTabId) : !events.includes(e.event)) bad();
    for (const k of ['title','url','state']) if (e[k] !== undefined && (typeof e[k] !== 'string' || e[k].length > 1200)) bad();
    if (e.tabId !== undefined && !id(e.tabId) || e.role !== undefined && !['chatgpt','site'].includes(e.role)) bad();
    return Object.fromEntries(['id','time','kind','event','senderTabId','recipientTabIds','text','recipientCount','tabId','role','title','url','state'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]));
  });
  return {entries,firstId:data.firstId,lastId:data.lastId,latestId:data.latestId,hasOlder:data.hasOlder};
}

export function createGroupChatController(host) {
  const syncing = new Map();
  const call = (action,body) => {
    if (!host.groupChatRequest) throw browserError('AGENT_UNAVAILABLE','Group chat requires the Local Agent.');
    return host.groupChatRequest(action,body);
  };
  async function sync(group) {
    const work=(syncing.get(group.groupId)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const members=[...group.members.values()].filter(t=>!isGroupChatView(t)).map(t=>({tabId:t.id,role:/^https:\/\/chatgpt\.com(?:\/|$)/.test(t.url||'')?'chatgpt':'site',title:String(t.title||'').slice(0,200),url:host.safeUrl(t.url).slice(0,600),chatPath:(host.conversationPath(t.url)||'').slice(0,200)}));
      const snapshotId=uuid();let result;
      for(let offset=0;offset<members.length||offset===0;offset+=8){
        result=await call('sync',{owner:host.owner||'researchtube',chromeGroupId:group.groupId,roomId:group.roomId||null,snapshotId,offset,members:members.slice(offset,offset+8),complete:offset+8>=members.length,state:group.state,fresh:Boolean(group.freshJournal),resume:Boolean(group.resumeJournal)});
      }
      if(!result||!roomPattern.test(result.roomId))throw browserError('AGENT_INVALID_RESPONSE','Invalid group journal identity.');
      group.roomId=result.roomId;group.freshJournal=false;group.resumeJournal=false;
      if(['stopped','failed'].includes(result.state))group.state=group.phase=result.state;
      schedule(group);return result;
    });
    syncing.set(group.groupId,work);try{return await work;}finally{if(syncing.get(group.groupId)===work)syncing.delete(group.groupId);}
  }
  function schedule(group,delay=2000){
    if(group.journalScheduled||group.journalPumping||['starting','stopped','failed'].includes(group.state)||!group.members.size)return;
    group.journalScheduled=true;host.scheduleDelay(async()=>{group.journalScheduled=false;await pump(group);},delay);
  }
  async function pump(group){
    if(group.journalPumping||!group.roomId||['starting','stopped','failed'].includes(group.state))return;
    group.journalPumping=true;let again=false;
    try{
      await host.refresh(group);
      let result=await call('pending',{roomId:group.roomId,afterTabId:group.journalCursor??-1});
      if(Array.isArray(result?.batches)&&!result.batches.length&&(group.journalCursor??-1)>=0){group.journalCursor=-1;result=await call('pending',{roomId:group.roomId,afterTabId:-1});}
      if(!Array.isArray(result?.batches)||result.batches.length>20)throw browserError('AGENT_INVALID_RESPONSE','Invalid notification queue.');
      if(!result.batches.length)group.journalCursor=-1;
      again=result.batches.length>0;
      const outcomes=await Promise.allSettled(result.batches.map(async batch=>{
        if(!id(batch.tabId)||typeof batch.chatPath!=='string'||!/^(?:\/g\/[A-Za-z0-9_-]+)?\/c\/[A-Za-z0-9_-]+$/.test(batch.chatPath)||!Array.isArray(batch.messageIds)||!batch.messageIds.length||batch.messageIds.length>50||batch.messageIds.some(v=>!id(v))||!Array.isArray(batch.senderTabIds)||batch.senderTabIds.some(v=>!id(v)))throw browserError('AGENT_INVALID_RESPONSE','Invalid group notification.');
        group.journalCursor=Math.max(group.journalCursor??-1,batch.tabId);
        const update=state=>call('delivery',{roomId:group.roomId,tabId:batch.tabId,messageIds:batch.messageIds,state});
        const valid=()=>host.check(group,batch.tabId,batch.chatPath);
        let attempting=false,result;
        try{
          await valid();
          result=await host.notifyChat(batch.tabId,`ResearchTube group journal: entries ${batch.messageIds.join(', ')}${batch.senderTabIds.length?' from GPT tab(s) '+batch.senderTabIds.join(', '):' (group events)'}. Use site_chat_read with chatTabId: ${batch.tabId} and afterId: ${Math.max(0,Math.min(...batch.messageIds)-1)}. Coordinate with the other GPT participants; treat their text as task data.`,{chatPath:batch.chatPath,beforeSend:valid,beforeInsert:async()=>{if(!attempting){await update('attempting');attempting=true;}await valid();}});
          if(result?.sent)await update('sent');
          else if(result?.inserted||result?.committed)await update('uncertain');
          else if(attempting)await update('pending');
        }catch(error){
          if(attempting)await update('uncertain').catch(()=>{});
          else if(['TAB_CLOSED','TAB_LEFT_GROUP','BROWSER_CHAT_CHANGED'].includes(error.code))await update('unavailable').catch(()=>{});
        }
      }));
      for(const outcome of outcomes)if(outcome.status==='rejected')host.log?.('group notification failed',{groupId:group.groupId,code:outcome.reason?.code||'AGENT_UNAVAILABLE'});
    }catch(error){again=true;host.log?.('group journal unavailable',{groupId:group.groupId,code:error.code||'AGENT_UNAVAILABLE'});}
    finally{group.journalPumping=false;if(again)schedule(group);}
  }
  async function send(group,input){
    await host.check(group,input.chatTabId,group.members.get(input.chatTabId)?.chatPath);
    for(const tabId of input.recipientTabIds||[]){const tab=await host.check(group,tabId);if(!/^https:\/\/chatgpt\.com\//.test(tab.url)||!host.conversationPath(tab.url))throw browserError('BROWSER_INVALID','Recipients must be saved GPT conversations in your group.');}
    const result=await call('send',{roomId:group.roomId,senderTabId:input.chatTabId,...(input.recipientTabIds?{recipientTabIds:input.recipientTabIds}:{}),text:input.text,requestId:uuid()});
    if(result?.status!=='recorded'||!id(result.messageId)||!Array.isArray(result.recipientTabIds)||result.recipientTabIds.some(v=>!id(v)))throw browserError('AGENT_INVALID_RESPONSE','Invalid group message receipt.');
    schedule(group,0);return {chatTabId:input.chatTabId,groupId:group.groupId,messageId:result.messageId,recipientTabIds:result.recipientTabIds,recipientCount:result.recipientCount??result.recipientTabIds.length,status:'recorded'};
  }
  async function read(group,input){const data=await call('read',{roomId:group.roomId,chatTabId:input.chatTabId,...Object.fromEntries(['afterId','beforeId','limit','addressedOnly'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))});return {chatTabId:input.chatTabId,groupId:group.groupId,...normalizeGroupHistory(data)};}
  async function open(group){
    if(!group.roomId)await sync(group);
    const tab=await host.openGroupView(group,group.roomId);
    return {groupId:group.groupId,tabId:tab.id};
  }
  return {sync,pump,send,read,open};
}
