import assert from 'node:assert/strict';
import {fixture,initialTree} from './fixtures/browser-agent-fixture.mjs';
import {browserToolDefinitions,validateBrowserInput} from '../browser-tools.js';
import {assertSchema} from './fixtures/schema-check.mjs';
const definitions=browserToolDefinitions();
const batch=fixture({multipleImages:true});await batch.agent.start(10);
const batchIds=(await batch.run('site_read',{mode:'full'})).nodes.filter(n=>n.role==='image').map(n=>n.resources[0].resourceId).reverse();
assert.equal(batchIds.length,3);
const batchTask=await batch.run('site_get_images',{resourceIds:batchIds});
assert.equal(batchTask.status,'queued');assert.equal(batch.saved.length,0);assert.equal(batch.uploads.length,0);
batch.onAttach(async()=>assert.equal(batch.saved.length,3,'every resource is saved before attachment'));
await batch.scheduled.shift()();
const batchResult=await batch.run('site_files_status',{taskId:batchTask.taskId});
assert.equal(batchResult.status,'completed');assert.equal(batchResult.progressPercent,100);
assert.deepEqual(batchResult.resourceIds,batchIds);assert.deepEqual(batchResult.files.map(f=>f.resourceId),batchIds);
assert.equal(batchResult.resourceId,null);assert.equal(batchResult.workspacePath,null);assert.equal(batchResult.mimeType,null);
assert.deepEqual(batch.saved.map(f=>f.taskId),[batchTask.taskId,batchTask.taskId,batchTask.taskId],'batch filenames share the public standard task ID');
assert.deepEqual(batch.saved.map(f=>f.resourceId),batchIds);
assert.equal(new Set(batchResult.files.map(f=>f.workspacePath)).size,3,'resource IDs distinguish files within the same task');
for (const file of batchResult.files) { assert.ok(file.workspacePath.includes(`[${batchTask.taskId}]`)); assert.doesNotMatch(file.workspacePath,/browser_|resource/); assert.equal(file.workspacePath,`study-this-site/${file.resourceId.replace(/^r_/,"res_")} [${batchTask.taskId}].png`); }
for(const file of batch.saved)assert.match(file.taskId,/^tsk_[A-Za-z0-9_-]{10}$/);
assert.equal(batch.uploads.length,1);assert.equal(batch.uploads[0].files.length,3);
assert.deepEqual(batchResult.submittedFiles,batchResult.files.map(f=>f.workspacePath));
assert.equal(batch.uploads[0].options.target.tabId,22);
for(const id of batchIds)assert.ok(batch.uploads[0].options.continuation.includes(id));
assert.ok(!JSON.stringify(batchResult).includes('PRIVATE'));
const resourceInput=definitions.find(d=>d.name==='site_get_images').inputSchema;
assertSchema(resourceInput,{chatTabId:22,tabId:21,resourceIds:batchIds});
assertSchema(resourceInput,{chatTabId:22,tabId:21,resourceId:batchIds[0]});
for(const args of [{},{resourceId:batchIds[0],resourceIds:batchIds},{resourceIds:[]},{resourceIds:[batchIds[0],batchIds[0]]},{resourceIds:['bad']},{resourceIds:null}])assert.throws(()=>validateBrowserInput('site_get_images',{chatTabId:22,tabId:21,...args}),{code:'BROWSER_INVALID'});
const batchBefore=batch.saved.length;batch.host.resourceCountLimit=async()=>2;
await assert.rejects(batch.run('site_get_images',{resourceIds:batchIds}),error=>error.code==='BROWSER_INVALID'&&error.message.includes('maximum is 2'));
assert.equal(batch.saved.length,batchBefore);assert.equal(batch.scheduled.length,0);

// The two tools enforce their scopes before creating jobs or fetching bytes.
const typed=fixture({nonImages:true});await typed.agent.start(10);
const typedNodes=(await typed.run('site_read',{})).nodes;
const typedImage=typedNodes.find(n=>n.role==='image').resources[0].resourceId;
const otherIds=typedNodes.flatMap(n=>n.resources).filter(r=>r.kind!=='image').map(r=>r.resourceId);
assert.equal(otherIds.length,3);
const beforeTypeCheck=typed.events.length;
for(const [name,id] of [['site_get_images',typedImage],['site_get_files',otherIds[0]]])await assert.rejects(typed.run(name,{tabId:81,resourceId:id}),{code:'TAB_CLOSED'});
for(const args of [{resourceId:otherIds[0]},{resourceIds:[typedImage,otherIds[0]]}]){
 await assert.rejects(typed.run('site_get_images',{...args}),{code:'BROWSER_RESOURCE_TYPE_MISMATCH'});
}
await assert.rejects(typed.run('site_get_files',{resourceId:typedImage}),{code:'BROWSER_RESOURCE_TYPE_MISMATCH'});
await assert.rejects(typed.run('site_get_files',{resourceIds:[otherIds[0],typedImage]}),{code:'BROWSER_RESOURCE_TYPE_MISMATCH'});
assert.equal(typed.scheduled.length,0);assert.equal(typed.saved.length,0);assert.equal(typed.uploads.length,0);
assert.ok(!typed.events.slice(beforeTypeCheck).some(row=>row[0]==='Network.loadNetworkResource'),'wrong kinds do not fetch bytes');
for(const name of ['site_get_images','site_get_files']){
 const schema=definitions.find(d=>d.name===name).inputSchema;
 assertSchema(schema,{chatTabId:22,tabId:21,resourceIds:[typedImage]});
 for(const args of [{},{resourceId:typedImage,resourceIds:[typedImage]},{resourceIds:[]},{resourceIds:[typedImage,typedImage]},{resourceIds:null}])assert.throws(()=>validateBrowserInput(name,{chatTabId:22,tabId:21,...args}),{code:'BROWSER_INVALID'});
}
const otherTask=await typed.run('site_get_files',{resourceIds:otherIds,addToChat:true,tabId:21});
assert.equal(otherTask.status,'queued');assert.equal(otherTask.tabId,21);assert.equal(otherTask.chatTabId,22);assert.match(otherTask.taskId,/^tsk_[A-Za-z0-9_-]{10}$/);
await typed.scheduled.shift()();
const otherResult=await typed.run('site_files_status',{taskId:otherTask.taskId});
assert.equal(otherResult.status,'completed');assert.equal(typed.uploads.length,1);
assert.deepEqual(otherResult.files.map(f=>f.mimeType),['application/pdf','audio/mpeg','video/mp4']);
assert.deepEqual(otherResult.files.map(f=>f.extraction),['original','original','original']);
assert.equal(otherResult.submittedFiles.length,3);assert.ok(!JSON.stringify(otherResult).includes('PRIVATE'));
const saveOnly=await typed.run('site_get_files',{resourceId:otherIds[0],addToChat:false});
await typed.scheduled.shift()();assert.equal((await typed.run('site_files_status',{taskId:saveOnly.taskId})).status,'completed');assert.equal(typed.uploads.length,1);
const cancelledOther=await typed.run('site_get_files',{resourceId:otherIds[1]});
assert.equal((await typed.run('site_files_cancel',{taskId:cancelledOther.taskId})).cancelled,true);
await typed.scheduled.shift()();assert.equal((await typed.run('site_files_status',{taskId:cancelledOther.taskId})).status,'cancelled');
// A download link that actually returns an image must not broaden site_get_files.
const swapped=fixture({nonImages:true});await swapped.agent.start(10);
const swappedDoc=(await swapped.run('site_read',{})).nodes.flatMap(n=>n.resources).find(r=>r.kind==='document');
const originalCommand=swapped.host.command;
swapped.host.command=async(id,method,params,...rest)=>method==='Network.loadNetworkResource'?{resource:{success:true,stream:'changed',headers:{'Content-Type':'image/png'}}}:method==='IO.read'?{data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),base64Encoded:true,eof:true}:originalCommand(id,method,params,...rest);
const changedTask=await swapped.run('site_get_files',{resourceId:swappedDoc.resourceId});
await swapped.scheduled.shift()();
const changedResult=await swapped.run('site_files_status',{taskId:changedTask.taskId});
assert.equal(changedResult.status,'failed');assert.equal(changedResult.error.code,'BROWSER_RESOURCE_TYPE_MISMATCH');assert.equal(swapped.saved.length,0);assert.equal(swapped.uploads.length,0);
// Blob image elements can yield non-image bytes; refuse them before saving.
const blobImage=fixture();const blobCommand=blobImage.host.command;
blobImage.host.command=async(id,method,params,...rest)=>{
 if(method==='Runtime.callFunctionOn' && params.functionDeclaration.includes('FileReader'))return {result:{value:{url:'data:application/pdf;base64,'+Buffer.from('%PDF-1.7').toString('base64'),mimeType:'application/pdf'}}};
 const result=await blobCommand(id,method,params,...rest);
 if(method==='Runtime.callFunctionOn' && params.functionDeclaration.includes('function inspectBrowserElement') && params.objectId==='104')result.result.value.resources[0].url='blob:https://site.test/image';
 return result;
};
await blobImage.agent.start(10);
const blobId=(await blobImage.run('site_read',{})).nodes.find(n=>n.role==='image').resources[0].resourceId;
const blobTask=await blobImage.run('site_get_images',{resourceId:blobId});
await blobImage.scheduled.shift()();
const blobResult=await blobImage.run('site_files_status',{taskId:blobTask.taskId});
assert.equal(blobResult.status,'failed');assert.equal(blobResult.error.code,'BROWSER_RESOURCE_TYPE_MISMATCH');assert.equal(blobImage.saved.length,0);assert.equal(blobImage.uploads.length,0);
console.log('Site downloads: image/non-image scopes, mixed-batch rejection before jobs, byte-type validation, PDF/audio/video delivery, save-only and shared cancellation: ok');

// A save failure or cancellation midway leaves published files in status and
// does not upload a partial batch, delete files or clear the Composer.
for(const outcome of ['failed','cancelled']){
 const partial=fixture({multipleImages:true});await partial.agent.start(10);
 const ids=(await partial.run('site_read',{mode:'full'})).nodes.filter(n=>n.role==='image').map(n=>n.resources[0].resourceId);
 const task=await partial.run('site_get_images',{resourceIds:ids});
 if(outcome==='failed'){
  const save=partial.host.saveResource;let saves=0;
  partial.host.saveResource=async(...args)=>{if(++saves===2)throw Object.assign(Error('save unavailable'),{code:'BROWSER_RESOURCE_UNAVAILABLE'});return save(...args);};
 }else partial.onSave(async()=>{await partial.run('site_files_cancel',{taskId:task.taskId});});
 await partial.scheduled.shift()();
 const result=await partial.run('site_files_status',{taskId:task.taskId});
 assert.equal(result.status,outcome);assert.equal(result.files.length,1);assert.equal(partial.saved.length,1);
 assert.equal(partial.uploads.length,0);assert.deepEqual(result.submittedFiles,[]);assert.equal(result.submittedAt,null);
 assert.equal(result.files[0].resourceId,ids[0]);
}
console.log('Browser resource batches: saved before one upload, ordered files, configured limits, strict inputs, partial failure/cancellation and independent scheduled execution: ok');


const navigatedBatch=fixture({multipleImages:true});await navigatedBatch.agent.start(10);
const nids=(await navigatedBatch.run('site_read',{mode:'full'})).nodes.filter(n=>n.role==='image').map(n=>n.resources[0].resourceId);
const ntask=await navigatedBatch.run('site_get_images',{resourceIds:nids});
navigatedBatch.onSave(async()=>{if(navigatedBatch.saved.length===3){navigatedBatch.tabs.get(21).url='https://site.test/next';await navigatedBatch.agent.onEvent({tabId:21},'Page.frameNavigated',{frame:{id:'main',url:'https://site.test/next'}});}});
await navigatedBatch.scheduled.shift()();
const nstatus=await navigatedBatch.run('site_files_status',{taskId:ntask.taskId});
assert.equal(nstatus.status,'failed');assert.equal(nstatus.error.code,'PAGE_CHANGED');assert.equal(nstatus.files.length,3);
assert.equal(navigatedBatch.uploads.length,0,'navigation during save keeps receipts but blocks old-page delivery');
console.log('Browser batches: navigation during final save preserves files and stops before upload: ok');

// A child navigation must not reject main-page resources, even between save
// and Send. The selected child's own navigation must still stop its delivery.
{
 const scoped=fixture();
 scoped.host.studyOptions=async()=>({groupTabs:false,detailedLogging:false,observation:{maxNodes:50,maxChars:16000}});
 await scoped.agent.start(10);
 assert.match(scoped.events.find(row=>row[0]==='prompt')[2],/chatTabId: 22/);
 await scoped.agent.onEvent({tabId:21},'Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});
 const before=await scoped.run('site_read',{});
 const mainImage=before.nodes.find(node=>node.role==='image');
 const childImage=before.nodes.filter(node=>node.role==='image')[1];
 const childRoot=before.roots[1];
 const mainRoot=before.roots[0];
 assert.ok(childImage && childRoot);
 const mainTask=await scoped.run('site_get_images',{resourceId:mainImage.resources[0].resourceId});
 scoped.onAttach(async()=>{await scoped.agent.onEvent({tabId:21,sessionId:'child'},'Page.frameNavigated',{frame:{id:'childFrame',url:'https://ad.test/reloaded'}});});
 await scoped.scheduled.shift()();
 assert.equal((await scoped.run('site_files_status',{taskId:mainTask.taskId})).status,'completed');
 await scoped.run('site_get_node',{nodeId:mainRoot});
 await assert.rejects(scoped.run('site_get_node',{nodeId:childImage.nodeId}),{code:'STALE_NODE'});
 const after=await scoped.run('site_read',{});
 assert.equal(after.page.pageVersion,before.page.pageVersion);
 assert.equal(after.roots[0],mainRoot);
 assert.notEqual(after.roots[1],childRoot);
 const newChildImage=after.nodes.filter(node=>node.role==='image')[1];
 const childTask=await scoped.run('site_get_images',{resourceId:newChildImage.resources[0].resourceId});
 await scoped.scheduled.shift()();
 const failed=await scoped.run('site_files_status',{taskId:childTask.taskId});
 assert.equal(failed.status,'failed');assert.equal(failed.error.code,'STALE_NODE');
 assert.equal(failed.files.length,1,'saved bytes survive selected-frame navigation before Send');
 assert.deepEqual(failed.submittedFiles,[]);
 const sameDocumentUrl='https://site.test/article?filter=new#details';
 scoped.tabs.get(21).url=sameDocumentUrl;
 await scoped.agent.onEvent({tabId:21},'Page.navigatedWithinDocument',{frameId:'main',url:sameDocumentUrl});
 const same=await scoped.run('site_get_node',{nodeId:mainRoot});
 assert.equal(same.page.pageVersion,before.page.pageVersion);
 assert.equal(same.page.url,'https://site.test/article');
}
console.log('Browser frame routing: unrelated iframe reload preserves main IDs/delivery; selected-frame reload preserves bytes and stops Send; same-document navigation retains IDs: ok');
