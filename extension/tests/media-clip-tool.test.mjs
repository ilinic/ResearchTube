import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, agent] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../../agent/researchtube_agent.py", import.meta.url), "utf8")
]);

for (const tool of ["media_clip", "media_clip_get_task", "media_clip_cancel_task"]) {
  assert.match(background, new RegExp(`name: "${tool}"`), `${tool} must be published`);
}
assert.match(background, /segments: \{ type: "array", minItems: 1/);
assert.match(background, /required without segments/i);
assert.match(background, /Cut and Convert Media/);
assert.match(background, /omit it with segments to retain the source format/);
assert.match(background, /Compatible streams are copied without quality loss/);
assert.match(background, /Read clip task progress and completed files\. Poll at pollIntervalMs/);
assert.match(background, /function normalizeMediaClipInput\(/);
assert.match(background, /function normalizeMediaClipTask\(/);
assert.match(background, /"\/tasks\/media-clip"/);
assert.match(agent, /configured_tool_limits\(\)\["mediaClipMaxSegments"\]/);
assert.match(agent, /"-progress", "pipe:1"/);
assert.match(agent, /out_time_us=/);
assert.match(agent, /progress_percent = max\(task\.progress_percent/);
assert.match(agent, /media_clip_publish_without_overwrite/);
assert.match(agent, /task\.clips\.append\(clip\)/);
assert.match(agent, /await MEDIA_CLIP_TASKS\.shutdown\(\)/);

const first = background.indexOf('function mediaClipInvalid(');
const last = background.indexOf('\nasync function createMediaClipTask(', first);
assert.ok(first >= 0 && last > first);
const localAgentError = (code, message) => Object.assign(new Error(message), {code});
const normalizeWorkspacePath = value => {
  if (typeof value !== 'string' || value.startsWith('/') || value.split('/').includes('..')) throw localAgentError('INVALID_ARGUMENT', 'Invalid Workspace path');
  return value;
};
const {normalizeMediaClipInput, normalizeMediaClipTask} = new Function('localAgentError', 'normalizeWorkspacePath',
  background.slice(first, last) + '\nreturn {normalizeMediaClipInput, normalizeMediaClipTask};')(localAgentError, normalizeWorkspacePath);
const minimal = normalizeMediaClipInput({path:'source.webm',outputFormat:'mp3'});
assert.equal(minimal.outputFormat,'mp3');assert.equal(minimal.cutMode,undefined);
assert.equal(minimal.outputKind,undefined);assert.equal(minimal.outputDir,'clips');
assert.equal(normalizeMediaClipInput({path:'source.mp4',outputFormat:' MP3 '}).outputFormat,'mp3');
for (const args of [{path:'source.mp4'}, {path:'source.mp4',outputKind:'audio'},
 {path:'source.mp4',outputFormat:'../mp3'}, {path:'source.mp4',outputFormat:'mp3',audioBitrate:'0'},
 {path:'source.mp4',outputFormat:'mp3',cutMode:'copy',audioCodec:'mp3'},
 {path:'source.mp4',outputFormat:'mp3',includeAudio:false,audioStreamIndex:1}]) {
 assert.throws(()=>normalizeMediaClipInput(args), error=>error.code==='MEDIA_CLIP_INVALID');
}
const segmentInput = normalizeMediaClipInput({path:'source.mp4',outputFormat:'mp4',segments:[{startSeconds:8,endSeconds:9},{startSeconds:1,endSeconds:2}],videoCodec:'libx264',audioBitrate:'192k'});
assert.equal(segmentInput.segments[0].startSeconds,8);assert.equal(segmentInput.audioBitrate,'192k');
const clip={index:0,sourcePath:'source.webm',outputKind:'audio',startSeconds:0,endSeconds:3,durationSeconds:3,
 selectedVideoStreamIndex:null,selectedAudioStreamIndex:1,hasAudio:true,reencoded:true,format:'mp3',mimeType:'audio/mpeg',fileSizeBytes:100,workspacePath:'clips/result.mp3',privatePath:'/secret'};
const native={taskId:'clip_123',sourcePath:'source.webm',outputFormat:'mp3',cutMode:'accurate',status:'completed',phase:'completed',statusMessage:'done',progressPercent:100,completedClips:1,totalClips:1,clips:[clip],createdAt:'now',lastUpdatedAt:'now',pollIntervalMs:1000};
const normalized=normalizeMediaClipTask(native,minimal);assert.equal(normalized.outputFormat,'mp3');
assert.equal(normalized.clips[0].outputKind,'audio');assert.equal(normalized.clips[0].privatePath,undefined);
assert.throws(()=>normalizeMediaClipTask({...native,outputFormat:'wav'},minimal),error=>error.code==='AGENT_INVALID_RESPONSE');
assert.throws(()=>normalizeMediaClipTask({...native,clips:[{...clip,format:'wav'}]},minimal),error=>error.code==='AGENT_INVALID_RESPONSE');
const copying = normalizeMediaClipInput({path:'source.webm',segments:[{startSeconds:0,endSeconds:1}]});
assert.equal(copying.outputFormat,undefined);assert.equal(copying.cutMode,undefined);
assert.equal(normalizeMediaClipTask({...native,outputFormat:null,cutMode:'copy',status:'working',phase:'preparing',progressPercent:0,completedClips:0,clips:[]},copying).outputFormat,null);
assert.equal(normalizeMediaClipTask({...native,outputFormat:'webm',cutMode:'copy',clips:[{...clip,format:'webm',reencoded:false}]},copying).clips[0].reencoded,false);
assert.throws(()=>normalizeMediaClipInput({...copying,audioBitrate:'192k'}),error=>error.code==='MEDIA_CLIP_INVALID');

assert.equal(normalizeMediaClipTask({...native,cutMode:"copy",clips:[{...clip,reencoded:false}]},minimal).clips[0].reencoded,false);
assert.equal(normalizeMediaClipInput({path:"source.mp4",outputFormat:"webm",videoCodec:"libvpx-vp9"}).videoCodec,"libvpx-vp9");
console.log("media clip tool: ok");
