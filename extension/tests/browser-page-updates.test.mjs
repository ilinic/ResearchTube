import assert from "node:assert/strict";
import { createBrowserPage, inspectInteractionTarget } from "../browser-page.js";
import { browserToolDefinitions, validateBrowserInput } from "../browser-tools.js";
import { browserObservationOptions } from "../browser-observation-options.js";
import { assertSchema } from "./fixtures/schema-check.mjs";

const ax = (nodeId, role, name, children = [], backend = Number(nodeId) + 100) => ({ nodeId, role: { value: role }, name: { value: name }, childIds: children, backendDOMNodeId: backend });
function fixture(observation) {
  const session = { agentTabId: 1, pageVersion: 1, revision: 1, url: "https://site.test/page?secret=PRIVATE", title: "Page", childSessions: new Map(), observation };
  const trees = new Map([
    ["main", [ax("1", "RootWebArea", "Page", ["2", "3", "4"]), ax("2", "button", "Expand"), ax("3", "image", "Photo"), ax("4", "heading", "Article", ["5"]), ax("5", "paragraph", "", ["6"]), ax("6", "paragraph", "", ["7"]), ax("7", "StaticText", "Useful article text")]],
    ["ad", [ax("20", "RootWebArea", "Ad", ["21"]), ax("21", "image", "Advertisement")]]
  ]);
  const urls = new Map([[103, "https://private.test/photo.jpg?signed=PRIVATE"], [121, "https://private.test/ad.jpg?token=PRIVATE"]]);
  const commands = [];
  let withFrame = false, action = null, duringRead = null, failRead = false;
  const host = { context: () => ({ chatTabId: 22, group: { groupId: 7, chatTabId: 22, revision: 1, state: "running", totalTabs: 0, nextOffset: null, tabs: [], error: null } }), check: async () => {}, command: async (tab, method, params, targetSessionId) => {
    commands.push({ method, params });
    if (method === "Page.getFrameTree") return targetSessionId ? { frameTree: { frame: { id: "ad", parentId: "main" } } } : { frameTree: { frame: { id: "main" }, childFrames: withFrame ? [{ frame: { id: "ad", parentId: "main" } }] : [] } };
    if (method === "Accessibility.getFullAXTree") {
      if (failRead) throw Error("loading");
      if (params.frameId === "ad" && session.childSessions.size && !targetSessionId) throw Error("Frame belongs to a separate target");
      const nodes = structuredClone(trees.get(params.frameId));
      await duringRead?.(params.frameId);
      return { nodes };
    }
    if (method === "Accessibility.getPartialAXTree") return { nodes: [...trees.values()].flat().filter(node => node.backendDOMNodeId === params.backendNodeId) };
    if (method === "DOM.resolveNode") return { object: { objectId: String(params.backendNodeId) } };
    if (method === "Runtime.callFunctionOn") {
      const backend = Number(params.objectId);
      if (params.functionDeclaration.includes("function inspectBrowserElement")) return { result: { value: { tag: "img", attributes: [], bounds: null, resources: urls.has(backend) ? [{ kind: [...trees.values()].flat().find(node => node.backendDOMNodeId === backend)?.role.value === "link" ? "document" : "image", url: urls.get(backend) }] : [], editable: false, password: false } } };
      if(params.functionDeclaration.includes("function inspectInteractionTarget"))return {result:{value:{elementExists:true,elementVisible:true,elementEnabled:true,insideViewport:true,focused:true,bounds:{x:0,y:0,width:40,height:40},viewport:{width:800,height:600},blockedBy:null,focusedElement:null,point:params.arguments[0].value||{x:20,y:20}}}};
      return { result: { value: true } };
    }
    if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 40, 0, 40, 40, 0, 40] } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") await action?.();
    return {};
  } };
  const page = createBrowserPage(session, host);
  const read = async args => { const result = await page.observe(args); assertSchema(browserToolDefinitions().find(tool => tool.name === "site_read").outputSchema, result); return result; };
  const click = async nodeId => { const result = await page.act({ steps: [{ action: "click", nodeId }] }); assertSchema(browserToolDefinitions().find(tool => tool.name === "site_interact").outputSchema, result); return result; };
  return { session, page, host, trees, urls, commands, read, click, frame: () => { withFrame = true; }, onAction: fn => { action = fn; }, onRead: fn => { duringRead = fn; }, failRead: () => { failRead = true; } };
}

// One bounded first call reaches real content below outline depth, with live
// resource references. Serialised structure, not just labels, spends the budget.
const first = fixture();
const initial = await first.read();
assert.ok(initial.nodes.some(node => node.name === "Useful article text"));
assert.equal(initial.changes.pageChanged, true);
assert.equal(initial.changes.addedResources, 1);
assert.doesNotMatch(JSON.stringify(initial), /PRIVATE|signed|private\.test/);
const outline = await first.read({ mode: "outline" });
assert.ok(!outline.nodes.some(node => node.name === "Useful article text"));
assert.equal(outline.changes.addedNodes, 0);
const ceiling = fixture({ maxNodes: 2, maxChars: 1000 });
const limited = await ceiling.read({ maxNodes: 1000, maxChars: 100000 });
assert.equal(limited.nodes.length, 2);
assert.ok(JSON.stringify(limited.nodes).length <= 1000);
assert.equal(limited.nextOffset, 2);
const continued = await ceiling.read({ offset: limited.nextOffset });
assert.equal(continued.nodes[0].role, "image");
const long = fixture({ maxNodes: 200, maxChars: 1500 });
long.trees.get("main")[0].name.value = "Long text ".repeat(1000);
const bounded = await long.read();
assert.ok(JSON.stringify(bounded.nodes).length <= 1500);
assert.ok(bounded.nodes[0].truncated);

// An action returns the new panel/text/resources directly. Unaffected targets
// retain their IDs, and no second public observe call is needed.
const button = initial.nodes.find(node => node.role === "button");
const image = initial.nodes.find(node => node.role === "image");
const oldResource = image.resources[0].resourceId;
const noChange = await first.click(button.nodeId);
assert.equal(noChange.observeAgain, false);
assert.deepEqual(noChange.observation.nodes, []);
const refreshesBeforeBatch=first.commands.filter(row=>row.method==='Accessibility.getFullAXTree').length;
const batched=await first.page.act({steps:[{action:'click',nodeId:button.nodeId},{action:'click',nodeId:button.nodeId}]});
assert.equal(batched.completedSteps,2);
assert.equal(batched.failedStep,null);
assert.equal(first.commands.filter(row=>row.method==='Accessibility.getFullAXTree').length,refreshesBeforeBatch+1,'one AX refresh for the whole sequence');
assertSchema(browserToolDefinitions().find(tool=>tool.name==='site_interact').outputSchema,batched);
// Submitting a search or following a link may asynchronously replace the
// document. Never spend seconds refreshing the outgoing page's AX tree.
const search=fixture();
await search.read();
const beforeSearch=search.commands.filter(row=>row.method==='Accessibility.getFullAXTree').length;
const submitted=await search.page.act({steps:[{action:'key',key:'Enter'}]});
assert.equal(submitted.completedSteps,1);
assert.equal(submitted.failedStep,null);
assert.equal(submitted.observation,null);
assert.equal(submitted.observationError,null);
assert.equal(submitted.observeAgain,true);
assert.equal(search.commands.filter(row=>row.method==='Accessibility.getFullAXTree').length,beforeSearch,'Enter defers the AX refresh');
assertSchema(browserToolDefinitions().find(tool=>tool.name==='site_interact').outputSchema,submitted);
assert.ok((await search.read()).nodes.length,'site_read still observes after Enter');
const linked=fixture();
linked.trees.get('main')[0].childIds.push('8');
linked.trees.get('main').push(ax('8','link','Search results'));
const linkRead=await linked.read();
const beforeLink=linked.commands.filter(row=>row.method==='Accessibility.getFullAXTree').length;
const followed=await linked.click(linkRead.nodes.find(node=>node.role==='link').nodeId);
assert.equal(followed.completedSteps,1);
assert.equal(followed.observation,null);
assert.equal(followed.observeAgain,true);
assert.equal(linked.commands.filter(row=>row.method==='Accessibility.getFullAXTree').length,beforeLink,'link click defers the AX refresh');
const navigating=fixture();
const navigationRead=await navigating.read();
const navigationButton=navigationRead.nodes.find(node=>node.role==='button');
navigating.onAction(()=>{navigating.session.pageVersion+=1;});
const stopped=await navigating.page.act({steps:[{action:'click',nodeId:navigationButton.nodeId},{action:'scroll',amount:10}]});
assert.equal(stopped.completedSteps,1);
assert.equal(stopped.failedStep.index,1);
assert.equal(stopped.failedStep.code,'PAGE_CHANGED');
assert.equal(navigating.commands.filter(row=>row.params.type==='mouseWheel').length,0,'navigation cancels the rest of the batch');
assert.equal(stopped.observation,null);
assert.equal(stopped.observationError,null);
assert.equal(stopped.observeAgain,true);
assert.equal(navigating.commands.filter(row=>row.method==='Accessibility.getFullAXTree').length,1,'known navigation skips the old AX tree');
first.onAction(() => {
  first.trees.get("main")[0].childIds.push("8");
  first.trees.get("main").push(ax("8", "image", "New photograph"));
  first.urls.set(108, "https://private.test/new.jpg?token=PRIVATE");
});
const update = await first.click(button.nodeId);
assert.equal(update.observeAgain, false);
assert.equal(update.observation.changes.pageChanged, false);
assert.equal(update.observation.changes.addedNodes, 1);
assert.equal(update.observation.changes.updatedNodes, 1);
assert.equal(update.observation.changes.addedResources, 1);
assert.ok(update.observation.nodes.some(node => node.name === "New photograph" && node.resources?.length === 1));
assert.ok(!update.observation.nodes.some(node => node.nodeId === image.nodeId));
assert.equal(first.page.getResource(oldResource).entry.id, image.nodeId);

// Changes to a selected action are still rejected before input. Changing the
// image URL creates a fresh resource ID and removes the old one.
first.trees.get("main").find(node => node.nodeId === "2").name.value = "Different operation";
const beforeClicks = first.commands.filter(row => row.params.type === "mousePressed").length;
assert.equal((await first.click(button.nodeId)).failedStep.code, "STALE_NODE");
assert.equal(first.commands.filter(row => row.params.type === "mousePressed").length, beforeClicks);
const partial=await first.page.act({steps:[{action:'scroll',amount:50},{action:'click',nodeId:button.nodeId},{action:'scroll',amount:50}]});
assert.equal(partial.completedSteps,1);
assert.equal(partial.failedStep.index,1);
assert.equal(partial.failedStep.code,'STALE_NODE');
assert.equal(partial.observeAgain,true);
assert.equal(first.commands.filter(row=>row.method==='Input.dispatchMouseEvent'&&row.params.type==='mouseWheel').length,1,'later steps are not replayed');
first.urls.set(103, "https://private.test/replacement.jpg");
const replacement = await first.read();
const currentImage = replacement.nodes.find(node => node.nodeId === image.nodeId);
assert.notEqual(currentImage.resources[0].resourceId, oldResource);
assert.ok(replacement.changes.removedResourceIds.includes(oldResource));
assert.throws(() => first.page.getResource(oldResource), { code: "BROWSER_RESOURCE_NOT_FOUND" });

// A navigating iframe invalidates only that frame. Its replacement never reuses
// old IDs, even with identical AX/backend identifiers and labels.
const framed = fixture(); framed.frame();
const both = await framed.read();
const mainImage = both.nodes.find(node => node.name === "Photo");
const adImage = both.nodes.find(node => node.name === "Advertisement");
framed.page.invalidateFrame("ad"); framed.session.revision++;
await framed.page.requireNode(mainImage.nodeId);
assert.equal(framed.page.getResource(mainImage.resources[0].resourceId).entry.id, mainImage.nodeId);
await assert.rejects(framed.page.requireNode(adImage.nodeId), { code: "STALE_NODE" });
const afterFrame = await framed.read();
assert.equal(afterFrame.page.pageVersion, both.page.pageVersion);
assert.equal(afterFrame.nodes.find(node => node.name === "Photo").nodeId, mainImage.nodeId);
assert.notEqual(afterFrame.nodes.find(node => node.name === "Advertisement").nodeId, adImage.nodeId);
assert.ok(afterFrame.changes.removedNodeIds.includes(adImage.nodeId));
assert.equal(afterFrame.changes.pageChanged, false);

// In-flight reads may not reinstall a frame's old nodes after its navigation.
let navigated = false;
framed.onRead(frame => { if (frame === "ad" && !navigated) { navigated = true; framed.page.invalidateFrame("ad"); } });
const raced = await framed.read();
assert.ok(!raced.nodes.some(node => node.name === "Advertisement"));
assert.equal(raced.nodes.find(node => node.name === "Photo").nodeId, mainImage.nodeId);
framed.onRead(null);
const reloaded = await framed.read();
const newestAd = reloaded.nodes.find(node => node.name === "Advertisement");
assert.notEqual(newestAd.nodeId, afterFrame.nodes.find(node => node.name === "Advertisement").nodeId);
framed.session.pageVersion++; framed.page.invalidate();
await assert.rejects(framed.page.requireNode(mainImage.nodeId), { code: "PAGE_CHANGED" });

// A read failure after a successful click does not invite repeating that click.
const loading = fixture(); const ready = await loading.read();
loading.onAction(() => loading.failRead());
const dispatched = await loading.click(ready.nodes.find(node => node.role === "button").nodeId);
assert.equal(dispatched.observation, null);
assert.equal(dispatched.observeAgain, true);
assert.match(dispatched.observationError.message, /step may have been dispatched/);
assert.equal(loading.commands.filter(row => row.params.type === "mousePressed").length, 1);

// Agent options are strict, backward-compatible and never accept booleans as
// numbers. Values are ceilings shared by first reads and post-action updates.
assert.deepEqual(browserObservationOptions(), { maxNodes: 200, maxChars: 48000 });
assert.deepEqual(browserObservationOptions({ maxNodes: 5, maxChars: 1200 }), { maxNodes: 5, maxChars: 1200 });
for (const value of [null, [], { maxNodes: null }, { maxNodes: true }, { maxChars: "1200" }, { maxNodes: 1001 }, { maxChars: 999 }]) assert.throws(() => browserObservationOptions(value), { code: "AGENT_INVALID_RESPONSE" });
console.log("Browser page updates: bounded full first read, action deltas, unchanged IDs, resource replacement, frame-local invalidation, navigation races and dispatched-action read failures: ok");

// Download links contribute document resources on the first read; changing a
// link destination with the same caption is rejected before a click.
const documents=fixture();
documents.trees.get("main")[0].childIds.push("30");
documents.trees.get("main").push({...ax("30","link","Download report"),properties:[{name:"url",value:{value:"https://private.test/report?token=PRIVATE"}}]});
documents.urls.set(130,"https://private.test/report?token=PRIVATE");
const docs=await documents.read();
const link=docs.nodes.find(node=>node.role==="link");
assert.equal(link.resources[0].kind,"document");
assert.doesNotMatch(JSON.stringify(docs),/private\.test|PRIVATE/);
documents.trees.get("main").find(node=>node.nodeId==="30").properties[0].value.value="https://private.test/different-operation";
assert.equal((await documents.click(link.nodeId)).failedStep.code,"STALE_NODE");
assert.equal(documents.commands.filter(row=>row.params.type==="mousePressed").length,0);
console.log("Browser document references: first-read discovery and same-label link destination guard: ok");

// Detached out-of-process targets are rejected even during the very first
// snapshot, when no cached entries exist from which to find their frames.
const detached=fixture(); detached.frame();
detached.session.childSessions.set("oop",{sessionId:"oop"});
let once=false;
detached.onRead(frame=>{if(frame==="ad" && !once){once=true;detached.page.invalidateFrame(null,"oop");detached.session.childSessions.delete("oop");}});
const withoutDetached=await detached.read();
assert.ok(withoutDetached.nodes.some(node=>node.name==="Photo"));
assert.ok(!withoutDetached.nodes.some(node=>node.name==="Advertisement"));
console.log("Browser detached targets: first-read response cannot resurrect removed iframe entries: ok");

// Protected descendants are metadata only: never ask CDP for their AX/DOM.
const restricted=fixture();restricted.frame();
const restrictedCommand=restricted.host.command;
restricted.host.command=async(tab,method,params,target)=>{
 const result=await restrictedCommand(tab,method,params,target);
 if(method==='Page.getFrameTree'&&!target){
  result.frameTree.frame.url='https://forum.test/discussion';
  result.frameTree.childFrames.push({frame:{id:'extension',parentId:'main',url:'chrome-extension://OTHER/private.html'},childFrames:[{frame:{id:'nested',parentId:'extension',url:'https://private.test/nested'}}]});
 }
 return result;
};
const restrictedRead=await restricted.read();
assert.ok(restrictedRead.nodes.some(node=>node.name==='Useful article text'));
assert.ok(restrictedRead.nodes.some(node=>node.name==='Advertisement'),'ordinary cross-origin child frames remain readable');
assert.equal(restrictedRead.page.omittedFrameCount,2);
assert.ok(!restricted.commands.some(command=>['extension','nested'].includes(command.params.frameId)));
assert.doesNotMatch(JSON.stringify(restrictedRead),/chrome-extension|OTHER|private\.test/);

// AX in the main document survives a refused or hung child's visual supplement.
for(const stalled of [false,true]){
 const isolated=fixture();isolated.frame();isolated.host.frameTimeoutMs=10;
 const command=isolated.host.command;
 isolated.host.command=async(tab,method,params,target)=>{
  if(method==='DOM.resolveNode'&&params.backendNodeId>=120){
   if(stalled)return new Promise(()=>{});
   throw Error('Cannot access a chrome-extension:// URL of different extension');
  }
  return command(tab,method,params,target);
 };
 const partial=await isolated.read();
 assert.ok(partial.nodes.some(node=>node.name==='Useful article text'));
 assert.ok(partial.nodes.some(node=>node.name==='Advertisement'));
 assert.equal(partial.page.imageDiscoveryIncomplete,true);
}
const failedChild=fixture();failedChild.frame();
const childCommand=failedChild.host.command;
failedChild.host.command=(tab,method,params,target)=>{
 if(method==='Accessibility.getFullAXTree'&&params.frameId==='ad')throw Error('Cannot access a chrome-extension:// URL of different extension');
 return childCommand(tab,method,params,target);
};
const surviving=await failedChild.read();assert.ok(surviving.nodes.some(node=>node.name==='Useful article text'));assert.equal(surviving.page.omittedFrameCount,1);
// Root failures are not replaced with an empty successful observation.
const failedRoot=fixture();const rootCommand=failedRoot.host.command;
failedRoot.host.command=(tab,method,params,target)=>{if(method==='Page.getFrameTree'&&!target)throw Error('blocked');return rootCommand(tab,method,params,target);};
await assert.rejects(failedRoot.read(),{code:'BROWSER_UNAVAILABLE'});
const failedMainAx=fixture();failedMainAx.frame();failedMainAx.failRead();await assert.rejects(failedMainAx.read(),{code:'BROWSER_UNAVAILABLE'});
console.log('Browser inaccessible frames: protected descendants skipped, child AX/DOM failures and timeouts isolated, main-document failures explicit: ok');

// A partially covered element can still be clicked at an unobstructed point.
const fakeDoc={defaultView:{innerWidth:100,innerHeight:100,getComputedStyle:()=>({display:"block",visibility:"visible",opacity:"1",overflowX:"visible",overflowY:"visible"})}};
const fake=(tag,role)=>({nodeType:1,isConnected:true,ownerDocument:fakeDoc,tagName:tag,getAttribute:name=>name==="role"?role:null,getRootNode:()=>fakeDoc,matches:()=>false,closest:()=>null,getClientRects:()=>[1],getBoundingClientRect:()=>({left:0,top:0,right:80,bottom:80,width:80,height:80})});
const actualTarget=fake("BUTTON","button"),overlay=fake("DIV","dialog");
fakeDoc.activeElement=actualTarget;fakeDoc.elementFromPoint=x=>x===40?overlay:actualTarget;
assert.deepEqual(inspectInteractionTarget.call(actualTarget).point,{x:20,y:40});
fakeDoc.elementFromPoint=()=>overlay;
assert.equal(inspectInteractionTarget.call(actualTarget).blockedBy.role,"dialog");
actualTarget.getBoundingClientRect=()=>({left:0,top:120,right:80,bottom:200,width:80,height:80});
assert.equal(inspectInteractionTarget.call(actualTarget).insideViewport,false);

// No mouse press is sent if the target stays obstructed after recovery.
const blocked=fixture();const blockedRead=await blocked.read();
const blockedCommand=blocked.host.command;let probes=0;
const geometry=(overrides={})=>({elementExists:true,elementVisible:true,elementEnabled:true,insideViewport:true,focused:true,bounds:{x:0,y:0,width:40,height:40},viewport:{width:800,height:600},blockedBy:null,focusedElement:null,point:{x:20,y:20},...overrides});
blocked.host.command=async(tab,method,params,target)=>{
  if(method==="Runtime.callFunctionOn"&&params.functionDeclaration.includes("function inspectInteractionTarget")){
    probes++;return {result:{value:geometry({focused:false,blockedBy:{tag:"div",role:"dialog"},point:null})}};
  }
  return blockedCommand(tab,method,params,target);
};
const obstruction=await blocked.click(blockedRead.nodes.find(n=>n.role==="button").nodeId);
assert.equal(obstruction.failedStep.code,"BROWSER_ELEMENT_OBSCURED");
assert.equal(obstruction.failedStep.diagnostics.actionDispatched,false);
assert.equal(obstruction.failedStep.diagnostics.safeToRetry,true);
assert.equal(obstruction.failedStep.diagnostics.element.blockedBy.role,"dialog");
assert.equal(probes,2);
assert.equal(blocked.commands.filter(row=>row.params.type==="mousePressed").length,0);

// An offscreen target recovers after the centered fallback, without input replay.
const offscreen=fixture();const offscreenRead=await offscreen.read();
const offscreenCommand=offscreen.host.command;let centered=false;
offscreen.host.command=async(tab,method,params,target)=>{
  if(method==="Runtime.callFunctionOn"&&params.functionDeclaration.includes("function centerInteractionTarget"))centered=true;
  if(method==="Runtime.callFunctionOn"&&params.functionDeclaration.includes("function inspectInteractionTarget"))
    return {result:{value:centered?geometry():geometry({insideViewport:false,point:null})}};
  return offscreenCommand(tab,method,params,target);
};
const offscreenResult=await offscreen.click(offscreenRead.nodes.find(n=>n.role==="button").nodeId);
assert.equal(centered,true);assert.equal(offscreenResult.completedSteps,1);
assert.equal(offscreen.commands.filter(row=>row.params.type==="mousePressed").length,1);

// Reload is explicit, single-step, and invalidates old observation IDs.
assert.throws(()=>validateBrowserInput("site_interact",{chatTabId:22,tabId:1,steps:[{action:"reload"},{action:"key",key:"Enter"}]}),{code:"BROWSER_INVALID"});
const reload=fixture();const reloadRead=await reload.read();
const reloadedPage=await reload.page.act({steps:[{action:"reload"}]});
assert.equal(reloadedPage.completedSteps,1);
assert.equal(reloadedPage.observeAgain,true);
assert.equal(reloadedPage.observation,null);
assert.equal(reload.commands.filter(row=>row.method==="Page.reload").length,1);
await assert.rejects(reload.page.requireNode(reloadRead.nodes.find(n=>n.role==="button").nodeId),{code:"PAGE_CHANGED"});
const uncertain=fixture();const uncertainRead=await uncertain.read();
const uncertainCommand=uncertain.host.command;
uncertain.host.command=async(tab,method,params,target)=>{
 if(method==="Input.dispatchMouseEvent"&&params.type==="mousePressed")throw Error("transport lost");
 return uncertainCommand(tab,method,params,target);
};
const unknown=await uncertain.click(uncertainRead.nodes.find(n=>n.role==="button").nodeId);
assert.equal(unknown.failedStep.diagnostics.actionDispatched,true);
assert.equal(unknown.failedStep.diagnostics.safeToRetry,false);
console.log("Interaction geometry, scroll recovery, reload and dispatch uncertainty: ok");

// An editable target that cannot acquire focus must not receive any key input.
const unfocused=fixture();
unfocused.trees.get("main")[0].childIds.push("50");
unfocused.trees.get("main").push(ax("50","textbox","Name"));
const unfocusedRead=await unfocused.read(),unfocusedCommand=unfocused.host.command;
unfocused.host.command=async(tab,method,params,target)=>{
  if(method==="Runtime.callFunctionOn"&&params.functionDeclaration.includes("function inspectBrowserElement"))
    return {result:{value:{editable:true,password:false,resources:[]}}};
  if(method==="Runtime.callFunctionOn"&&params.functionDeclaration.includes("function inspectInteractionTarget"))
    return {result:{value:geometry({focused:false,focusedElement:{tag:"button",role:"button"}})}};
  return unfocusedCommand(tab,method,params,target);
};
const noFocus=await unfocused.page.act({steps:[{action:"type",nodeId:unfocusedRead.nodes.find(n=>n.role==="textbox").nodeId,text:"hello"}]});
assert.equal(noFocus.failedStep.code,"BROWSER_FOCUS_FAILED");
assert.equal(noFocus.failedStep.diagnostics.actionDispatched,false);
assert.equal(noFocus.failedStep.diagnostics.element.focusedElement.tag,"button");
assert.equal(unfocused.commands.filter(row=>row.method==="Input.dispatchKeyEvent"||row.method==="Input.insertText").length,0);
assert.ok(unfocused.commands.findIndex(row=>row.method==="DOM.scrollIntoViewIfNeeded")<unfocused.commands.findIndex(row=>row.method==="DOM.focus"));
assertSchema(browserToolDefinitions().find(tool=>tool.name==="site_interact").outputSchema,noFocus);
