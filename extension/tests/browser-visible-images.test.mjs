import assert from "node:assert/strict";
import { createBrowserPage, visibleBrowserImages } from "../browser-page.js";
import { browserToolDefinitions } from "../browser-tools.js";
import { assertSchema } from "./fixtures/schema-check.mjs";

function domFixture() {
  const elements = new Map();
  const doc = { nodeType: 9, baseURI: "https://site.test/page", defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: element => element.css } };
  function element(backend, tag = "div", attrs = {}, css = {}, box = {}) {
    const node = { backend, nodeType: 1, tagName: tag.toUpperCase(), ownerDocument: doc, isConnected: true, parentElement: null, children: [],
      css: { display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible", overflowX: "visible", overflowY: "visible", backgroundImage: "none", ...css },
      box: { left: 20, top: 20, right: 120, bottom: 100, width: 100, height: 80, x: 20, y: 20, ...box },
      hasAttribute: name => Object.hasOwn(attrs, name), getAttribute: name => attrs[name] ?? null,
      getBoundingClientRect() { return this.box; }, getRootNode: () => doc, closest: () => null,
      querySelector: () => null, append(child) { child.parentElement = this; this.children.push(child); },
      src: attrs.src || "", currentSrc: attrs.src || "" };
    elements.set(backend, node); return node;
  }
  doc.documentElement = element(100, "html", {}, {}, { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
  return { doc, elements, element };
}

const d = domFixture(), root = d.doc.documentElement;
const photo = d.element(102, "img", { alt: "", src: "https://private.test/photo.jpg?token=PRIVATE" }); root.append(photo);
const background = d.element(130, "div", {}, { backgroundImage: 'url("/background (one).jpg"), url("/two.jpg")' }); root.append(background);
const button = d.element(104, "button", {}, { backgroundImage: 'url("/button.jpg")' }); root.append(button);
const named = d.element(105, "img", { alt: "Named photograph", src: "/named.jpg" }); root.append(named);
const hidden = d.element(106, "img", { alt: "", src: "/hidden.jpg" }, { display: "none" }); root.append(hidden);
const transparent = d.element(107, "div", {}, { opacity: "0" }); root.append(transparent);
const transparentPhoto = d.element(108, "img", { alt: "", src: "/transparent.jpg" }); transparent.append(transparentPhoto);
const offscreen = d.element(109, "img", { alt: "", src: "/offscreen.jpg" }, {}, { left: 900, right: 1000 }); root.append(offscreen);
const clip = d.element(110, "div", {}, { overflowX: "hidden" }, { left: 200, right: 300 }); root.append(clip);
clip.append(d.element(111, "img", { alt: "", src: "/clipped.jpg" }));
const ariaHidden = d.element(112, "img", { alt: "", "aria-hidden": "true", src: "/visible.jpg" }); root.append(ariaHidden);
const shadowHost = d.element(113); root.append(shadowHost);
const shadowPhoto = d.element(114, "img", { alt: "", src: "/shadow.jpg" }); shadowPhoto.getRootNode = () => ({ host: shadowHost }); shadowHost.shadowRoot = { children: [shadowPhoto] };
assert.deepEqual(visibleBrowserImages.call(d.doc).map(node => node.backend), [102, 130, 104, 112, 114]);
assert.deepEqual(visibleBrowserImages.call(d.doc, 2).map(node => node.backend), [102, 130]);
assert.deepEqual(visibleBrowserImages.call(d.doc, 1000, 2).map(node => node.backend), [102]);
assert.equal(visibleBrowserImages.call(transparentPhoto, 1000, 20000, true), false);
hidden.css.display = "block"; hidden.css.visibility = "hidden";
assert.equal(visibleBrowserImages.call(hidden, 1000, 20000, true), false);
shadowHost.css.opacity = "0";
assert.equal(visibleBrowserImages.call(shadowPhoto, 1000, 20000, true), false);
shadowHost.css.opacity = "1";

// Exercise the actual fixed functions through a mock CDP remote-object boundary.
const ax = (nodeId, role, name, children, backend, ignored = false) => ({ nodeId, role: { value: role }, name: { value: name }, childIds: children, backendDOMNodeId: backend, ignored });
const nodes = [ax("root", "RootWebArea", "Page", ["photo", "button"], 100), ax("photo", "none", "", [], 102, true), ax("button", "button", "Open", [], 104)];
const session = { sessionId: "bas_abcdefghij", agentTabId: 1, pageVersion: 1, revision: 1, childSessions: new Map(), title: "Page", url: d.doc.baseURI, observation: { maxNodes: 200, maxChars: 48000 } };
const commands = []; let onDescribe;
const host = { check: async () => {}, command: async (_tab, method, params) => {
  commands.push({ method, params });
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
  if (method === "Accessibility.getFullAXTree") return { nodes: structuredClone(nodes) };
  if (method === "Accessibility.getPartialAXTree") return { nodes: nodes.filter(node => node.backendDOMNodeId === params.backendNodeId) };
  if (method === "DOM.resolveNode") return { object: { objectId: String(params.backendNodeId) } };
  if (method === "Runtime.callFunctionOn") {
    const object = params.objectId === "100" ? d.doc : d.elements.get(Number(params.objectId));
    const value = Function("document", "getComputedStyle", "args", `return (${params.functionDeclaration}).apply(this,args)`)
      .call(object, d.doc, d.doc.defaultView.getComputedStyle, (params.arguments || []).map(arg => arg.value));
    if (!params.returnByValue) { host.matches = value; return { result: { objectId: "images" } }; }
    return { result: { value } };
  }
  if (method === "Runtime.getProperties") return { result: host.matches.map((node, i) => ({ name: String(i), value: { objectId: String(node.backend) } })) };
  if (method === "DOM.describeNode") { await onDescribe?.(); return { node: { backendNodeId: Number(params.objectId) } }; }
  return {};
} };
const page = createBrowserPage(session, host);
const read = async args => { const result = await page.observe(args); assertSchema(browserToolDefinitions().find(tool => tool.name === "site_read").outputSchema, result); return result; };
const first = await read();
assert.equal(first.nodes.length, 6); // frame root, ignored photo, semantic button, three DOM-only images
assert.equal(first.nodes.filter(node => node.role === "button").length, 1);
assert.equal(first.nodes.reduce((n, node) => n + node.resources.length, 0), 6);
assert.doesNotMatch(JSON.stringify(first), /private\.test|PRIVATE|background \(one\)/);
const photoNode = first.nodes.find(node => node.resources.some(resource => page.getResource(resource.resourceId).url === photo.src));
assert.equal(photoNode.role, "image");
assert.equal(photoNode.name, ""); // No fabricated alt description
await page.requireNode(photoNode.nodeId); // ignored partial AX is valid only for a verified visible image
const backgroundNode = first.nodes.find(node => node.resources.length === 2);
assert.equal(backgroundNode.parentId, first.roots[0]);
await page.requireNode(backgroundNode.nodeId); // no AX backing at all
const buttonNode = first.nodes.find(node => node.role === "button");
assert.equal(buttonNode.resources.length, 1);
const again = await read();
assert.deepEqual(again.nodes.map(node => node.nodeId), first.nodes.map(node => node.nodeId));
assert.equal(again.changes.addedNodes, 0);
const oldResource = backgroundNode.resources[0].resourceId;
background.css.backgroundImage = 'url("/replacement.jpg")';
const replacement = await read();
assert.equal(replacement.nodes.find(node => node.nodeId === backgroundNode.nodeId).resources.length, 1);
assert.ok(replacement.changes.removedResourceIds.includes(oldResource));
assert.throws(() => page.getResource(oldResource), { code: "BROWSER_RESOURCE_NOT_FOUND" });
background.css.display = "none";
await assert.rejects(page.requireNode(backgroundNode.nodeId), { code: "STALE_NODE" });
photo.isConnected = false;
await assert.rejects(page.requireNode(photoNode.nodeId), { code: "STALE_NODE" });
button.css.backgroundImage = "none";
const removed = await read();
assert.ok(removed.changes.removedNodeIds.includes(backgroundNode.nodeId));
assert.ok(removed.changes.removedNodeIds.includes(photoNode.nodeId));
assert.equal(removed.nodes.find(node => node.nodeId === buttonNode.nodeId).resources.length, 0);
assert.throws(() => page.getResource(buttonNode.resources[0].resourceId), { code: "BROWSER_RESOURCE_NOT_FOUND" });
const bounded = await read({ maxNodes: 1 });
assert.equal(bounded.nodes.length, 1); assert.equal(bounded.nextOffset, 1);
assert.equal((await read({ maxNodes: 1, offset: 1 })).nodes.length, 1);
let raced = false;
onDescribe = () => { if (!raced) { raced = true; page.invalidateFrame("main"); } };
const duringNavigation = await read();
assert.equal(duringNavigation.nodes.length, 0);
assert.ok(commands.some(command => command.method === "Runtime.releaseObjectGroup"));
session.pageVersion++; page.invalidate();
await assert.rejects(page.requireNode(buttonNode.nodeId), { code: "PAGE_CHANGED" });
console.log("Visible browser images: empty alt, CSS URLs, visibility/clipping/shadow roots, AX deduplication, private resources, guards, stable IDs, pagination and navigation: ok");
