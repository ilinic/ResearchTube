import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { sessionRequestOptions } from '../youtube-session.js';

const env = { origin: 'https://www.youtube.com', cookies: () => 'OTHER=ignored; SAPISID=private-test-signing-value',
  config: key => ({LOGGED_IN:true,SESSION_INDEX:2,DELEGATED_SESSION_ID:'test-channel',INNERTUBE_CONTEXT:{user:{lockedSafetyMode:false}}})[key] };
const options = await sessionRequestOptions('/youtubei/v1/search', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({context:{client:{clientName:'WEB'}}})}, env);
assert.equal(options.credentials,'include'); assert.equal(options.redirect,'manual');
assert.equal(options.headers.get('Cookie'),null);
assert.equal(options.headers.get('X-Goog-AuthUser'),'2');
assert.equal(options.headers.get('X-Goog-PageId'),'test-channel');
const authorization=options.headers.get('Authorization');
const [timestamp,hash]=authorization.replace('SAPISIDHASH ','').split('_');
assert.equal(hash,createHash('sha1').update(`${timestamp} private-test-signing-value ${env.origin}`).digest('hex'));
assert.equal(JSON.parse(options.body).context.user.onBehalfOfUser,'test-channel');
const html = await sessionRequestOptions('/results?search_query=test', {}, env);
assert.equal(html.credentials,'include');assert.equal(html.headers.get('Authorization'),null);
await assert.rejects(()=>sessionRequestOptions('https://evil.test/youtubei/v1/search',{},env),/must stay/);
await assert.rejects(()=>sessionRequestOptions('/youtubei/v1/next',{}, {...env,cookies:()=>''}),/signing state/);

// Exercise pagination through roots, multiple reply pages and next root page.
const source=await readFile(new URL('../youtube-page-bridge.src.js',import.meta.url),'utf8');
// Transcript regression: always use the original anonymous ANDROID player,
// even when watch HTML already contains WEB caption tracks.
const transcriptRequests=[];
let unsafeTrack=false;
const transcriptContext=vm.createContext({URL,location:{href:'https://www.youtube.com/',origin:'https://www.youtube.com'},
  observedFetch:()=>{throw Error('Transcript must not enter session transport');},captureResponse(){},
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
vm.runInContext(source.slice(allowedStart,source.indexOf('  // The library is bundled',allowedStart))+
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
vm.runInContext(source.slice(source.indexOf('  const exportSessions ='),source.indexOf('  async function getVideoPageData(')),ctx);
let sessionId=null;const seen=[];
for(let i=0;i<4;i++) {const result=await ctx.exportCommentPage({videoId:'abcdefghijk',sort:'newest',includeReplies:true,sessionId});sessionId=result.sessionId;seen.push(...result.records.map(r=>[r.commentId,r.parentCommentId]));assert.equal(result.hasMore,i<3);}
assert.deepEqual(seen,[['root1',null],['reply1','root1'],['reply2','root1'],['root2',null]]);
await assert.rejects(()=>ctx.exportCommentPage({videoId:'different',sort:'newest',includeReplies:true,sessionId}),/mismatch/);
await assert.rejects(()=>ctx.exportCommentPage({videoId:'abcdefghijk',sort:'newest',includeReplies:true,sessionId:'exp_missing'}),/expired/);
ctx.accountState=()=>({contextId:'other-account'});
await assert.rejects(()=>ctx.exportCommentPage({videoId:'abcdefghijk',sort:'newest',includeReplies:true,sessionId}),/mismatch/);

// A signed-in account switch must not reuse another account's cached results.
const background=await readFile(new URL('../background.js',import.meta.url),'utf8');
let account='account-one',searches=0;
const cache=vm.createContext({Date,crypto:webcrypto,searchCache:new Map(),searchQueue:Promise.resolve(),searchRequestSequence:0,searchQueueDepth:0,SEARCH_CACHE_TTL_MS:30000,
  runYouTubePageTool:async()=>({contextId:account}),recordSearchDiagnostic(){},searchDiagnosticQuery:v=>v,finishQueuedSearch(){},
  runQueuedYouTubeSearch:async()=>({search:++searches})});
vm.runInContext(background.slice(background.indexOf('function searchCacheKey('),background.indexOf('function finishQueuedSearch(')),cache);
assert.equal((await cache.youtubeSearch('same query',10)).search,1);
assert.equal((await cache.youtubeSearch('same query',10)).search,1);
account='account-two';assert.equal((await cache.youtubeSearch('same query',10)).search,2);
console.log('YouTube session: cookie inclusion, origin-bound signing, account selection, origin guard and full comment pagination passed');
