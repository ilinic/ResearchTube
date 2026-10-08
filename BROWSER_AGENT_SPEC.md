# ResearchTube Browser Agent — Technical Specification

## 1. Goal

Add a generic **Study Page** capability to ResearchTube so ChatGPT can inspect and interact with any page already open in the user's normal Chrome profile, including authenticated sites such as Facebook Marketplace, Mumsnet, Quora, forums, shops, web applications, and ChatGPT itself.

The implementation must be **site-agnostic**. The generic core must not require Facebook-, Quora-, Mumsnet-, YouTube-, or other site-specific adapters.

The browser is the authoritative source of state. The user may inspect, modify, navigate, pause, stop, or close any involved tab at any time.

The architecture has two channels:

1. **Semantic/control channel** — compact page structure and browser actions are exchanged through MCP.
2. **Visual/media channel** — actual page images or other media are extracted from the page and inserted into the dedicated ChatGPT conversation as real attachments when the model needs them.

---

## 2. User experience

### 2.1 Study Page start

The ResearchTube extension exposes a **Study Page** action for an ordinary Chrome tab.

When Study Page is invoked on source tab S:

1. Leave S untouched and fully under user control.
2. Duplicate S into a new ordinary visible Chrome tab A.
3. Create/open a new ordinary visible ChatGPT tab C for this task.
4. Create an internal BrowserSession linking A and C.
5. Add a small ResearchTube automation overlay to A.
6. Start the ChatGPT study workflow in C.

Conceptually:

~~~text
SOURCE TAB S              AGENT TAB A               CHATGPT TAB C
user-owned                browser workspace         model workspace

Facebook listing --dup--> Facebook listing <------> ChatGPT
                              ^       |
                              |       |
                           AX/DOM   actions
~~~

The source tab is never taken over by the automation.

### 2.2 No hidden browser

Agent and ChatGPT tabs are normal visible Chrome tabs.

ResearchTube must not require:

- hidden tabs;
- pinned tabs;
- tab groups;
- a separate browser profile;
- a separate automated Chromium instance.

The tabs may be inactive/background tabs when the user is looking elsewhere, but they remain ordinary tabs the user can inspect at any time.

### 2.3 User remains in control

At any time the user may:

- activate either tab;
- navigate manually;
- click controls;
- type into the page;
- close the tab;
- pause automation;
- stop automation;
- start another Study Page action from any tab, including a tab already involved in another BrowserSession.

These are normal supported events, not misuse.

---

## 3. BrowserSession model

BrowserSession is an internal routing/lifecycle object. Its identifier is not a user-facing concept.

Suggested minimum state:

~~~ts
interface BrowserSession {
  id: string;                  // internal only
  originTabId?: number;        // where Study Page was invoked
  agentTabId: number;          // duplicated page controlled by this session
  chatTabId: number;           // ChatGPT conversation used by this session
  state: 'starting' | 'running' | 'paused' | 'stopped' | 'failed';
  createdAt: string;
}
~~~

Additional implementation metadata may be stored as needed.

### 3.1 One-controller rule

The one hard ownership rule is:

> One physical Chrome tab may be directly controlled by at most one active BrowserSession.

This prevents conflicting automation commands against the same tab.

This rule does **not** prevent Study Page from being invoked on a controlled tab. Study Page first duplicates that tab and the new BrowserSession controls the duplicate.

Example:

~~~text
Session A controls tab 20.
User invokes Study Page on tab 20.
Chrome duplicates tab 20 -> tab 34.
Session B controls tab 34.
Session A continues controlling tab 20.
~~~

### 3.2 Cascades are allowed

ResearchTube must not impose artificial restrictions on recursive/cascading Study Page use.

The user may invoke Study Page on:

- a normal web tab;
- an agent tab;
- a ChatGPT tab created by another session;
- a duplicate of any of the above.

Arbitrary chains are acceptable:

~~~text
Facebook
  -> ChatGPT A
       -> ChatGPT B
            -> another site
                 -> ChatGPT C
~~~

Each BrowserSession remains independent because it owns different physical tab IDs.

Do not attempt to protect the user from creating many tabs or complicated relationships. ResearchTube's responsibility is correct routing and lifecycle handling, not tab-count policy.

---

## 4. Automation overlay

Every agent-controlled page tab displays a small unobtrusive extension overlay.

Suggested UI:

~~~text
+----------------------------------+
| ResearchTube automation  ●       |
| [ Pause ]   [ Stop ]             |
+----------------------------------+
~~~

Requirements:

- show only meaningful user state;
- do not show BrowserSession IDs;
- do not show internal tab IDs;
- Pause stops new automated page actions while retaining the session;
- Resume continues from the page's current real state;
- Stop terminates session automation;
- the overlay must not imply that the user is forbidden from interacting with the page.

The overlay is informational/control UI, not an ownership lock.

---

## 5. Semantic page representation

### 5.1 Accessibility Tree is the primary source

Use Chrome DevTools Protocol Accessibility as the primary representation of page structure.

ResearchTube should rely on Chrome to compute semantics such as:

- role;
- accessible name;
- description;
- value;
- hierarchy;
- focusability;
- editability;
- selected/checked state;
- expanded/collapsed state;
- disabled/read-only state;
- heading levels;
- semantic relationships.

Relevant CDP methods include:

- Accessibility.enable
- Accessibility.getRootAXNode
- Accessibility.getFullAXTree
- Accessibility.getChildAXNodes
- Accessibility.getAXNodeAndAncestors
- Accessibility.getPartialAXTree
- Accessibility.queryAXTree

Relevant events include:

- Accessibility.loadComplete
- Accessibility.nodesUpdated

ResearchTube must not initially attempt to reimplement browser accessibility semantics from raw HTML.

### 5.2 Preserve tree structure

The internal model remains tree-shaped.

Example:

~~~text
document
  navigation "Main navigation"
    link "Home"
    link "Marketplace"
  main
    heading "Mini excavator for sale"
    article
      text "$18,500"
      image "Excavator photo"
      button "Show more" expanded=false
~~~

A compact indented textual representation may be sent through MCP, but it is only a serialization of a semantic tree, not a fundamentally flat page model.

### 5.3 Minimal normalizer

Implement a deliberately small serializer/normalizer rather than a complex custom page-understanding layer.

Initial rules should be mechanical:

- omit ignored AX nodes;
- collapse empty/redundant generic wrappers where hierarchy is not lost;
- avoid duplicating accessible names as redundant child text;
- omit verbose CDP metadata that does not help the model;
- retain addressable node IDs;
- defer very large text blocks instead of dropping them;
- retain semantically important containers and controls.

Example:

~~~text
[10] main
  [11] heading "Relationships"
  [20] article
    [21] heading "My husband wants a divorce"
    [22] text length=9847 "I've been married for eighteen years..."
    [23] button "Show more" expanded=false
    [30] group "Replies" children=151
~~~

### 5.4 Lazy exploration

Do not send a full large page to ChatGPT unless required.

Preferred interaction:

1. Return a root/outline view.
2. Let the model request children/subtrees.
3. Return full long text only when requested.
4. Return changed subtrees/deltas after actions when practical.

This reduces token use without lossy summarization.

Content that is not sent immediately remains addressable through node/resource IDs.

### 5.5 DOM is the secondary source

Accessibility Tree is not sufficient for every task. Add a bridge from AX nodes to DOM nodes using backend DOM node identifiers where available.

Use DOM/DOMSnapshot as needed for:

- href;
- src/currentSrc;
- element attributes;
- form details not represented adequately in AX;
- layout/geometry;
- CSS background images;
- Shadow DOM/iframe investigation;
- poorly accessible custom controls;
- resolving a semantic node into the actual page resource.

DOMSnapshot.captureSnapshot may be used when broader DOM/layout data is required, but raw DOM is not the default representation sent to ChatGPT.

### 5.6 Browser state is authoritative

Never assume the page still matches the agent's previous plan.

The page can change because of:

- ChatGPT actions;
- user actions;
- site JavaScript;
- navigation;
- timers/live updates;
- network results;
- server-side state changes.

When the user changes the agent tab manually, the next observation simply reflects the new state.

---

## 6. Browser actions

Expose a small generic action vocabulary rather than site-specific commands.

Suggested MCP surface:

- site_read
- site_get_children
- site_get_node
- site_get_text
- site_get_files
- site_interact

Suggested site_interact payloads:

~~~json
{ "action": "click",  "nodeId": "23" }
{ "action": "type",   "nodeId": "7", "text": "mini excavator" }
{ "action": "key",    "key": "Enter" }
{ "action": "scroll", "direction": "down", "amount": 0.8 }
{ "action": "select", "nodeId": "55", "value": "Used" }
{ "action": "hover",  "nodeId": "72" }
~~~

Prefer stable node-based operations through DOM/CDP/Input.

Runtime.evaluate may exist as an internal fallback/debug mechanism, but arbitrary model-generated JavaScript must not be the primary browser-control contract.

### 6.1 Dynamic content

The agent must be able to interact with controls that reveal/load additional content.

Example:

~~~text
[37] button "Show 48 more replies" expanded=false
~~~

The model clicks node 37, waits for a page change, then receives updated semantic state.

This must work generically for accordions, disclosure controls, lazy loading, search forms, pagination, infinite scrolling, dialogs, menus, sliders, etc.

---

## 7. Images and visual content

### 7.1 Do not rasterize structured information

Screenshots are not the default page representation.

For ordinary UI:

~~~text
Accessibility/DOM -> semantic MCP data
~~~

For real images:

~~~text
page image resource -> original image bytes -> ChatGPT attachment
~~~

Vision is used for genuinely visual content, not to rediscover text/buttons already known to the browser.

### 7.2 Prefer original resources

When a page image is needed, resolve the actual resource whenever possible.

Preferred order:

1. actual img/currentSrc resource;
2. CSS background-image resource;
3. selected picture/source resource;
4. blob/data resource resolved in page context;
5. rendered SVG/canvas extraction;
6. screenshot/crop of the specific element;
7. viewport screenshot only as a last fallback.

Full-page screenshots are not part of the normal path.

### 7.3 Resource handles

Do not expose huge temporary CDN URLs to the model as the primary handle.

Assign compact resource IDs:

~~~text
[71] image resource=img_71
[72] image resource=img_72
[73] image resource=img_73
~~~

ResearchTube internally maps each resource ID to DOM/network/resource information.

### 7.4 Delivery to ChatGPT

Do not assume that a local/private URL or an MCP image result automatically becomes reliable ChatGPT vision input.

The primary Browser Agent visual path is:

~~~text
agent page
  -> extract original image bytes
  -> create temporary/Workspace file
  -> automate the dedicated ChatGPT tab
  -> attach the file as a real ChatGPT attachment
  -> send/continue the browser task
~~~

The user does not manually attach files.

The destination is always the stored chatTabId, never whichever Chrome tab happens to be active.

### 7.5 Page-level permission, model-driven selection

Invoking Study Page authorizes the agent to work with the content of that selected page/session.

Do not ask the user for permission for each individual page image.

However, do not attach every image merely because it exists. This is an efficiency rule, not a privacy restriction.

A page may contain hundreds of irrelevant assets such as logos, icons, avatars, advertisements, emoji, or tracking pixels.

Normal behavior:

1. semantic model tells ChatGPT which meaningful images/resources exist;
2. ChatGPT requests the subset relevant to the task;
3. ResearchTube attaches them automatically.

For image-centric pages/listings it is valid for ChatGPT to request many or all meaningful content photos.

### 7.6 Mid-task continuation

If ChatGPT decides during an active task that it needs an image, attaching that image may require a new ChatGPT turn.

Supported flow:

~~~text
model requests img_73
-> ResearchTube extracts img_73
-> ResearchTube attaches it to chatTabId
-> ResearchTube sends a minimal continuation message
-> next model turn continues the same BrowserSession
~~~

Example continuation message:

~~~text
Requested browser resource img_73 attached. Continue the current Study Page task.
~~~

No user interaction is required for this continuation.

---

## 8. ChatGPT tab

Each Study Page start creates a normal visible ChatGPT tab for that BrowserSession.

It is dedicated only in the routing sense: the session remembers its tab ID.

It is not hidden, pinned, locked, grouped, or protected from the user.

The user may enter the ChatGPT tab, read it, interact with it, or invoke Study Page from it.

If Study Page is invoked from that ChatGPT tab, ResearchTube duplicates it and starts another independent BrowserSession.

All automated ChatGPT operations must use the stored chatTabId and verify the expected conversation/composer context before changing the composer.

Never route attachments/messages based only on the active/focused browser tab.

---

## 9. Lifecycle and interruption

User interruption is a first-class supported state transition.

### 9.1 Agent tab closed

If agentTabId is closed:

- stop that BrowserSession;
- cancel pending actions;
- release debugger ownership;
- clean session-owned temporary work where safe;
- do not recreate the tab automatically.

Closing the agent tab is a valid way to end automation.

### 9.2 ChatGPT tab closed

If chatTabId is closed:

- stop that BrowserSession;
- do not silently create a replacement ChatGPT tab;
- leave unrelated tabs untouched.

### 9.3 Origin tab closed

After BrowserSession startup succeeds, closing the original source tab does not stop the session. The agent operates on its duplicate.

### 9.4 Manual navigation in agent tab

If the user manually navigates the agent tab:

- do not treat this as corruption;
- invalidate stale node/page assumptions;
- re-observe the real state;
- let ChatGPT continue from the new state if the session remains running.

### 9.5 Pause

While paused:

- do not issue new automated browser actions;
- user interaction remains unrestricted;
- on resume, observe the current page before acting again.

### 9.6 Stop

Stop means:

- no further automated page actions;
- no further automatic attachments/messages for the session;
- release debugger/control ownership;
- remove/disable the automation overlay;
- clean temporary session resources when safe.

Stopping does not have to close either visible tab. The user may keep them.

### 9.7 Restart

The first implementation may treat Chrome/extension/agent restart as terminating active sessions.

Do not implement invisible automatic recovery until it is explicitly designed.

---

## 10. Concurrency

ResearchTube must support multiple BrowserSessions concurrently.

Requirements:

- each session routes to its own agentTabId and chatTabId;
- commands are never routed by focus/active-window state;
- temporary resources are session-addressable;
- one physical tab cannot have two automation controllers;
- user interaction with all tabs remains allowed;
- no arbitrary global session limit is required at the architecture level.

Technical resource limits may exist, but they must be explicit implementation limits rather than conceptual restrictions on session topology.

---

## 11. Authentication

Use the user's existing normal Chrome session.

Do not require exporting cookies or account credentials to ChatGPT/MCP.

For an authenticated site:

~~~text
user logs in normally in Chrome
-> Study Page duplicates the tab in the same profile
-> agent operates through the already-authenticated browser context
~~~

Cookies, tokens, local storage, and other authentication state remain browser-managed.

The semantic MCP layer exposes page content/actions, not raw credentials.

---

## 12. Non-goals for the first implementation

The initial Browser Agent does not require:

- site-specific adapters;
- a custom browser rendering engine;
- a custom accessibility engine;
- image OCR when semantic text already exists;
- full-page screenshot navigation;
- hidden automation tabs;
- a separate user profile;
- tab groups;
- user-facing session identifiers;
- per-image confirmation prompts;
- prevention of recursive Study Page cascades;
- arbitrary model-generated JavaScript as the normal control mechanism.

---

## 13. Suggested implementation layers

~~~text
+---------------------------------------------------------+
| ChatGPT Browser Agent                                  |
| - reasoning                                            |
| - chooses semantic nodes/actions                       |
| - asks for visual resources when needed                |
+-------------------------+-------------------------------+
                          |
                     MCP semantic/control
                          |
+-------------------------v-------------------------------+
| ResearchTube Local Agent / MCP                         |
| - BrowserSession routing                               |
| - compact semantic protocol                            |
| - resource/task bookkeeping                            |
| - continuation coordination                            |
+-------------------------+-------------------------------+
                          |
                Extension <-> Agent channel
                          |
+-------------------------v-------------------------------+
| ResearchTube Chrome Extension                          |
| - chrome.tabs.duplicate                                |
| - tab lifecycle events                                 |
| - chrome.debugger / CDP                                |
| - AX/DOM bridge                                        |
| - browser actions                                      |
| - overlay                                              |
| - page resource extraction                             |
| - ChatGPT attachment automation                        |
+-----------+-------------------------------+-------------+
            |                               |
       agentTabId                       chatTabId
            |                               |
+-----------v-----------+          +--------v-------------+
| Any authenticated web |          | ChatGPT conversation |
| page in normal Chrome |          | for this study task  |
+-----------------------+          +----------------------+
~~~

---

## 14. Suggested MCP contract

Exact names are provisional and should be aligned with existing ResearchTube naming conventions.

### site_read

Obtain the current semantic page view.

Possible parameters:

~~~ts
{
  mode?: 'outline' | 'subtree' | 'full';
  nodeId?: string;
  depth?: number;
}
~~~

### site_get_children

Lazy expansion of one semantic node.

~~~ts
{
  nodeId: string;
  depth?: number;
}
~~~

### site_get_text

Return deferred full text for a long text-bearing node.

~~~ts
{
  nodeId: string;
}
~~~

### site_get_files

Resolve a page resource through a compact resource ID.

~~~ts
{
  resourceId: string;
}
~~~

For image resources, this may initiate the attachment/continuation workflow rather than return base64 to the model.

### site_interact

Generic page interaction.

~~~ts
{
  action: 'click' | 'type' | 'key' | 'scroll' | 'hover' | 'select';
  nodeId?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  value?: string;
}
~~~

### Optional session tools

Study Page itself creates BrowserSession automatically. If low-level tools are needed internally, keep them small:

- site_session_status
- site_session_pause
- site_session_resume
- site_session_stop

The user-facing controls remain ordinary Chrome tabs plus the overlay.

---

## 15. Page change tracking

Use Accessibility/DOM events where practical to avoid retransmitting entire pages.

Example:

~~~text
before:
[23] button "Show more" expanded=false

site_interact(click, 23)

change:
UPDATED [23] expanded=true
ADDED under [20]: [301], [302], [303] ...
~~~

Correctness is more important than premature delta optimization.

If event-based tracking is unreliable for a page, fall back to a fresh subtree/outline observation rather than keeping stale state.

---

## 16. Side effects

A generic browser cannot perfectly distinguish read-only from mutating interactions.

A click can reveal text, submit a form, send a message, like a post, purchase an item, or modify account state.

The architecture must not pretend arbitrary browser control is inherently read-only.

The core technical requirement is transparency and user control:

- automation occurs in a visible tab;
- the overlay clearly indicates active automation;
- Pause and Stop are immediately available;
- the user may inspect or intervene at any time;
- server-side changes are real changes made under the user's authenticated account.

Any later confirmation policy for high-impact actions should be layered above the generic browser mechanism, not encoded as site-specific logic in the Browser Agent core.

---

## 17. Error handling

The Browser Agent must fail locally and predictably.

### Tab closed

Stop the affected session. Never guess another tab.

### Page changed unexpectedly

Invalidate stale nodes and re-observe.

### Node disappeared

Return a stale-node failure and enough current page metadata for ChatGPT to re-observe/reselect.

### Debugger detached

Stop or pause the session. Do not silently control another target.

### ChatGPT attachment target changed

If chatTabId no longer points to the expected conversation/composer context, fail rather than attaching to an arbitrary ChatGPT tab.

### Resource unavailable

If original media cannot be resolved:

1. try supported alternative extraction paths;
2. if appropriate, capture only the relevant element;
3. report the fallback/failure explicitly.

---

## 18. MVP sequence

### Phase 1 — Accessibility inspection

Implement a diagnostic path:

- attach through chrome.debugger;
- enable the Accessibility domain;
- return a compact indented AX tree;
- retain addressable node IDs.

Test on:

- YouTube;
- Facebook Marketplace;
- Mumsnet;
- Quora;
- Reddit;
- a normal shop;
- a complex React SPA;
- ChatGPT itself.

The purpose is to discover how much useful semantics Chrome already provides before adding custom normalization.

### Phase 2 — Generic interaction

Add:

- node lookup;
- click;
- type;
- keyboard events;
- scrolling;
- re-observation after changes;
- overlay Pause/Stop.

### Phase 3 — Study Page lifecycle

Add:

- duplicate source tab;
- create dedicated ChatGPT tab;
- BrowserSession routing;
- tab-close/navigation handling;
- concurrent sessions;
- recursive Study Page behavior.

### Phase 4 — DOM/resource bridge

Add:

- AX -> backend DOM mapping;
- href/src/currentSrc extraction;
- image resource IDs;
- CSS/background-image handling;
- fallback element rendering/capture.

### Phase 5 — Automatic visual delivery

Add:

- resource extraction to Workspace/temp files;
- targeted attachment to chatTabId;
- automatic continuation message;
- cleanup.

### Phase 6 — Delta optimization

Only after the basic agent is reliable:

- Accessibility.nodesUpdated processing;
- subtree diffing;
- incremental semantic updates;
- context/token efficiency tuning.

---

## 19. Acceptance criteria

The feature is successful when:

1. Study Page can be invoked from an ordinary Chrome page.
2. The original page remains untouched.
3. ResearchTube creates a visible duplicate page tab and visible ChatGPT tab.
4. The agent page displays a small automation overlay with Pause/Stop.
5. ChatGPT can obtain a useful semantic tree without screenshots.
6. ChatGPT can lazily inspect nested page content.
7. ChatGPT can click, type, scroll, select, and navigate generic controls.
8. Dynamic content such as Show more can be opened and inspected.
9. Images are represented as resources rather than automatic screenshots.
10. Requested meaningful images can be extracted and attached automatically to the correct ChatGPT tab.
11. Raw site credentials/cookies do not have to be exported to ChatGPT.
12. Closing the agent or ChatGPT tab cleanly stops the corresponding BrowserSession.
13. Manual user navigation/action in the agent tab does not corrupt the system; ChatGPT can re-observe and continue.
14. Multiple independent BrowserSessions can run concurrently.
15. Study Page invoked from a tab already involved in another session creates a new duplicate/new ChatGPT tab rather than adding a second controller to the same physical tab.
16. No tab groups, hidden tabs, user-facing session IDs, or site-specific adapters are required for normal operation.

---

## 20. Design principles

1. **Use the user's real Chrome session.**
2. **Keep automation visible.**
3. **Never take over the user's original source tab.**
4. **One automation controller per physical tab.**
5. **Allow arbitrary Study Page cascades.**
6. **Accessibility Tree first; DOM second; pixels last.**
7. **Preserve semantic hierarchy.**
8. **Explore lazily instead of dumping the whole page.**
9. **Never rasterize information the browser already knows structurally.**
10. **Use original media resources whenever possible.**
11. **Deliver visual content through real ChatGPT attachments when required.**
12. **Route everything by explicit tab IDs, never by whichever tab is active.**
13. **Treat user intervention as normal behavior.**
14. **Treat current browser state as the source of truth.**
15. **Keep the generic core site-agnostic.**
