import { browserError } from "./browser-tools.js";
import { DEFAULT_BROWSER_OBSERVATION } from "./browser-observation-options.js";

export function safePageUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? `${url.origin}${url.pathname}` : ""; } catch { return ""; }
}
const axValue = value => value?.value == null ? "" : String(value.value);
const nodeSignature = node => JSON.stringify([axValue(node.role), axValue(node.name), axValue(node.value), (node.properties || []).filter(property => ["disabled", "checked", "expanded", "selected", "readonly", "busy", "url"].includes(property.name)).map(property => [property.name, axValue(property.value)])]);
const RESOURCE_ROLES = new Set(["image", "video", "audio", "link"]);
const protectedNode = node => ["textbox", "searchbox"].includes(axValue(node.role)) && /(?:password|api[ _-]*key|access[ _-]*token|secret|authorization)/i.test(axValue(node.name)) || node.role?.value === "password" || node.properties?.some(property => ["protected", "password"].includes(property.name) && property.value?.value === true);

// Fixed, read-only DOM enrichment. Page code is never supplied by the model.
export function inspectBrowserElement() {
  const element = this.nodeType === 1 ? this : this.parentElement;
  if (!element || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  const tag = element.tagName.toLowerCase();
  const resources = [];
  const add = (kind, url, rendering = null) => { if (url || rendering) resources.push({ kind, url: url || null, rendering }); };
  if (tag === "img") add("image", element.currentSrc || element.src);
  if (tag === "picture") { const image = element.querySelector("img"); if (image) add("image", image.currentSrc || image.src); }
  if (tag === "video" || tag === "audio") add(tag, element.currentSrc || element.src || element.querySelector("source")?.src);
  if (tag === "video" && element.poster) add("image", element.poster);
  if (tag === "canvas" || tag === "svg") add("image", null, tag);
  if (tag === "a" && element.hasAttribute("download")) add("document", element.href);
  const background = getComputedStyle(element).backgroundImage;
  for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add("image", new URL(match[1], document.baseURI).href);
  const attributes = ["alt", "title", "type", "placeholder", "aria-label", "aria-expanded", "aria-checked", "aria-selected", "disabled", "multiple"].filter(name => element.hasAttribute(name)).map(name => ({ name, value: element.getAttribute(name).slice(0, 500) }));
  // Link destinations are safe page addresses, never signed resource URLs.
  if (tag === "a" && !element.hasAttribute("download")) { try { const url = new URL(element.href); if (["https:", "http:"].includes(url.protocol)) attributes.push({ name: "href", value: url.origin + url.pathname }); } catch {} }
  return { tag, attributes, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, resources, editable: element.isContentEditable || tag === "textarea" && !element.readOnly && !element.disabled || tag === "input" && ["text", "search", "tel", "url", "email", "number"].includes(element.type) && !element.readOnly && !element.disabled, password: tag === "input" && element.type === "password" };
}

export function createBrowserPage(session, host) {
  let index = new Map(), identifiers = new Map(), resources = new Map(), resourceKeys = new Map();
  let counter = 0, resourceCounter = 0, roots = [];
  let indexedVersion = -1;
  const limits = session.observation || DEFAULT_BROWSER_OBSERVATION;
  const frameParents = new Map(), frameEpochs = new Map(), targetEpochs = new Map();
  const liveTarget = target => target.epoch === (frameEpochs.get(target.frameId) || 0) && target.targetEpoch === (targetEpochs.get(target.sessionId || "root") || 0);
  let reported = { version: null, nodes: new Map(), resources: new Set() };
  const command = (method, params = {}, target = {}) => host.command(session.agentTabId, method, params, target.sessionId);
  const metadata = () => ({ pageVersion: session.pageVersion, revision: session.revision, title: (session.title || "").slice(0, 500), url: safePageUrl(session.url) });
  function pruneReferences() {
    for (const [key, id] of identifiers) if (!index.has(id)) identifiers.delete(key);
    for (const [id, item] of resources) if (!index.has(item.entry.id)) resources.delete(id);
    for (const [key, id] of resourceKeys) if (!resources.has(id)) resourceKeys.delete(key);
  }
  function invalidate() { index.clear(); identifiers.clear(); resources.clear(); resourceKeys.clear(); frameParents.clear(); frameEpochs.clear(); targetEpochs.clear(); roots = []; counter = resourceCounter = 0; indexedVersion = -1; }
  function invalidateFrame(frameId, targetSessionId = null) {
    if (!frameId) targetEpochs.set(targetSessionId || "root", (targetEpochs.get(targetSessionId || "root") || 0) + 1);
    const affected = new Set(frameId ? [frameId] : [...index.values()].filter(entry => entry.target.sessionId === targetSessionId).map(entry => entry.target.frameId));
    // Frame IDs are global across flattened debugger targets. Include descendants
    // even when their CDP session differs from the navigating parent.
    let expanded = true;
    while (expanded) { expanded = false; for (const [id, parent] of frameParents) if (affected.has(parent) && !affected.has(id)) { affected.add(id); expanded = true; } }
    for (const id of affected) frameEpochs.set(id, (frameEpochs.get(id) || 0) + 1);
    for (const [id, entry] of index) if (affected.has(entry.target.frameId)) index.delete(id);
    roots = roots.filter(id => index.has(id));
    pruneReferences();
    host.trace?.event("page.frameInvalidated", { frameCount: affected.size });
  }
  async function frames() {
    const targets = [{ sessionId: null }, ...session.childSessions.values()];
    const output = [];
    for (const target of targets) {
      const targetEpoch = targetEpochs.get(target.sessionId || "root") || 0;
      try {
        const result = await command("Page.getFrameTree", {}, target);
        if (!target.sessionId && result.frameTree?.frame?.id) session.mainFrameId = result.frameTree.frame.id;
        const walk = (frame, parentId = null) => { if (!frame) return; frameParents.set(frame.frame.id, frame.frame.parentId || parentId || frameParents.get(frame.frame.id) || null); output.push({ ...target, frameId: frame.frame.id, targetEpoch, epoch: frameEpochs.get(frame.frame.id) || 0 }); for (const child of frame.childFrames || []) walk(child, frame.frame.id); };
        walk(result.frameTree);
      } catch { /* An OOP frame may have detached. Main-frame failures surface below. */ }
    }
    // Parent frame trees include OOP descendants as metadata. Read each frame
    // through its most specific attached target once, rather than issuing a
    // duplicate parent-target read or publishing two identities for one frame.
    const owned = new Map();
    for (const target of output) if (!owned.has(target.frameId) || target.sessionId) owned.set(target.frameId, target);
    return [...owned.values()];
  }
  async function refreshNative() {
    await host.check(session, false);
    const version = session.pageVersion;
    const revision = session.revision;
    if (indexedVersion !== version) invalidate();
    const next = new Map(), nextRoots = [];
    const frameTargets = await frames();
    let rawNodes = 0;
    for (const target of frameTargets) {
      let response;
      try { response = await command("Accessibility.getFullAXTree", { frameId: target.frameId }, target); }
      catch (error) { if (!target.sessionId && !next.size) throw browserError("BROWSER_UNAVAILABLE", "The current page Accessibility Tree is unavailable. Wait for page loading or check Chrome debugger permissions."); else continue; }
      rawNodes += response.nodes?.length || 0;
      if (!liveTarget(target)) continue;
      const raw = new Map((response.nodes || []).map(node => [node.nodeId, node]));
      const keyOf = axId => `${target.sessionId || "root"}:${target.frameId}:${axId}`;
      const identify = axId => { const key = keyOf(axId), oldId = identifiers.get(key), oldEntry = index.get(oldId), current = raw.get(axId); if (!oldId || !oldEntry || oldEntry.backendNodeId !== current.backendDOMNodeId || nodeSignature(oldEntry.raw) !== nodeSignature(current)) identifiers.set(key, `n_${version}_${++counter}`); return identifiers.get(key); };
      const visiting = new Set();
      const walk = (axId, parentId) => {
        if (visiting.has(axId)) return [];
        const rawNode = raw.get(axId); if (!rawNode) return [];
        visiting.add(axId);
        const role = axValue(rawNode.role), name = axValue(rawNode.name), description = axValue(rawNode.description);
        // Hide only our own marked overlay, not arbitrary generic page wrappers.
        if (name === "ResearchTube automation controls") return [];
        const ignored = rawNode.ignored || role === "InlineTextBox" || ["none", "generic"].includes(role) && !name && !description && !rawNode.value?.value;
        const id = ignored ? null : identify(axId);
        const childIds = (rawNode.childIds || []).flatMap(child => walk(child, id || parentId));
        if (!id) return childIds;
        const previous = index.get(id);
        const entry = { id, parentId, childIds, raw: rawNode, role, name, description, text: role === "StaticText" ? name : "", value: protectedNode(rawNode) ? null : rawNode.value?.value == null ? null : axValue(rawNode.value), target, backendNodeId: rawNode.backendDOMNodeId, resources: previous?.resources || [] };
        next.set(id, entry);
        return [id];
      };
      const rawRoots = (response.nodes || []).filter(node => !node.parentId || !raw.has(node.parentId));
      for (const root of rawRoots) nextRoots.push(...walk(root.nodeId, null));
    }
    await host.check(session, false);
    if (session.pageVersion !== version) throw browserError("PAGE_CHANGED", "The page navigated while observing. Request a fresh observation.");
    // A later frame read can overlap navigation of an earlier frame. Never
    // reinstall entries invalidated while CDP was reading the snapshot.
    for (const [id, entry] of next) if (!liveTarget(entry.target)) next.delete(id);
    index = next; roots = nextRoots.filter(id => next.has(id)); indexedVersion = version;
    pruneReferences();
    // A frame navigation event may have advanced revision during the read.
    session.observedRevision = revision;
    host.trace?.event("page.axCounts", { frameCount: frameTargets.length, rawNodes, indexedNodes: index.size });
    return metadata();
  }
  const refresh = () => host.trace ? host.trace.span("page.axRefresh", refreshNative) : refreshNative();
  async function requireNode(id, requireDom = true) {
    await host.check(session, false);
    if (!String(id).startsWith(`n_${session.pageVersion}_`) || indexedVersion !== session.pageVersion) throw browserError("PAGE_CHANGED", "This node belongs to an earlier page. Observe the current page first.");
    const entry = index.get(id);
    if (!entry) throw browserError("STALE_NODE", "This browser node is no longer in the live tree. Re-observe its parent.");
    if (!entry.backendNodeId && !requireDom) return entry;
    if (!entry.backendNodeId) throw browserError("STALE_NODE", "This AX node has no actionable DOM backing; expand its parent or use its accessible text.");
    let result;
    try { result = await command("Accessibility.getPartialAXTree", { backendNodeId: entry.backendNodeId, fetchRelatives: false }, entry.target); }
    catch { throw browserError("STALE_NODE", "The underlying DOM node disappeared. Re-observe the page."); }
    const current = result.nodes?.find(node => node.backendDOMNodeId === entry.backendNodeId && !node.ignored);
    if (index.get(id) !== entry || !liveTarget(entry.target)) throw browserError("STALE_NODE", "The selected frame changed during validation. Observe that frame again.");
    if (!current || nodeSignature(current) !== nodeSignature(entry.raw)) throw browserError("STALE_NODE", "The element changed after observation. Re-observe before acting.");
    return entry;
  }
  async function withElement(entry, fn, args = []) {
    const resolved = await command("DOM.resolveNode", { backendNodeId: entry.backendNodeId, objectGroup: "researchtube-browser" }, entry.target);
    const objectId = resolved.object?.objectId;
    if (!objectId) throw browserError("STALE_NODE", "The element no longer exists.");
    try {
      const result = await command("Runtime.callFunctionOn", { objectId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true }, entry.target);
      if (result.exceptionDetails) throw browserError("BROWSER_UNAVAILABLE", "The page could not provide the requested DOM resource or operation.");
      return result.result?.value;
    } finally { await command("Runtime.releaseObject", { objectId }, entry.target).catch(() => {}); }
  }
  function register(entry, list) {
    const previous = entry.resources.map(item => item.resourceId);
    entry.resources = list.map(item => {
      const key = `${entry.id}:${item.kind}:${item.url || item.rendering || "element"}`;
      if (!resourceKeys.has(key)) resourceKeys.set(key, `r_${session.pageVersion}_${++resourceCounter}`);
      const resourceId = resourceKeys.get(key);
      resources.set(resourceId, { ...item, resourceId, entry, pageVersion: session.pageVersion });
      return { resourceId, kind: item.kind, label: entry.name.slice(0, 200) || `${item.kind} resource` };
    });
    for (const id of previous) if (!entry.resources.some(item => item.resourceId === id)) resources.delete(id);
    for (const [key, id] of resourceKeys) if (!resources.has(id)) resourceKeys.delete(key);
    return entry.resources;
  }
  async function enrich(entry) {
    if (!entry.backendNodeId) return { tag: null, attributes: [], bounds: null, resources: [] };
    const dom = await withElement(entry, inspectBrowserElement);
    if (!dom) throw browserError("STALE_NODE", "The element was removed.");
    if (index.get(entry.id) !== entry || !liveTarget(entry.target)) throw browserError("STALE_NODE", "The selected frame changed during resource inspection.");
    const list = dom.resources.length ? dom.resources : entry.role === "image" ? [{ kind: "image", url: null, rendering: "element" }] : [];
    return { tag: dom.tag, attributes: dom.attributes, bounds: dom.bounds, resources: register(entry, list) };
  }
  function project(entry, textLimit = 500) {
    const states = (entry.raw.properties || []).filter(item => ["disabled", "expanded", "checked", "selected", "focused", "focusable", "editable", "settable", "required", "readonly", "busy", "level", "multiselectable", "multiline", "hasPopup", "invalid", "modal", "orientation", "valuemin", "valuemax", "valuetext"].includes(item.name)).map(item => `${item.name}:${axValue(item.value)}`);
    const relationships = (entry.raw.properties || []).filter(item => ["labelledby", "describedby", "controls", "owns", "details", "flowto"].includes(item.name)).map(item => ({ type: item.name, nodeIds: (item.value?.relatedNodes || []).map(related => [...index.values()].find(other => other.target.sessionId === entry.target.sessionId && other.backendNodeId === related.backendDOMNodeId)?.id).filter(Boolean) }));
    const name = entry.name.slice(0, textLimit), text = entry.text === entry.name ? "" : entry.text.slice(0, textLimit);
    const childCap = Math.min(limits.maxNodes, Math.max(1, Math.floor(limits.maxChars / 40)));
    return { nodeId: entry.id, parentId: entry.parentId, childIds: entry.childIds.slice(0, childCap), role: entry.role, name, description: entry.description.slice(0, textLimit), text, relationships: relationships.map(item => ({ ...item, nodeIds: item.nodeIds.slice(0, childCap) })), value: entry.value?.slice(0, textLimit) ?? null, states, childCount: entry.childIds.length, truncated: entry.childIds.length > childCap || relationships.some(item => item.nodeIds.length > childCap) || entry.description.length > textLimit || entry.name.length > textLimit || entry.text.length > textLimit || (entry.value?.length || 0) > textLimit, resources: entry.resources };
  }
  function compactProject(entry, textLimit) {
    const node = project(entry, textLimit);
    for (const name of ["description", "text", "relationships", "states", "value"]) if (node[name] == null || node[name].length === 0) delete node[name];
    return node;
  }
  function snapshot() {
    return { version: session.pageVersion, nodes: new Map([...index].map(([id, entry]) => [id, JSON.stringify([nodeSignature(entry.raw), entry.description, entry.parentId, entry.childIds, entry.resources])])), resources: new Set(resources.keys()) };
  }
  function difference(previous) {
    const current = snapshot();
    const added = [...current.nodes.keys()].filter(id => !previous.nodes.has(id));
    const updated = [...current.nodes.keys()].filter(id => previous.nodes.has(id) && previous.nodes.get(id) !== current.nodes.get(id));
    const removed = [...previous.nodes.keys()].filter(id => !current.nodes.has(id));
    const addedResources = [...current.resources].filter(id => !previous.resources.has(id));
    const removedResources = [...previous.resources].filter(id => !current.resources.has(id));
    const cap = limits.maxNodes;
    const changes = { pageChanged: previous.version !== current.version, addedNodeIds: added.slice(0, cap), updatedNodeIds: updated.slice(0, cap), removedNodeIds: removed.slice(0, cap), addedResourceIds: addedResources.slice(0, cap), removedResourceIds: removedResources.slice(0, cap), addedNodes: added.length, updatedNodes: updated.length, removedNodes: removed.length, addedResources: addedResources.length, removedResources: removedResources.length, truncated: [added, updated, removed, addedResources, removedResources].some(list => list.length > cap) };
    host.trace?.event("page.changes", { addedNodes: added.length, updatedNodes: updated.length, removedNodes: removed.length, addedResources: addedResources.length, removedResources: removedResources.length });
    return { current, changes, entries: [...added, ...updated].map(id => index.get(id)) };
  }
  async function enrichMedia(entries) {
    for (const entry of entries) if (RESOURCE_ROLES.has(entry.role)) await enrich(entry).catch(error => { if (error.code === "STALE_NODE") { for (const item of entry.resources) resources.delete(item.resourceId); entry.resources = []; } });
  }
  function serialize(entries, input = {}, changes) {
    const offset = input.offset ?? 0, maxNodes = Math.min(input.maxNodes ?? limits.maxNodes, limits.maxNodes), maxChars = Math.min(input.maxChars ?? limits.maxChars, limits.maxChars);
    let chars = 2;
    const nodes = [];
    for (const entry of entries.slice(offset, offset + maxNodes)) {
      let projected = compactProject(entry, 2000);
      let cost = JSON.stringify(projected).length + (nodes.length ? 1 : 0);
      if (cost + chars > maxChars) {
        // Preserve a useful partial long text instead of dropping its entire node.
        let low = 0, high = 2000;
        while (low < high) { const middle = Math.ceil((low + high) / 2); if (JSON.stringify(compactProject(entry, middle)).length + chars + (nodes.length ? 1 : 0) <= maxChars) low = middle; else high = middle - 1; }
        projected = compactProject(entry, low); cost = JSON.stringify(projected).length + (nodes.length ? 1 : 0);
        if (cost + chars > maxChars) break;
      }
      nodes.push(projected); chars += cost;
      if (nodes.length && chars >= maxChars) break;
    }
    if (entries.length > offset && !nodes.length) throw browserError("BROWSER_INVALID", "The observation character budget is too small for the selected node structure. Increase browserStudyMaxChars or maxChars.");
    const nextOffset = offset + nodes.length < entries.length ? offset + nodes.length : null;
    return { sessionId: session.sessionId, page: metadata(), roots: roots.slice(0, limits.maxNodes), nodes, truncated: nextOffset !== null, nextOffset, totalNodes: entries.length, changes };
  }
  async function observe(input = {}) {
    if (input.nodeId) await requireNode(input.nodeId, false);
    await refresh();
    const base = input.nodeId ? [input.nodeId] : roots;
    if (input.nodeId && !index.has(input.nodeId)) throw browserError("STALE_NODE", "The requested node disappeared during refresh.");
    const mode = input.mode || "full";
    const depth = input.depth ?? (mode === "full" ? 20 : 3);
    const entries = [];
    const walk = (id, level) => { const entry = index.get(id); if (!entry) return; entries.push(entry); if (level < depth) for (const child of entry.childIds) walk(child, level + 1); };
    for (const root of base) walk(root, 0);
    const finish = host.trace?.begin("page.projectAndEnrich", { mode });
    await enrichMedia(entries.slice(input.offset ?? 0, (input.offset ?? 0) + Math.min(input.maxNodes ?? limits.maxNodes, limits.maxNodes)));
    await host.check(session, false);
    if (indexedVersion !== session.pageVersion) throw browserError("PAGE_CHANGED", "The page navigated during observation. Read the current page again.");
    const delta = difference(reported);
    const result = serialize(entries.filter(entry => index.get(entry.id) === entry), input, delta.changes);
    result.roots = base.slice(0, limits.maxNodes);
    reported = delta.current;
    finish?.({ outcome: "ok", returnedNodes: result.nodes.length, totalNodes: entries.length, characters: JSON.stringify(result.nodes).length });
    return result;
  }
  async function getNode(id) { const entry = await requireNode(id, false); const dom = await enrich(entry); return { sessionId: session.sessionId, page: metadata(), node: project(entry, 2000), dom }; }
  async function getText(id, offset = 0, limit = 12000) {
    await requireNode(id, false); await refresh();
    const entry = index.get(id); if (!entry) throw browserError("STALE_NODE", "The requested text node was removed.");
    const parts = [];
    const walk = current => { if (!current || protectedNode(current.raw)) return; if (current.role === "StaticText") parts.push(current.name); else { if (current.value) parts.push(current.value); if (!current.childIds.length && current.name) parts.push(current.name); } for (const child of current.childIds) walk(index.get(child)); };
    walk(entry);
    const text = parts.join("\n");
    return { sessionId: session.sessionId, page: metadata(), nodeId: id, text: text.slice(offset, offset + limit), totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null };
  }
  async function point(entry) {
    await command("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }, entry.target);
    let model;
    try { model = (await command("DOM.getBoxModel", { backendNodeId: entry.backendNodeId }, entry.target)).model; }
    catch { throw browserError("STALE_NODE", "The element has no visible layout box."); }
    const quad = model.content;
    return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
  }
  async function key(keyText, target = {}) {
    const pieces = keyText.split("+"); const name = pieces.pop();
    const modifiers = pieces.reduce((mask, part) => mask | ({ Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Shift: 8 }[part] || 0), 0);
    if (pieces.some(part => !["Alt", "Ctrl", "Control", "Meta", "Shift"].includes(part))) throw browserError("BROWSER_INVALID", "Unsupported key modifier.");
    const codes = { Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46], Space: ["Space", 32], ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40], Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34] };
    const pair = codes[name] || (/^[A-Za-z0-9]$/.test(name) ? [/\d/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)] : null);
    if (!pair) throw browserError("BROWSER_INVALID", "Use a named navigation key or a Ctrl/Alt/Shift/Meta combination with one letter or digit.");
    const params = { key: name === "Space" ? " " : name, code: pair[0], windowsVirtualKeyCode: pair[1], nativeVirtualKeyCode: pair[1], modifiers };
    const text = modifiers & (1 | 2 | 4) ? null : name === "Enter" ? "\r" : name === "Space" ? " " : /^[A-Za-z0-9]$/.test(name) ? name : null;
    await host.check(session, true); await command("Input.dispatchKeyEvent", { ...params, type: text === null ? "rawKeyDown" : "keyDown", ...(text === null ? {} : { text }) }, target);
    await command("Input.dispatchKeyEvent", { ...params, type: "keyUp" }, target);
  }
  async function act(input) {
    await host.check(session, true);
    const entry = input.nodeId ? await requireNode(input.nodeId) : null;
    if (entry && entry.raw.properties?.some(item => item.name === "disabled" && item.value?.value === true)) throw browserError("BROWSER_INVALID", "The requested element is disabled.");
    const target = entry?.target || {};
    if (["click", "hover"].includes(input.action)) {
      const coordinates = await point(entry);
      await host.check(session, true);
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...coordinates }, target);
      if (input.action === "click") {
        const reachable = await withElement(entry, function () { const element = this.nodeType === 1 ? this : this.parentElement; if (!element) return false; const rect = element.getBoundingClientRect(); const hit = element.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return Boolean(hit && (hit === element || element.contains(hit))); });
        if (!reachable) throw browserError("BROWSER_ELEMENT_OBSCURED", "The element is covered or outside its frame viewport. Observe/scroll before clicking; no mouse press was sent.");
        await host.check(session, true);
        await requireNode(entry.id);
        await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...coordinates }, target);
        await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...coordinates }, target);
      }
    } else if (input.action === "type") {
      const dom = await withElement(entry, inspectBrowserElement);
      if (!dom?.editable || dom.password || protectedNode(entry.raw)) throw browserError("BROWSER_INVALID", "Type requires a non-password editable element.");
      await command("DOM.focus", { backendNodeId: entry.backendNodeId }, target);
      await key("Ctrl+A", target); await key("Backspace", target);
      await host.check(session, true); await command("Input.insertText", { text: input.text }, target);
      const actual = await withElement(entry, function () { return this.isContentEditable ? this.innerText : this.value; });
      if (String(actual).replace(/\r\n/g, "\n") !== input.text.replace(/\r\n/g, "\n")) throw browserError("BROWSER_INVALID", "The editable field transformed the requested text. Observe its actual value before continuing.");
    } else if (input.action === "key") {
      if (entry) await command("DOM.focus", { backendNodeId: entry.backendNodeId }, target);
      await key(input.key, target);
    } else if (input.action === "select") {
      await host.check(session, true);
      const selected = await withElement(entry, function (value) { if (this.tagName !== "SELECT" || this.disabled) return false; const option = [...this.options].find(option => !option.disabled && (option.value === value || option.textContent.trim() === value)); if (!option) return false; this.value = option.value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return true; }, [input.value]);
      if (!selected) throw browserError("BROWSER_INVALID", "Select requires an enabled native SELECT option; use click/observe for custom lists.");
    } else if (input.action === "scroll") {
      const viewport = (await command("Page.getLayoutMetrics", {}, target)).cssVisualViewport;
      const coordinates = entry ? await point(entry) : { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
      const amount = input.amount ?? 600, direction = input.direction ?? "down";
      await host.check(session, true);
      await command("Input.dispatchMouseEvent", { type: "mouseWheel", ...coordinates, deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0, deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0 }, target);
    }
    session.revision += 1;
    // Return the useful local difference with this action, avoiding another
    // model/tool round trip merely to discover a new panel or image.
    try {
      await refresh();
      // Bound DOM work too: inspect new media and previously referenced media,
      // rather than synchronously enriching thousands of off-page images.
      const media = [...index.values()].filter(entry => RESOURCE_ROLES.has(entry.role) && (entry.resources.length || !reported.nodes.has(entry.id)));
      await enrichMedia(media.slice(0, limits.maxNodes)); await host.check(session, false);
      if (indexedVersion !== session.pageVersion) throw browserError("PAGE_CHANGED", "The page navigated during the post-action read.");
      const delta = difference(reported);
      const observation = serialize(delta.entries, {}, delta.changes);
      reported = delta.current;
      return { sessionId: session.sessionId, action: input.action, page: metadata(), observeAgain: session.observedRevision !== session.revision || observation.truncated || delta.changes.truncated, observation, observationError: null };
    } catch (error) {
      // Input has already been dispatched. A loading/context failure must not
      // present the action as failed and invite a duplicate click or submission.
      return { sessionId: session.sessionId, action: input.action, page: metadata(), observeAgain: true, observation: null, observationError: { code: error.code || "BROWSER_UNAVAILABLE", message: "The action was dispatched, but its page update is not readable yet. Observe again; do not repeat the action solely for this read failure." } };
    }
  }
  function getResource(id) {
    const item = resources.get(id);
    if (!String(id).startsWith(`r_${session.pageVersion}_`) || item && item.pageVersion !== session.pageVersion) throw browserError("PAGE_CHANGED", "The resource belongs to an earlier page. Observe the current page and select a new resource.");
    if (!item) throw browserError("BROWSER_RESOURCE_NOT_FOUND", "Observe or inspect the resource node before requesting it.");
    return item;
  }
  let actionQueue = Promise.resolve();
  const actSerial = input => { const result = actionQueue.then(() => act(input)); actionQueue = result.then(() => {}, () => {}); return result; };
  return { refresh, observe, getNode, getText, act: actSerial, getResource, requireNode, withElement, command, enrich, metadata, invalidate, invalidateFrame, point };
}
