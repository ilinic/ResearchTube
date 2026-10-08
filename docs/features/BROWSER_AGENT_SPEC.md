# ResearchTube Browser Agent — Technical Specification

## 1. Purpose

Add a generic **Study Page** capability to ResearchTube that lets ChatGPT inspect and interact with any page already open in the user's normal Chrome profile, including authenticated sites such as Facebook Marketplace, Mumsnet, Quora, forums, shops, web applications, and ChatGPT itself.

The implementation must be **site-agnostic**. The core feature must not require Facebook-, Quora-, Mumsnet-, YouTube-, or other site-specific adapters.

The design has two distinct data channels:

1. **Semantic/control channel** — compact page structure and browser actions are exchanged through MCP.
2. **Heavy visual/media channel** — actual page images or other media are extracted from the browser and inserted into the dedicated ChatGPT conversation as real attachments when the model needs them.

The browser remains the authoritative source of state. The user may inspect, modify, navigate, pause, stop, or close any involved tab at any time.

---

## 2. Core UX

### 2.1 Starting Study Page

The ResearchTube extension exposes a **Study Page** action for any ordinary Chrome tab.

When the user invokes **Study Page** on source tab `S`:

1. Leave `S` untouched and fully under user control.
2. Duplicate `S` into a new ordinary visible Chrome tab `A`.
3. Create/open a new ordinary visible ChatGPT tab `C` for this study task.
4. Create an internal BrowserSession linking `A` and `C`.
5. Add a small ResearchTube automation overlay to `A`.
6. Begin the ChatGPT study workflow in `C`.

Conceptually:

```text
SOURCE TAB S             AGENT TAB A              CHATGPT TAB C
(user-owned)             (browser workspace)      (model workspace)

Facebook listing  --dup-> Facebook listing  <-->  ChatGPT
                             ^      |
                             |      |
                       AX / DOM     actions
```

The source tab is never taken over by the automation.

### 2.2 No hidden tabs

Agent and ChatGPT tabs are normal, visible Chrome tabs.

ResearchTube must not require:

- hidden tabs;
- pinned tabs;
- tab groups;
- a separate browser profile;
- a separate automated Chromium instance.

The tabs may simply be inactive/background tabs when the user is looking elsewhere.

### 2.3 User remains in control

The user may at any time:

- activate either tab;
- navigate manually;
- click controls;
- type into the page;
- close the tab;
- pause automation;
- stop automation;
- start another Study Page action from any tab, including a tab already involved in another BrowserSession.

These are normal supported events, not exceptional misuse.

---

## 3. BrowserSession model

BrowserSession is an internal routing/lifecycle object. Its identifier is not a user-facing concept.

Minimum internal state:

```ts
interface BrowserSession {
  id: string;                 // internal only
  originTabId?: number;       // tab where Study Page was invoked
  agentTabId: number;         // duplicate controlled by this session
  chatTabId: number;          // ChatGPT conversation used by this session
  state: 'starting' | 'running' | 'paused' | 'stopped' | 'failed';
  createdAt: string;
}
```

Additional implementation metadata may be stored as needed, but the UI must not expose session IDs unless a dedicated diagnostic/developer view is added later.

### 3.1 One-controller rule

The one hard ownership rule is:

> One physical Chrome tab may be directly controlled by at most one active BrowserSession.

This prevents conflicting automation commands against the same tab.

This rule does **not** prevent the user from invoking Study Page on a controlled tab. Study Page duplicates that tab first, and the new BrowserSession controls the new duplicate.

Example:

```text
Session A controls tab 20.
User invokes Study Page on tab 20.
Chrome duplicates tab 20 -> tab 34.
Session B controls tab 34.
Session A continues controlling tab 20.
```

### 3.2 Cascades are allowed

ResearchTube must not impose artificial restrictions on recursive or cascading use.

The user may invoke Study Page on:

- a normal web tab;
- an agent tab;
- a ChatGPT tab created by another session;
- a duplicate of any of the above.

This can produce arbitrary chains such as:

```text
Facebook
  -> ChatGPT A
       -> ChatGPT B
            -> another site
                 -> ChatGPT C
```

That is acceptable. Each BrowserSession remains independent because it owns different physical tab IDs.

Do not attempt to protect the user from creating many tabs or complicated tab relationships. Chrome already allows the user to create arbitrarily many tabs manually. ResearchTube's responsibility is correct routing and lifecycle handling, not tab-count policy.

---

## 4. Automation overlay

Every agent-controlled page tab must display a small, unobtrusive extension overlay.

Suggested UI:

```text
+----------------------------------+
| ResearchTube automation  ●       |
| [ Pause ]   [ Stop ]             |
+----------------------------------+
```

Requirements:

- Show only meaningful user state.
- Do not show BrowserSession IDs.
- Do not show internal tab IDs.
- `Pause` stops new automated page actions while retaining the session.
- `Resume` resumes from the page's current real state.
- `Stop` terminates the session's automation.
- The overlay must not imply that the user is forbidden from interacting with the page.

The overlay is informational/control UI, not an ownership lock.

---

## 5. Page representation

### 5.1 Accessibility Tree is the primary semantic source

Use Chrome DevTools Protocol `Accessibility` as the primary representation of page structure.

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
- relationships represented by the accessibility model.

Relevant CDP methods include:

```text
Accessibility.enable
Accessibility.getRootAXNode
Accessibility.getFullAXTree
Accessibility.getChildAXNodes
Accessibility.getAXNodeAndAncestors
Accessibility.getPartialAXTree
Accessibility.queryAXTree
```

Relevant events include:

```text
Accessibility.loadComplete
Accessibility.nodesUpdated
```

ResearchTube must not initially attempt to reimplement browser accessibility semantics from raw HTML.

### 5.2 Preserve tree structure

The internal representation must remain tree-shaped.

Example:

```text
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
```

A compact indented textual serialization may be used for MCP/model output, but that is only a serialization of a semantic tree, not a conversion into a fundamentally flat page model.

### 5.3 Compact serializer

Implement a deliberately small serializer/normalizer rather than a complex custom page-understanding layer.

Initial normalization rules should be mechanical only:

- omit `ignored=true` AX nodes;
- collapse empty/redundant generic wrappers where this does not destroy useful hierarchy;
- avoid duplicating accessible names as redundant child text;
- omit verbose CDP metadata not useful to the model;
- retain stable/addressable node IDs;
- truncate or defer very large text blocks instead of dropping them;
- retain semantically important containers and controls.

Example output:

```text
[10] main
  [11] heading "Relationships"
  [20] article
    [21] heading "My husband wants a divorce"
    [22] text length=9847 "I've been married for eighteen years..."
    [23] button "Show more" expanded=false
    [30] group "Replies" children=151
```

### 5.4 Lazy exploration

Do not send a full large page to ChatGPT unless required.

The preferred interaction is incremental:

1. Return a root/outline view.
2. Let the model request children/subtrees.
3. Return full long text only when requested.
4. Return changed subtrees/deltas after actions when practical.

This keeps token use low without lossy summarization.

The system must preserve access to omitted/deferred content through node/resource IDs.

### 5.5 DOM as secondary source

Accessibility Tree is not sufficient for every task. Add a bridge from AX nodes to DOM nodes using backend DOM node identifiers where available.

Use DOM/DOMSnapshot as needed for:

- `href`;
- `src` / `currentSrc`;
- element attributes;
- form details not represented adequately in AX;
- layout/geometry;
- CSS background images;
- Shadow DOM/iframe investigation;
- malformed sites with poor accessibility semantics;
- resolving an AX node into the actual page object/resource.

`DOMSnapshot.captureSnapshot` may be used when a broader DOM/layout snapshot is useful, but it is not the default representation sent to ChatGPT.

### 5.6 Browser state is authoritative

Never assume that the page still matches the agent's previous plan.

The page can change because of:

- ChatGPT actions;
- user actions;
- site JavaScript;
- navigation;
- timers/live updates;
- network results;
- another user device changing server-side state.

Before dependent actions, use the real current browser state. When the user changes the agent tab manually, the next observation simply reflects the new state.

---

## 6. Browser actions

Expose a small generic action vocabulary rather than site-specific commands.

Suggested MCP surface:

```text
site_read
site_get_children
site_get_node
site_get_text
site_get_files
site_interact
```

`site_interact` should use a compact action union, for example:

```json
{ "action": "click",  "nodeId": "23" }
{ "action": "type",   "nodeId": "7",  "text": "mini excavator" }
{ "action": "key",    "key": "Enter" }
{ "action": "scroll", "direction": "down", "amount": 0.8 }
{ "action": "select", "nodeId": "55", "value": "Used" }
{ "action": "hover",  "nodeId": "72" }
```

Exact final tool names may follow existing ResearchTube naming conventions.

### 6.1 Action implementation

Prefer stable node-based operations through DOM/CDP and `Input` rather than asking the model to generate arbitrary JavaScript.

`Runtime.evaluate` may be retained as an internal fallback/debug capability but must not be the primary generic browser-control contract exposed to the model.

### 6.2 Dynamic/hidden content

The agent must be able to interact with controls that reveal or load additional content.

Example:

```text
[37] button "Show 48 more replies" expanded=false
```

The model clicks node `37`, waits for the page to settle/change, then receives updated semantic state.

This supports accordions, sliders, disclosure controls, lazy loading, search forms, pagination, infinite scrolling, dialogs, menus, etc., without site-specific adapters.

---

## 7. Images and visual media

### 7.1 Do not rasterize structured content unnecessarily

The system must not use screenshots as the default representation of a web page.

For ordinary UI:

```text
Accessibility / DOM -> semantic MCP data
```

For real images:

```text
page image resource -> original image bytes -> ChatGPT attachment
```

Vision should be used for genuinely visual content, not to rediscover text/buttons already known to the browser.

### 7.2 Prefer original resources

When an image is requested, resolve the actual resource whenever possible.

Preferred order:

1. actual `<img>` / `currentSrc` resource;
2. CSS `background-image` resource;
3. `<picture>` selected resource;
4. blob/data resource resolved in page context;
5. rendered SVG/canvas extraction;
6. screenshot/crop of the specific element;
7. viewport screenshot only as a last fallback.

Full-page screenshots are not part of the normal path.

### 7.3 Resource identity

Do not expose huge temporary CDN URLs to the model as the primary handle.

Assign compact local resource IDs, e.g.:

```text
[71] image resource=img_71
[72] image resource=img_72
[73] image resource=img_73
```

ResearchTube internally maps each resource ID to the relevant DOM/network/resource information.

### 7.4 Image delivery to ChatGPT

Current ResearchTube experience has shown that local/private image URLs and MCP-returned image content cannot be assumed to become reliable ChatGPT vision input.

Therefore the primary Browser Agent visual path is:

```text
agent page
  -> extract original image bytes
  -> create temporary/local Workspace file
  -> automate the dedicated ChatGPT tab
  -> attach the file as a real ChatGPT attachment
  -> send/continue the browser task
```

The user does not manually attach files.

The dedicated ChatGPT tab is known explicitly by `chatTabId`; never choose the destination based on whichever Chrome tab happens to be active.

### 7.5 Attach images only when useful

User consent is page-level: invoking Study Page authorizes the agent to work with the contents of that chosen page/session.

Do not prompt separately for each image.

However, avoid automatically attaching every visual resource merely because it exists. This is an efficiency rule, not a privacy restriction.

A page may contain hundreds of irrelevant assets such as logos, avatars, icons, advertisements, emoji, or tracking pixels.

Normal behavior:

1. semantic model tells ChatGPT which images/resources exist;
2. ChatGPT requests the subset relevant to the current task;
3. ResearchTube attaches those automatically.

For image-centric pages/listings it is valid for the model to request many or all meaningful content photos.

### 7.6 Mid-task visual continuation

If ChatGPT decides during an active browser task that it needs an image, the attachment may require a new ChatGPT turn.

ResearchTube should support this continuation flow:

```text
model requests img_73
-> ResearchTube extracts img_73
-> ResearchTube attaches it to chatTabId
-> ResearchTube sends a minimal continuation message
-> next model turn continues the same BrowserSession
```

The continuation text should be machine-oriented and minimal, e.g.:

```text
Requested browser resource img_73 attached. Continue the current Study Page task.
```

Do not require user interaction for this continuation.

---

## 8. ChatGPT tab behavior

### 8.1 Dedicated but ordinary tab

Each Study Page start creates a normal ChatGPT tab for that BrowserSession.

It is "dedicated" only in the routing sense: the session remembers its tab ID.

It is not hidden, pinned, locked, grouped, or protected from the user.

### 8.2 User interaction is allowed

The user may enter the ChatGPT tab, scroll it, read it, interact with it, or even invoke Study Page from it.

If Study Page is invoked from that ChatGPT tab, ResearchTube simply duplicates it and starts another independent BrowserSession.

### 8.3 No active-tab assumptions

All automated operations targeting ChatGPT must use the stored `chatTabId` and verify the expected conversation/context before modifying the composer.

Never route attachments or continuation messages to the currently focused Chrome tab merely because it is active.

---

## 9. Lifecycle and interruption handling

User interruption must be a first-class supported state transition.

### 9.1 Agent tab closed

If `agentTabId` is closed:

- stop that BrowserSession;
- cancel pending actions for that tab;
- cancel/clean session-owned temporary work where safe;
- do not recreate the tab automatically.

Closing the agent tab is a valid way for the user to end the automation.

### 9.2 ChatGPT tab closed

If `chatTabId` is closed:

- stop that BrowserSession;
- do not silently create a replacement ChatGPT tab;
- leave unrelated tabs untouched.

### 9.3 Origin tab closed

After a BrowserSession has successfully started, closing the original source/origin tab does not stop the session. The agent operates on its duplicate.

### 9.4 Manual navigation in agent tab

If the user navigates the agent tab manually:

- do not treat this as corruption;
- invalidate stale page/node assumptions;
- re-observe the new real state;
- let ChatGPT continue from the new state if the session remains running.

### 9.5 Pause

While paused:

- do not issue new browser actions;
- user interaction remains unrestricted;
- observation/state tracking may continue as needed for resumption;
- on resume, discard stale action assumptions and observe the current page before acting.

### 9.6 Stop

Stop means:

- no further automated page actions;
- no further automatic attachments/messages for that session;
- release debugger/control ownership;
- remove/disable the automation overlay;
- clean session-scoped temporary resources when safe.

Stopping the session does not have to close either visible tab. The user may keep them.

### 9.7 Extension/browser restart

A first implementation may treat Chrome/extension/agent restart as terminating active sessions.

Do not attempt invisible automatic recovery unless explicitly implemented later. Stale overlays should be removed or change to a non-running state after reconnection.

---

## 10. Concurrency

ResearchTube must support multiple BrowserSessions concurrently.

Requirements:

- each session routes to its own `agentTabId` and `chatTabId`;
- commands must never be sent to a tab based only on focus/active-window state;
- temporary media/resources must be session-addressable;
- one physical tab cannot have two automation controllers;
- the user may directly interact with all tabs;
- no arbitrary global limit on the number of sessions is required at the architecture level.

Resource limits may exist for technical reasons (memory, attachment size, browser limits), but they must be explicit implementation limits, not conceptual restrictions on session topology.

---

## 11. Site authentication and credentials

ResearchTube must use the user's existing normal Chrome session.

The design must not require exporting cookies or account credentials to ChatGPT/MCP.

For authenticated sites:

```text
user logs into site normally in Chrome
-> Study Page duplicates that tab in the same Chrome profile
-> agent works through the already-authenticated browser context
```

Cookies, tokens, local storage, and other browser authentication state remain browser-managed.

The semantic MCP layer exposes page content and agent actions, not raw authentication credentials.

---

## 12. Non-goals for the first implementation

The initial generic Browser Agent does not require:

- site-specific adapters;
- automatic understanding of every custom canvas application;
- a custom browser rendering engine;
- a custom accessibility engine;
- image OCR when original semantic text exists;
- full-page screenshot navigation;
- a hidden automation browser;
- a separate user profile;
- tab groups;
- user-facing session identifiers;
- forced confirmation for every page image;
- artificial prevention of recursive Study Page cascades;
- arbitrary JavaScript generated by the LLM as the normal control mechanism.

---

## 13. Suggested implementation layers

```text
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
```

---

## 14. Suggested MCP contract

Names are provisional and should be aligned with existing ResearchTube conventions.

### 14.1 `site_read`

Purpose: obtain the current semantic page view.

Possible arguments:

```ts
{
  mode?: 'outline' | 'subtree' | 'full';
  nodeId?: string;
  depth?: number;
}
```

Return compact semantic tree data plus page identity/state metadata.

### 14.2 `site_get_children`

Purpose: lazy expansion of one semantic node.

```ts
{
  nodeId: string;
  depth?: number;
}
```

### 14.3 `site_get_text`

Purpose: return deferred full text for a long text-bearing node.

```ts
{
  nodeId: string;
}
```

### 14.4 `site_get_files`

Purpose: resolve a page resource without automatically embedding all of its bytes in the MCP response.

```ts
{
  resourceId: string;
}
```

For image resources, the result may start the attachment/continuation workflow rather than return base64 to the model.

### 14.5 `site_interact`

Purpose: generic page interaction.

```ts
{
  action: 'click' | 'type' | 'key' | 'scroll' | 'hover' | 'select';
  nodeId?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  value?: string;
}
```

Each action result should include enough page-change metadata to determine whether re-observation is required.

### 14.6 Session tools

The user-facing Study Page command creates the BrowserSession automatically; ChatGPT does not necessarily need low-level session creation tools.

If explicit tools are useful internally, keep them minimal:

```text
site_session_status
site_session_pause
site_session_resume
site_session_stop
```

User-facing UI remains the overlay and ordinary Chrome tabs.

---

## 15. Page change tracking

Use Accessibility/DOM events where practical to avoid retransmitting entire pages.

Preferred behavior after an action:

```text
before:
[23] button "Show more" expanded=false

site_interact(click, 23)

change:
UPDATED [23] expanded=true
ADDED under [20]: [301], [302], [303] ...
```

Exact delta mechanics can be refined after experimentation. Correctness is more important than premature optimization.

If change tracking becomes unreliable for a page, fall back to a fresh subtree/outline observation rather than preserving a stale model.

---

## 16. Safety model and side effects

The generic browser cannot make a perfect universal distinction between read-only and mutating actions. A click can reveal text, submit a form, send a message, like a post, purchase an item, or change account state.

The architecture therefore must not pretend that arbitrary browser control is inherently read-only.

For the initial implementation, the core requirement is technical transparency and user control:

- automation occurs in a visible tab;
- the overlay clearly shows that automation is active;
- Pause and Stop are immediately available;
- the user can inspect or intervene at any time;
- server-side changes are real changes made under the user's authenticated account.

If a later product policy adds confirmations for high-impact actions, that policy should be layered above the generic browser mechanism rather than encoded as site-specific logic in the Browser Agent core.

---

## 17. Error handling

The Browser Agent must fail locally and predictably.

Examples:

### Tab disappears

```text
TAB_CLOSED
```

Stop the affected session. Never guess another tab.

### Tab navigates unexpectedly

```text
PAGE_CHANGED
```

Invalidate stale nodes and re-observe.

### Node no longer exists

```text
STALE_NODE
```

Return the failure and enough current page metadata for ChatGPT to re-observe/reselect.

### Debugger detaches

```text
DEBUGGER_DETACHED
```

Stop or pause the session; do not silently control another target.

### ChatGPT attachment target changed

If the stored `chatTabId` no longer points to the expected conversation/composer context, fail the attachment operation rather than attaching to an arbitrary ChatGPT tab.

### Resource unavailable

If original media cannot be resolved:

1. try supported alternative extraction paths;
2. if appropriate, capture only the relevant element;
3. report failure/fallback explicitly.

---

## 18. MVP implementation sequence

### Phase 1 — AX inspection only

Implement one diagnostic path for the current/agent tab:

- attach through `chrome.debugger`;
- enable Accessibility domain;
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

The goal is to discover how much useful semantics Chrome already provides before adding custom normalization.

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
- tab close/navigation handling;
- multiple concurrent sessions;
- recursive Study Page behavior.

### Phase 4 — DOM/resource bridge

Add:

- AX -> backend DOM mapping;
- link/src/currentSrc extraction;
- image resource IDs;
- CSS/background image handling;
- fallback element rendering/capture.

### Phase 5 — automatic visual delivery

Add:

- resource extraction to Workspace/temp files;
- targeted attachment to `chatTabId`;
- automatic continuation message;
- cleanup.

### Phase 6 — delta optimization

Only after the basic agent is reliable:

- `nodesUpdated` processing;
- subtree diffing;
- incremental semantic updates;
- model/context efficiency tuning.

---

## 19. Acceptance criteria

The generic Browser Agent feature is functionally successful when all of the following are true:

1. From any ordinary Chrome page, the user can invoke **Study Page**.
2. The source page remains untouched.
3. ResearchTube creates a visible duplicate page tab and a visible ChatGPT tab.
4. The agent page shows a small automation overlay with Pause/Stop.
5. ChatGPT can obtain a useful semantic tree without screenshots.
6. ChatGPT can lazily inspect nested page content.
7. ChatGPT can click, type, scroll, select, and otherwise navigate generic controls.
8. Dynamic content such as "Show more" can be opened and subsequently inspected.
9. Images are represented as resources rather than automatic screenshots.
10. When ChatGPT requests an image, ResearchTube can extract the actual image where possible and attach it automatically to the correct ChatGPT tab.
11. No raw site credentials/cookies have to be exported to ChatGPT.
12. Closing the agent or ChatGPT tab cleanly stops the corresponding BrowserSession.
13. Manual user navigation/action in the agent tab does not corrupt the system; ChatGPT can re-observe and continue.
14. Multiple independent BrowserSessions can run concurrently.
15. Invoking Study Page from a tab already involved in another BrowserSession creates a new duplicate/new ChatGPT tab and does not create two controllers for the same physical tab.
16. No tab groups, hidden tabs, session IDs, or site-specific adapters are required for normal operation.

---

## 20. Design principles summary

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
14. **Treat the current browser state as the source of truth.**
15. **Keep the generic core site-agnostic.**
