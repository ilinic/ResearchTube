import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../youtube-page-bridge.src.js',import.meta.url),'utf8');
// Transcript regression: always use the original anonymous ANDROID player,
// even when watch HTML already contains WEB caption tracks.
const transcriptRequests=[];
let unsafeTrack=false;
const transcriptContext=vm.createContext({URL,location:{href:'https://www.youtube.com/',origin:'https://www.youtube.com'},
  captureResponse(){},urlFrom:input=>new URL(input,'https://www.youtube.com').href,
  originalFetch:async(input,init)=>{
    transcriptRequests.push({input,init});
    assert.equal(init.credentials,'omit');
    assert.equal(init.headers?.Authorization,undefined);
    if(input.startsWith('/watch'))return {ok:true,text:async()=>'<script>var config={"INNERTUBE_API_KEY":"fixture-key"}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"WEB_SHOULD_NOT_BE_USED"}]}}};</script>'};
    if(input.startsWith('/youtubei/v1/player')){
      const body=JSON.parse(init.body);
      assert.equal(body.context.client.clientName,'ANDROID');assert.equal(body.context.client.clientVersion,'20.10.38');
      assert.equal(body.videoId,'abcdefghijk');
      return {ok:true,json:async()=>({captions:{playerCaptionsTracklistRenderer:{captionTracks:[
        {languageCode:'en',name:{simpleText:'English'},baseUrl:'https://www.youtube.com/api/timedtext?track=0'},
        {languageCode:'ru',name:{simpleText:'Russian'},baseUrl:unsafeTrack?'https://evil.test/captions':'https://www.youtube.com/api/timedtext?track=1'}
      ]}}})};
    }
    assert.equal(input,'https://www.youtube.com/api/timedtext?track=1');
    return {ok:true,text:async()=>'<timedtext><body><p t="1250" d="2500">Restored &amp; tested</p><p t="3750" d="1000">Next</p></body></timedtext>'};
  }});
const allowedStart=source.indexOf('  function isAllowedTimedTextUrl(');
vm.runInContext(source.slice(source.indexOf('  async function observedFetch('),source.indexOf('  window.fetch ='))+source.slice(allowedStart,source.indexOf('  // The library is bundled',allowedStart))+
  source.slice(source.indexOf('  function textOf('),source.indexOf('  // Search deliberately uses fetch')),transcriptContext);
const restored=await transcriptContext.getTranscriptFromPlayer({videoId:'abcdefghijk',limit:1,trackIndex:1});
assert.equal(restored.selectedTrack.languageCode,'ru');assert.equal(restored.returned,1);
assert.equal(restored.segments[0].start,1.25);assert.equal(restored.segments[0].duration,2.5);assert.equal(restored.segments[0].text,'Restored & tested');
assert.equal(transcriptRequests.length,3);
await assert.rejects(()=>transcriptContext.getTranscriptFromPlayer({videoId:'abcdefghijk',trackIndex:2}),/unavailable/);
unsafeTrack=true;
const beforeUnsafe=transcriptRequests.length;
await assert.rejects(()=>transcriptContext.getTranscriptFromPlayer({videoId:'abcdefghijk',trackIndex:1}),/valid YouTube timedtext URL/);
assert.equal(transcriptRequests.length,beforeUnsafe+2,'reject foreign caption URL before fetching it');
console.log('Transcript regression: anonymous watch, ANDROID player, timedtext, track selection, timestamps, limits and origin validation passed');
const comment=id=>({comment:{comment_id:id}});
const parent=Object.assign(comment('root1'),{has_replies:true,has_continuation:true,replies:[comment('reply1')],async getReplies(){return this;},async getContinuation(){return {replies:[comment('reply2')],has_continuation:false};}});
const page={contents:[parent],has_continuation:true,async getContinuation(){return {contents:[comment('root2')],has_continuation:false};}};
const ctx=vm.createContext({Date,crypto:webcrypto,accountState:()=>({contextId:'test-context'}),getInnertube:async()=>({getComments:async()=>page}),normalizeCommentThread:t=>({commentId:t.comment.comment_id}),normalizeReplyThread:t=>({commentId:t.comment.comment_id})});
vm.runInContext(source.slice(source.indexOf('  const exportSessions ='),source.indexOf('  function parentSummary(')),ctx);
let sessionId=null;const seen=[];
for(let i=0;i<4;i++) {const result=await ctx.exportCommentPage({videoId:'abcdefghijk',sort:'newest',includeReplies:true,sessionId});sessionId=result.sessionId;seen.push(...result.records.map(r=>[r.commentId,r.parentCommentId]));assert.equal(result.hasMore,i<3);}
assert.deepEqual(seen,[['root1',null],['reply1','root1'],['reply2','root1'],['root2',null]]);
await assert.rejects(()=>ctx.exportCommentPage({videoId:'different',sort:'newest',includeReplies:true,sessionId}),/mismatch/);
await assert.rejects(()=>ctx.exportCommentPage({videoId:'abcdefghijk',sort:'newest',includeReplies:true,sessionId:'exp_missing'}),/expired/);
ctx.accountState=()=>({contextId:'other-account'});
await assert.rejects(()=>ctx.exportCommentPage({videoId:'abcdefghijk',sort:'newest',includeReplies:true,sessionId}),/mismatch/);

// Preserve the original query cache without introducing account-state requests.
const background=await readFile(new URL('../background.js',import.meta.url),'utf8');
let searches=0;
const cache=vm.createContext({Date,crypto:webcrypto,searchCache:new Map(),searchQueue:Promise.resolve(),searchRequestSequence:0,searchQueueDepth:0,SEARCH_CACHE_TTL_MS:30000,
  runYouTubePageTool:()=>{throw Error('Anonymous cache must not inspect account');},recordSearchDiagnostic(){},searchDiagnosticQuery:v=>v,finishQueuedSearch(){},
  runQueuedYouTubeSearch:async()=>({search:++searches})});
vm.runInContext(background.slice(background.indexOf('function searchCacheKey('),background.indexOf('function finishQueuedSearch(')),cache);
assert.equal((await cache.youtubeSearch('same query',10)).search,1);
assert.equal((await cache.youtubeSearch('same query',10)).search,1);
assert.equal((await cache.youtubeSearch('different query',10)).search,2);
// The bundled comments client must keep credentials omitted for its fetches.
let clientOptions;
const network=[];
const transport=vm.createContext({URL,location:{href:'https://www.youtube.com/'},window:{ytcfg:{get:()=>undefined}},innertubePromise:null,
  Innertube:{create:async options=>{clientOptions=options;return {getComments(){}};}},
  observedFetch:async(input,init)=>{network.push({input,init});return {ok:true};}});
vm.runInContext(source.slice(source.indexOf('  async function getInnertube('),source.indexOf('  function textOf(')),transport);
await transport.getInnertube();
await clientOptions.fetch('https://www.youtube.com/youtubei/v1/next',{credentials:'include',method:'POST'});
assert.equal(network[0].init.credentials,'omit');
vm.runInContext(source.slice(source.indexOf('  function searchEndpoint('),source.indexOf('  function extractSearchJson(')),transport);
await transport.searchFetch([], '/results?search_query=topic');
await transport.searchFetch([], '/youtubei/v1/search', {method:'POST'});
assert.ok(network.every(item=>item.init.credentials==='omit'));
assert.ok(network.slice(1).every(item=>item.init.redirect==='manual'));
console.log('Anonymous YouTube: search/cache, comments client, transcript and full export pagination passed');
