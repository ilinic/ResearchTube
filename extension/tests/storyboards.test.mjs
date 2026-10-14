import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { assertSchema } from './fixtures/schema-check.mjs';
import { STORYBOARD_TOOL_NAMES, storyboardDefinitions, validateStoryboardInput, normalizeStoryboardResult } from '../storyboards.js';

const vid = 'aqz-KE-bpKQ';
const id = 'tsk_ABCDEFGHIJ';
const [info, download, status, cancel] = STORYBOARD_TOOL_NAMES;
const variant = { variantId: 'storyboard_2', cellWidth: 160, cellHeight: 90, columns: 5, rows: 5, framesPerSheet: 25, frameIntervalSeconds: 5, frameIntervalEstimated: false, sheetCount: 3, format: 'jpeg' };
const definitions = storyboardDefinitions({ readOnlyHint: true }, { readOnlyHint: false });
assert.deepEqual(definitions.map(d => d.name), STORYBOARD_TOOL_NAMES);
assert.equal(definitions[0].annotations.readOnlyHint, true);
assert.equal(definitions[1].annotations.readOnlyHint, false);
assert.match(definitions[1].description, /sheetTimestamps always returns calculated tile times/);
const downloadArgs = validateStoryboardInput(download, { videoId: vid, variantId: variant.variantId, selection: { mode: 'sheets', sheetIndexes: [2, 2, 0] } });
assert.deepEqual(downloadArgs.selection.sheetIndexes, [2, 0]);
assert.equal(downloadArgs.frameTimestampPosition, 'bottomRight');
assert.equal(validateStoryboardInput(download, { videoId: vid, variantId: variant.variantId, selection: { mode: 'all' }, frameTimestampPosition: 'none' }).frameTimestampPosition, 'none');
for (const args of [{ videoId: vid, rawSpec: 'secret' }, { videoId: 'bad' }, null, []]) assert.throws(() => validateStoryboardInput(info, args), { code: 'STORYBOARD_INVALID' });
for (const selection of [{ mode: 'all', sheetIndexes: [1] }, { mode: 'sheets', sheetIndexes: [] }, { mode: 'range', startSeconds: NaN, endSeconds: 10 }, { mode: 'range', startSeconds: 10, endSeconds: 5 }]) {
  assert.throws(() => validateStoryboardInput(download, { videoId: vid, variantId: variant.variantId, selection }), { code: 'STORYBOARD_INVALID' });
}
const normalized = normalizeStoryboardResult(info, { videoId: vid, available: true, durationSeconds: 263.2, spec: 'secret', variants: [{ ...variant, urls: ['https://private?sigh=secret'] }] });
assert.equal(JSON.stringify(normalized).includes('secret'), false);
assert.deepEqual(normalized.variants, [variant]);
assert.throws(() => normalizeStoryboardResult(info, { videoId: vid, available: true, durationSeconds: 20, variants: [{ ...variant, framesPerSheet: 24 }] }), { code: 'AGENT_INVALID_RESPONSE' });

for (const reason of ['STORYBOARD_NOT_AVAILABLE', 'STORYBOARD_VIDEO_LIVE', 'STORYBOARD_CONTEXT_UNAVAILABLE']) {
  const unavailable = normalizeStoryboardResult(info, { videoId: vid, available: false, reason, comment: 'private signed URL' });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.comment, /visual_map_create.*Workspace video/);
  assert.ok(!JSON.stringify(unavailable).includes('private'));
  assertSchema(definitions[0].outputSchema, unavailable);
  const rejected = normalizeStoryboardResult(download, { status: 'rejected', error: { code: reason, message: 'private' } });
  assert.match(rejected.comment, /visual_map_create/);
  assertSchema(definitions[1].outputSchema, rejected);
  if (reason === 'STORYBOARD_NOT_AVAILABLE') assert.match(rejected.error.message, /visual_map_create/);
}
assert.equal(normalized.comment, undefined, 'available storyboards need no fallback comment');
assert.equal(normalizeStoryboardResult(info, {status:'rejected',error:{code:'STORYBOARD_INVALID'}}).comment, undefined);

const task = { taskId: id, status: 'working', phase: 'downloading', progressPercent: 35, completedSheets: 1, totalSheets: 3, downloadedSheets: 1, reusedSheets: 0, workspaceDirectory: 'storyboards', pollIntervalMs: 1000, publishedSheets: [{sheetIndex: 0, workspacePath: 'storyboards/example.jpeg'}], frameTimestampPosition: 'bottomRight', sheetTimestamps: [{ sheetIndex: 0, frameTimestampsSeconds: [0, 5] }, { sheetIndex: 1, frameTimestampsSeconds: [125, 130] }, { sheetIndex: 2, frameTimestampsSeconds: [250, 255, 260] }] };
assert.deepEqual(normalizeStoryboardResult(status, { ...task, rawSpec: 'secret', paths: ['C:\\private'] }), task);
assert.throws(() => normalizeStoryboardResult(status, { ...task, completedSheets: 2 }), { code: 'AGENT_INVALID_RESPONSE' });
assert.throws(() => normalizeStoryboardResult(status, { ...task, workspaceDirectory: 'C:\\private' }), { code: 'AGENT_INVALID_RESPONSE' });
assert.throws(() => normalizeStoryboardResult(status, { ...task, sheetTimestamps: [] }), { code: 'AGENT_INVALID_RESPONSE' });
assert.throws(() => normalizeStoryboardResult(status, { ...task, status: 'completed', phase: 'completed' }), { code: 'AGENT_INVALID_RESPONSE' });
const failed = normalizeStoryboardResult(status, { ...task, status: 'failed', phase: 'failed', failedSheetIndex: 2, error: { code: 'STORYBOARD_DOWNLOAD_FAILED', message: 'private https://foo?sigh=secret' } });
assert.equal(JSON.stringify(failed).includes('secret'), false);
assert.equal(normalizeStoryboardResult(info, { status: 'rejected', error: { code: 'STORYBOARD_INVALID', message: 'private' } }).status, 'rejected');
assert.deepEqual(normalizeStoryboardResult(cancel, { taskId: id, status: 'cancelled', url: 'private' }), { taskId: id, status: 'cancelled' });

// Exercise the actual Extension routing helper with browser and Agent boundaries stubbed.
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const helper = background.slice(background.indexOf('async function storyboardCall('), background.indexOf('function normalizeVisualMapInput('));
let calls = [], pageCalls = [];
const make = tabs => new Function('chrome', 'sendYouTubePageTool', 'agentJsonRequest', 'validateStoryboardInput', 'normalizeStoryboardResult', 'localAgentError', `${helper}; return storyboardCall;`)(
  { tabs: { query: async () => tabs } },
  async (tab, message) => { pageCalls.push({ tab, message }); return { ok: true, data: { videoId: vid, title: 'Video', durationSeconds: 263.2, isLive: false, spec: 'private-spec' } }; },
  async (path, options) => { calls.push({ path, options }); return normalized; }, validateStoryboardInput, normalizeStoryboardResult,
  (code, message) => Object.assign(new Error(message), { code }));
assert.deepEqual(await make([{ id: 1, url: 'https://www.youtube.com/watch?v=other-video' }, { id: 2, url: `https://www.youtube.com/watch?v=${vid}` }])(info, { videoId: vid }), normalized);
assert.equal(pageCalls.length, 1); assert.equal(pageCalls[0].tab, 2);
assert.equal(calls[0].options.body.context.spec, 'private-spec');
calls = []; pageCalls = [];
await make([])(info, { videoId: vid });
assert.equal(pageCalls.length, 0); assert.equal(calls[0].options.body.context, undefined);
assert.match(background, /STORYBOARD_TOOL_NAMES\.includes\(request.params\?\.name\)/);
assert.match(background, /storyboards: \{ title: "YouTube Storyboards"/);

// The current movie player wins over stale globals after YouTube SPA navigation.
const bridge = await readFile(new URL('../youtube-page-bridge.src.js', import.meta.url), 'utf8');
const contextFunction = bridge.slice(bridge.indexOf('  function storyboardContext('), bridge.indexOf('  function pageState('));
const page = { videoDetails: { videoId: vid, title: 'Current', lengthSeconds: '100' }, storyboards: { playerStoryboardSpecRenderer: { spec: 'current-spec' } } };
const sandbox = { URL, location: { href: `https://www.youtube.com/watch?v=${vid}` }, document: { getElementById: () => ({ getPlayerResponse: () => page }) }, window: { ytInitialPlayerResponse: { videoDetails: { videoId: 'stale-video' } } } };
vm.createContext(sandbox);
vm.runInContext(contextFunction + `; result = storyboardContext('${vid}');`, sandbox);
assert.equal(sandbox.result.spec, 'current-spec');
sandbox.location.href = 'https://www.youtube.com/watch?v=another-video';
vm.runInContext(`result = storyboardContext('${vid}');`, sandbox);
assert.equal(sandbox.result, null);
console.log('Storyboards: metadata, schemas, privacy, browser bridge, routing and validation passed.');

// Bounded technical failure details survive projection, never raw exceptions.
const taskFixture={taskId:id,status:'failed',phase:'failed',progressPercent:0,totalSheets:1,completedSheets:0,downloadedSheets:0,reusedSheets:0,workspaceDirectory:'storyboards',pollIntervalMs:1000,frameTimestampPosition:'none',publishedSheets:[],sheetTimestamps:[{sheetIndex:0,frameTimestampsSeconds:[0]}],failedSheetIndex:0,error:{code:'STORYBOARD_DOWNLOAD_FAILED',message:'SECRET https://private.test/?sigh=SECRET'}};
const detail={stage:'http',reason:'HTTP_STATUS',httpStatus:403,osErrorCode:null,attempts:1,sheetIndex:0};
const diagnosed=normalizeStoryboardResult(status,{...taskFixture,failureDetails:{...detail,url:'https://private?sigh=SECRET',exception:'SECRET C:\\host'}});
assert.deepEqual(diagnosed.failureDetails,detail);
assert.match(diagnosed.error.message,/HTTP 403/);
assertSchema(definitions[2].outputSchema,diagnosed);
assert.doesNotMatch(JSON.stringify(diagnosed),/SECRET|private|exception/);
for(const bad of [{...detail,stage:'SECRET'},{...detail,reason:'SECRET'},{...detail,httpStatus:0},{...detail,sheetIndex:1},{...detail,osErrorCode:'C:\\private'},{...detail,attempts:0}])assert.throws(()=>normalizeStoryboardResult(status,{...taskFixture,failureDetails:bad}));
assert.equal(normalizeStoryboardResult(status,taskFixture).failureDetails,undefined,'older Agents remain compatible');
console.log('Storyboard failure diagnostics: HTTP, stage, sheet, attempts, fixed reason and private-field exclusion passed');

const responseDetail={...detail,reason:'UNEXPECTED_CONTENT_TYPE',httpStatus:200,exceptionType:'ValueError',
  expectedContentType:'image/jpeg',contentType:'text/html',declaredBodyBytes:123,bodyBytesRead:123,bodyKind:'html',
  contentEncoding:null,transferEncoding:'chunked',bodySampleStatus:'complete',redirectCount:1,elapsedMs:250,requestHost:'i.ytimg.com'};
const expanded=normalizeStoryboardResult(status,{...taskFixture,failureDetails:{...responseDetail,
  body:'SECRET response',headers:{'set-cookie':'SECRET'},url:'https://i.ytimg.com/sb/private?sigh=SECRET'}});
assert.deepEqual(expanded.failureDetails,responseDetail);
assert.match(expanded.error.message,/Content-Type: text\/html/);
assert.match(expanded.error.message,/body: html, read 123 B, declared 123 B/);
assert.match(expanded.error.message,/redirects: 1; elapsed: 250 ms/);
assertSchema(definitions[2].outputSchema,expanded);
assert.doesNotMatch(JSON.stringify(expanded),/SECRET|set-cookie|https:\/\//);
for(const extra of [
 {contentType:'text/html; token=SECRET'},{contentType:'x'.repeat(128)},{expectedContentType:'SECRET'},
 {bodyKind:'SECRET'},{declaredBodyBytes:-1},{declaredBodyBytes:2**53},{bodyBytesRead:1.5},
 {contentEncoding:'SECRET'},{transferEncoding:'SECRET'},{redirectCount:5},{elapsedMs:-1},
 {requestHost:'private.test'},{requestHost:'i.ytimg.com/?sigh=SECRET'},{bodySampleStatus:'SECRET'}
]) assert.throws(()=>normalizeStoryboardResult(status,{...taskFixture,failureDetails:{...responseDetail,...extra}}));
console.log('Storyboard HTTP diagnostics: MIME, bounded body classification/counts, encodings, redirects, timing and privacy projection passed');
