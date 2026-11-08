import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createLocalMcpConnection } from "../local-mcp.js";
import { localResearchDefinitions, projectCommentRecord, validateLocalArguments } from "../local-mcp-tools.js";

const messages = [], calls = [];
let socket;
class Socket {
  constructor(url) { this.url = url; this.readyState = 0; socket = this; }
  send(value) { messages.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const host = { extensionId: "id", extensionVersion: "2.11.0", interfaceVersion: 84,
  port: async () => 17843,
  fetch: async (url, options) => { assert.match(url, /^http:\/\/127\.0\.0\.1:17843\/internal\/local-mcp\/bootstrap$/); assert.equal(options.headers["X-ResearchTube-Extension"], "id"); return { ok: true, json: async () => ({ token: "a".repeat(43), interfaceVersion: 84 }) }; },
  webSocket: url => new Socket(url), setInterval: () => 1, clearInterval() {}, enabledTools: async () => ["youtube_search"],
  dispatch: async (name, input) => { calls.push(name); if (input.fail) throw Object.assign(Error("COOKIE_SECRET"), { code: "YOUTUBE_LOGIN_REQUIRED" }); return { query: input.query }; }
};
const connection = createLocalMcpConnection(host);
await connection.start();
assert.match(socket.url, /^ws:\/\/127\.0\.0\.1:17843\/internal\/local-mcp\/bridge$/);
socket.readyState = 1; socket.onopen();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(messages[0].type, "hello");
assert.equal(messages[0].token.length, 43);
const request = (id, args) => socket.onmessage({ data: JSON.stringify({ type: "request", id: id.repeat(32), name: "youtube_search", arguments: args }) });
request("a", { query: "one" }); request("b", { fail: true });
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(calls, ["youtube_search", "youtube_search"]);
assert.equal(messages.at(-1).error.code, "YOUTUBE_LOGIN_REQUIRED");
assert.doesNotMatch(JSON.stringify(messages), /COOKIE_SECRET/);
connection.close();

assert.equal(localResearchDefinitions().length, 5);
const input = localResearchDefinitions()[0].inputSchema;
assert.ok(validateLocalArguments(input, { videoId: "abcdefghijk", maxComments: 5000 }));
for (const value of [{ videoId: "abcdefghijk", maxComments: true }, { videoId: "abcdefghijk", cookie: "x" }, { videoId: "abcdefghijk", maxComments: 100001 }]) assert.equal(validateLocalArguments(input, value), false);
assert.doesNotMatch(JSON.stringify(projectCommentRecord({ videoId: "abcdefghijk", commentId: "1", text: "hello", cookie: "SECRET", url: "SIGNED" })), /SECRET|SIGNED/);

// Exercise login and local dispatch against observed page states, not source patterns.
const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("async function requireLocalYoutubeLogin()"));
let signedIn = true, creates = 0, enabled = true;
const context = vm.createContext({ crypto: { randomUUID: () => "id" }, LOCAL_YOUTUBE_TOOLS: ["youtube_search"], validateLocalArguments,
  getOrCreateYouTubeTab: async () => { creates++; return { tab: { id: 42 } }; },
  sendYouTubePageTool: async () => ({ ok: true, data: { signedIn } }),
  isMcpToolEnabled: async () => enabled,
  publicMcpTools: () => [{ name: "youtube_search", inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] } }],
  handleMcpRequest: async request => ({ result: { structuredContent: { query: request.params.arguments.query } } })
});
vm.runInContext(functions, context);
assert.equal((await context.dispatchLocalYoutube("youtube_search", { query: "x" })).query, "x");
signedIn = false;
await assert.rejects(() => context.dispatchLocalYoutube("youtube_search", { query: "x" }), e => e.code === "YOUTUBE_LOGIN_REQUIRED");
signedIn = null;
await assert.rejects(() => context.dispatchLocalYoutube("youtube_search", { query: "x" }), e => e.code === "YOUTUBE_LOGIN_UNKNOWN");
enabled = false;
const previous = creates;
await assert.rejects(() => context.dispatchLocalYoutube("youtube_search", { query: "x" }), e => e.code === "MCP_TOOL_DISABLED");
assert.equal(creates, previous);
console.log("Local MCP transport, schema validation, projection, login and disabled-tool behavior: ok");
