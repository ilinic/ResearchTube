// Private Agent boundary fixture; real durability/HTTP behavior is covered in Python.
export function fakeGroupChat(){
 const rooms=new Map();let next=0;
 const roomFor=body=>{if(!rooms.has(body.roomId))throw Error('room missing');return rooms.get(body.roomId);};
 const entry=(room,item)=>{const e={id:++room.last,time:new Date().toISOString(),recipientTabIds:[],...item};room.entries.push(e);return e;};
 return {rooms,request:async(action,body)=>{
  if(action==='sync'){
   let room=body.roomId?rooms.get(body.roomId):[...rooms.values()].find(r=>r.groupId===body.chromeGroupId);
   if(!room){const roomId='gc_'+String(++next).padStart(22,'0');room={roomId,groupId:body.chromeGroupId,members:new Map(),entries:[],last:0,queue:[],state:'starting',chunks:[]};rooms.set(roomId,room);}
   if(body.offset===0)room.chunks=[];room.chunks.push(...body.members);
   if(body.complete){
    const members=new Map(room.chunks.map(m=>[m.tabId,m]));
    for(const [tabId,m]of members)if(!room.members.has(tabId)){const e=entry(room,{kind:'event',event:'participant_joined',text:'Participant joined.',tabId,role:m.role,title:m.title});if(room.state==='running')for(const old of room.members.values())if(old.role==='chatgpt'&&old.chatPath&&members.has(old.tabId))room.queue.push({id:e.id,tabId:old.tabId,chatPath:old.chatPath,state:'pending'});}
    room.members=members;room.state=body.state;
    return {roomId:room.roomId,latestId:room.last,state:room.state};
   }return {accepted:true};
  }
  const room=roomFor(body);
  if(action==='send'){const recipients=body.recipientTabIds||[...room.members.values()].filter(m=>m.role==='chatgpt'&&m.tabId!==body.senderTabId&&m.chatPath).map(m=>m.tabId);const e=entry(room,{kind:'message',senderTabId:body.senderTabId,recipientTabIds:recipients,text:body.text});for(const tabId of recipients)room.queue.push({id:e.id,tabId,chatPath:room.members.get(tabId).chatPath,state:'pending',senderTabId:body.senderTabId});return {status:'recorded',messageId:e.id,recipientTabIds:recipients};}
  if(action==='read'){let entries=room.entries.filter(e=>(body.afterId===undefined||e.id>body.afterId)&&(body.beforeId===undefined||e.id<body.beforeId));entries=body.afterId===undefined?entries.slice(-(body.limit||50)):entries.slice(0,body.limit||50);return {entries,firstId:entries[0]?.id??null,lastId:entries.at(-1)?.id??body.afterId??null,latestId:room.last,hasOlder:Boolean(entries.length&&room.entries[0].id<entries[0].id)};}
  if(action==='pending'){const batches=new Map();for(const d of room.queue)if(d.state==='pending'&&d.tabId>(body.afterTabId??-1)){const b=batches.get(d.tabId)||{tabId:d.tabId,chatPath:d.chatPath,messageIds:[],senderTabIds:[]};b.messageIds.push(d.id);if(d.senderTabId&&!b.senderTabIds.includes(d.senderTabId))b.senderTabIds.push(d.senderTabId);batches.set(d.tabId,b);}return {batches:[...batches.values()]};}
  if(action==='delivery'){for(const d of room.queue)if(d.tabId===body.tabId&&body.messageIds.includes(d.id))d.state=body.state;return {accepted:true};}
  throw Error(action);
 }};
}
