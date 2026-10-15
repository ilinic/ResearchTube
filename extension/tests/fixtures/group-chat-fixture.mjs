// Private Agent boundary fixture; actual journal durability is exercised in Python.
export function fakeGroupChat() {
 const rooms=new Map();let next=0;
 const entry=(room,item)=>{const e={id:++room.last,time:new Date().toISOString(),...item};room.entries.push(e);return e;};
 return {rooms,request:async(action,body)=>{
  if(action==='sync'){
   let room=body.roomId?rooms.get(body.roomId):[...rooms.values()].find(r=>r.groupId===body.chromeGroupId);
   if(!room){const roomId='gc_'+String(++next).padStart(22,'0');room={roomId,groupId:body.chromeGroupId,members:new Map(),entries:[],cursors:new Map(),last:0,state:'starting',chunks:[]};rooms.set(roomId,room);}
   if(body.offset===0)room.chunks=[];room.chunks.push(...body.members);
   if(body.complete){room.members=new Map(room.chunks.map(m=>[m.tabId,m]));if(!['stopped','failed'].includes(room.state)||body.resume)room.state=body.state;return {roomId:room.roomId,latestId:room.last,state:room.state};}
   return {accepted:true};
  }
  const room=rooms.get(body.roomId);if(!room)throw Error('room missing');
  const key=body.chatTabId+':'+body.chatPath;
  if(action==='post'){const e=entry(room,{senderTabId:body.senderTabId,text:body.text});return {status:'recorded',messageId:e.id};}
  if(action==='summary')return {unreadCount:room.entries.filter(e=>e.id>(room.cursors.get(key)||0)&&e.senderTabId!==body.chatTabId).length,latestId:room.last};
  if(action==='read'){
   const automatic=body.afterId===undefined&&body.beforeId===undefined;
   const after=automatic?(room.cursors.get(key)||0):body.afterId;
   let entries=room.entries.filter(e=>(after===undefined||e.id>after)&&(body.beforeId===undefined||e.id<body.beforeId));
   entries=after===undefined?entries.slice(-(body.limit||50)):entries.slice(0,body.limit||50);
   const firstId=entries[0]?.id??null,lastId=entries.at(-1)?.id??after??null;
   if(automatic&&entries.length)room.cursors.set(key,lastId);
   return {entries,firstId,lastId,latestId:room.last,hasOlder:Boolean(firstId&&room.entries.some(e=>e.id<firstId)),hasMore:Boolean(entries.length&&room.entries.some(e=>after===undefined?e.id<firstId:e.id>lastId))};
  }
  throw Error('Removed operation: '+action);
 }};
}
