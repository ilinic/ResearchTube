import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageFixture } from './fixtures/chat-composer-page.mjs';
import { resolveChatComposer, chatComposerPageExpression, chatComposerAttachmentNamesMatch, inspectChatComposer, clickChatComposerAttachmentRemoval, resetChatComposerFileInputs, installChatComposerGuard, readChatComposerGuard, disposeChatComposerGuard, authorizeChatComposerText } from '../chat-composer.js';

const page = pageFixture();
let snapshot = page.run(inspectChatComposer);
assert.equal(snapshot.found, true);
assert.equal(snapshot.textEmpty, true);
assert.equal(snapshot.attachments.length, 0, 'files in previous messages must not count as Composer attachments');
assert.equal(snapshot.selectedFiles.length, 0);
page.composer.innerText = 'user draft';
page.input.files = [{ name: 'draft.pdf', size: 123, lastModified: 5 }];
page.button('Remove file', 'draft.pdf');
page.button('Remove image', 'photo.png');
page.button('Remove file', 'hidden.pdf', { hidden: true });
page.button('Send', '');
page.button('Delete conversation', '');
snapshot = page.run(inspectChatComposer);
assert.equal(snapshot.textEmpty, false);
assert.deepEqual(JSON.parse(JSON.stringify(snapshot.selectedFiles)), [{ name: 'draft.pdf', size: 123, lastModified: 5 }]);
assert.equal(snapshot.attachments.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(snapshot.removeTargets[0])), { x: 20, y: 30, enabled: true });
page.document.querySelectorAll = () => [];
assert.equal(page.run(inspectChatComposer).found, false);
page.document.querySelectorAll = (selector) => selector === 'input[type="file"]' ? [page.input, page.historicalInput] : [page.composer];

assert.equal(page.run(installChatComposerGuard, ['output.pdf'], 'task-one', inspectChatComposer), true);
page.input.files = [{ name: 'output.pdf' }];
page.event('change', page.input);
assert.equal(page.run(readChatComposerGuard, 'task-one').changed, false, 'native task file selection is allowed once');
page.event('click', page.button('Send', ''));
page.event('input', { root: {} });
page.event('change', page.historicalInput);
assert.equal(page.run(readChatComposerGuard, 'task-one').changed, false);
page.event('beforeinput', page.composer);
page.composer.innerText = ''; // deleting the text again does not undo the edit signal
assert.equal(page.run(readChatComposerGuard, 'task-one').changed, true);
assert.equal(page.run(readChatComposerGuard, 'another-task').present, false);
page.run(disposeChatComposerGuard, 'task-one');
assert.ok([...page.listeners.values()].every((listeners) => listeners.size === 0));

for (const type of ['change', 'drop', 'paste', 'click']) {
  page.run(installChatComposerGuard, ['output.pdf'], type);
  page.input.files = [{ name: 'output.pdf' }];
  page.event('change', page.input);
  if (type === 'change') {
    page.input.files = [{ name: 'user.pdf' }]; page.event('change', page.input);
  } else if (type === 'drop') page.event('drop', page.composer, { dataTransfer: { files: [{}] } });
  else if (type === 'paste') page.event('paste', page.composer, { clipboardData: { files: [{}] } });
  else page.event('click', page.button('Remove file', 'output.pdf'));
  assert.equal(page.run(readChatComposerGuard, type).changed, true, `user ${type} must stop Send`);
}
// Installing another monitor replaces old handlers rather than accumulating them.
page.run(installChatComposerGuard, ['output.pdf'], 'replacement');
assert.ok([...page.listeners.values()].every((listeners) => listeners.size === 1));
page.run(disposeChatComposerGuard, 'replacement');
assert.ok([...page.listeners.values()].every((listeners) => listeners.size === 0));
// React replacing the draft DOM must not detach the protection from user input.
page.run(installChatComposerGuard, ['output.pdf'], 'react-remount');
const replacement = pageFixture();
page.document.querySelectorAll = (selector) => selector === 'input[type="file"]' ? [page.input] : [replacement.composer];
page.event('input', replacement.composer);
assert.equal(page.run(readChatComposerGuard, 'react-remount').changed, true);
page.run(disposeChatComposerGuard, 'react-remount');
console.log('Chat Composer: scoped attachments, text, user editing guard and cleanup passed');

// Current preview markup: an unlabelled X beside an HTTPS thumbnail.
const imagePage = pageFixture();
const close = imagePage.button('', 'photo.png', { imageSrc: 'https://example.test/thumbnail', iconPath: 'M6 6L18 18M6 18L18 6' });
imagePage.button('Edit image', 'photo.png', { imageSrc: 'blob:other-preview' });
imagePage.button('', '', { iconPath: 'M6 6L18 18M6 18L18 6' }); // toolbar X is not an attachment
const imageState = imagePage.run(inspectChatComposer);
assert.equal(imageState.attachments.length, 2);
assert.equal(imageState.previewCount, 2, 'each image card must count once');
assert.equal(imageState.removeTargets.length, 1, 'edit buttons and toolbar X must not be clicked');
imagePage.run(installChatComposerGuard, ['photo.png'], 'unlabelled-close', inspectChatComposer);
imagePage.event('click', close);
assert.equal(imagePage.run(readChatComposerGuard, 'unlabelled-close').changed, true);
imagePage.run(disposeChatComposerGuard, 'unlabelled-close');
const filenamePage = pageFixture();
filenamePage.button('Remove photo.png', 'photo.png', { imageSrc: 'blob:photo' });
assert.equal(filenamePage.run(inspectChatComposer).removeTargets.length, 1);
const tooltipPage = pageFixture();
tooltipPage.button('', 'photo.png', { imageSrc: 'blob:photo', tooltip: 'Remove attachment' });
assert.equal(tooltipPage.run(inspectChatComposer).removeTargets.length, 1);
const hoverPage = pageFixture();
hoverPage.button('', 'photo.png', { imageSrc: 'blob:photo', hidden: true, iconPath: 'M18 6 6 18M6 6l12 12' });
const hoverState = hoverPage.run(inspectChatComposer);
assert.equal(hoverState.previewCount, 1);
assert.equal(hoverState.removeTargets.length, 0);
assert.equal(hoverState.hoverTargets.length, 1);
hoverPage.input.value = 'native selection';
assert.equal(hoverPage.run(resetChatComposerFileInputs), true);
assert.equal(hoverPage.input.value, '');
assert.equal(hoverPage.historicalInput.value, undefined, 'history form inputs stay untouched');
console.log('Chat Composer: unlabelled preview X, tooltip/filename labels, hover and input reset passed');

// Reported markup: image + Word card, both with Remove <filename>, hidden by pointer/opacity CSS.
const mixed = pageFixture();
const imageRemove = mixed.button('Remove photo.png', 'photo.png', {imageSrc:'data:image/png;base64,AA==',markedCard:true,pointerBlocked:true});
const documentRemove = mixed.button('Remove Report.docx', 'Report.docx', {markedCard:true,pointerBlocked:true});
mixed.button('Report.docx', 'Report.docx'); // opening the document is not removal
let mixedState = mixed.run(inspectChatComposer);
assert.equal(mixedState.previewCount,2,'documents without image thumbnails must also count');
assert.equal(mixedState.removeTargets.length,2);
assert.ok(mixedState.removeTargets.every(target=>!target.enabled),'opacity-0 / pointer-events-none must force hover');
assert.equal(mixedState.hoverTargets.length,2);
imageRemove.pointerBlocked=false;documentRemove.pointerBlocked=false;
mixedState=mixed.run(inspectChatComposer);
assert.ok(mixedState.removeTargets.every(target=>target.enabled));
console.log('Chat Composer: reported image/document cards, Remove filename and hover-only controls passed');
// A document-opening overlay must not be mistaken for removal when its filename starts with Remove.
const tricky = pageFixture();
const open = tricky.button('Remove report.docx', 'Remove report.docx', {markedCard:true});
open.matches = selector => selector === '.composer-attachment-surface';
tricky.button('Remove Remove report.docx', 'Remove report.docx', {markedCard:true});
assert.equal(tricky.run(inspectChatComposer).removeTargets.length,1);

// A hidden legacy #prompt-textarea must never win over the actual rich editor.
const legacy = pageFixture();
const hidden = { ...legacy.composer, tagName: 'TEXTAREA', value: '', getAttribute: () => '', rich: false,
  getBoundingClientRect: () => ({left:0,top:0,width:0,height:0}) };
legacy.document.querySelector = () => hidden; // the old implementation would select this
legacy.document.querySelectorAll = selector => selector === 'input[type="file"]' ? [legacy.input] : [hidden, legacy.composer];
legacy.composer.innerText = 'actual user draft';
legacy.button('Remove manual.mp3','manual.mp3',{markedCard:true});
assert.equal(legacy.run(inspectChatComposer).textEmpty,false);
assert.equal(legacy.run(inspectChatComposer).attachments[0].name,'manual.mp3');
// Current data-composer-body can work even when the fragment has no outer form.
legacy.composer.closest = selector => selector === '[data-composer-body]' ? legacy.root : null;
assert.equal(legacy.run(inspectChatComposer).found,true);
assert.equal(legacy.run(installChatComposerGuard,['photo.jpg'],'body',inspectChatComposer),true);
legacy.event('input',legacy.composer);
assert.equal(legacy.run(readChatComposerGuard,'body').changed,true);
// Wrapper and nested preview, or multiple controls, still represent one card.
const nested = pageFixture();
const control = nested.button('Remove photo.jpg','photo.jpg',{markedCard:true,imageSrc:'blob:photo'});
const outer = control.parentElement;
const inner = {...outer, parentElement:outer, contains:target=>target===nested.root.images[0]};
const contains = outer.contains;
outer.contains = target=>target===inner || contains(target);
nested.root.cards.push(inner);
assert.equal(nested.run(inspectChatComposer).attachments.length,1);
assert.equal(nested.run(inspectChatComposer).previewCount,1);
// A document card remains evidence while its removal control is not rendered.
nested.root.controls=[];
assert.equal(nested.run(inspectChatComposer).attachments.length,1);
const second = {...legacy.composer};
legacy.document.querySelectorAll = selector => selector === 'input[type="file"]' ? [] : [legacy.composer,second];
assert.equal(legacy.run(inspectChatComposer).found,false,'multiple visible rich editors must stop automation');
console.log('Chat Composer: hidden legacy editor, body scope, unique cards and ambiguous editor regression passed');

// Supplied 2026-10-06 markup: a role=button preview owns a labelled native
// Remove button that stays opacity-0/pointer-events-none without group hover.
const labelled = pageFixture();
const labelledClose = labelled.button('Remove manual-photo.png','manual-photo.png',{
  markedCard:true,imageSrc:'data:image/png;base64,AA==',pointerBlocked:true
});
let labelledClicks=0;
labelledClose.parentElement.getAttribute=name=>name==='aria-label'?'manual-photo.png':'';
labelledClose.click=()=>labelledClicks++;
assert.equal(labelled.run(inspectChatComposer).removeTargets[0].enabled,false);
assert.equal(labelled.run(clickChatComposerAttachmentRemoval,['different.png']).clicked,false);
assert.equal(labelledClicks,0,'clear must target only initial, explicitly named attachments');
assert.equal(labelled.run(clickChatComposerAttachmentRemoval,['manual-photo.png']).clicked,true);
assert.equal(labelledClicks,1,'a labelled React click must not depend on hover opacity');
labelledClose.disabled=true;
assert.equal(labelled.run(clickChatComposerAttachmentRemoval,['manual-photo.png']).clicked,false);
labelledClose.disabled=false;
labelled.composer.innerText='a new user draft';
assert.equal(labelled.run(clickChatComposerAttachmentRemoval,['manual-photo.png']).reason,'draftNotEmpty');
assert.equal(labelledClicks,1);
labelled.composer.innerText='';
labelledClose.matches=()=>true; // preview opener, not its removal button
assert.equal(labelled.run(clickChatComposerAttachmentRemoval,['manual-photo.png']).clicked,false);
labelledClose.matches=()=>false;
labelledClose.parentElement.getAttribute=name=>name==='aria-label'?'another-file.png':'';
assert.equal(labelled.run(clickChatComposerAttachmentRemoval,['manual-photo.png']).clicked,false);
assert.equal(labelledClicks,1,'disabled, draft, opener and mismatched-card cases must never click');
const foreign=labelled.button('Remove manual-photo.png','manual-photo.png',{markedCard:true});
foreign.click=()=>{throw new Error('foreign Composer clicked');};
foreign.parentElement.root={};
assert.equal(labelled.run(clickChatComposerAttachmentRemoval,['manual-photo.png']).clicked,false);
console.log('Chat Composer: labelled hidden removal, initial-name restriction and scoped refusal passed');

// Removal is file-type agnostic and uses names from the actual initial cards.
const everyType=pageFixture();
const initialNames=['photo.png','Meeting notes.docx','voice.mp3','bundle.zip'];
for(const name of initialNames) {
 const button=everyType.button(`Remove ${name}`,name,{markedCard:true,pointerBlocked:true});
 button.click=()=>{
  everyType.root.cards=everyType.root.cards.filter(card=>card!==button.parentElement);
  everyType.root.controls=everyType.root.controls.filter(control=>control!==button);
 };
}
for(let index=0;index<initialNames.length;index++) {
 const before=everyType.run(inspectChatComposer);
 assert.equal(everyType.run(clickChatComposerAttachmentRemoval,initialNames).clicked,true);
 assert.equal(everyType.run(inspectChatComposer).previewCount,before.previewCount-1);
}
assert.equal(everyType.run(inspectChatComposer).attachments.length,0);
assert.equal(everyType.run(clickChatComposerAttachmentRemoval,initialNames).clicked,false);
console.log('Chat Composer: mixed image/document/audio/archive removal uses dynamic filenames');

// Reported delay regression: one accepted image is later renamed by the host.
const matchNames = chatComposerAttachmentNamesMatch;
assert.equal(matchNames(['test-crop(20261006-120344).jpg'], ['test-crop.jpg']), true);
assert.equal(matchNames(['photo(20261006-120344).jpg'], ['photo.jpg'], false), false, 'native FileList names remain exact');
assert.equal(matchNames(['notes(20261006-120344).docx', 'photo.jpg'], ['photo.jpg', 'notes.docx']), true);
assert.equal(matchNames(['notes.v2(20261006-120344).docx'], ['notes.v2.docx']), true);
assert.equal(matchNames(['README(20261006-120344)'], ['README']), true);
assert.equal(matchNames(['a(20261006-120344).jpg', 'a.jpg'], ['a.jpg', 'a(20261006-120344).jpg']), true);
assert.equal(matchNames(['a(20261006-120344)(20261006-120445).jpg'], ['a(20261006-120344).jpg']), true);
for (const actual of ['test-crop(1).jpg', 'test-crop-other.jpg', 'test-crop(20261006-120344).png',
  'test-crop(20261306-120344).jpg', 'test-crop(20260230-120344).jpg', 'test-crop(20261006-240344).jpg',
  'test-crop(20261006-120344)(1).jpg', 'test-crop(20261006-120344)extra.jpg', 'test-crop(20261006-120344).JPG']) {
  assert.equal(matchNames([actual], ['test-crop.jpg']), false, actual);
}
assert.equal(matchNames(['test-crop.jpg'], ['test-crop(20261006-120344).jpg']), false, 'never strip the original timestamp');
assert.equal(matchNames(['report.jpg', 'report.jpg'], ['report.jpg', 'other.jpg']), false, 'one-to-one multiset matching');
assert.equal(matchNames(['report.jpg', 'other.jpg'], ['report.jpg']), false);
assert.equal(matchNames([null], ['report.jpg']), false);
console.log('Chat Composer: exact and host timestamp names, batch multiplicity and strict mismatch refusal passed');

// A Browser Agent continuation is the one explicitly authorized insertion.
// User edits before, during and after it still block Send; the guard is not reset.
const continuationPage = pageFixture();
continuationPage.run(installChatComposerGuard, ['image.png'], 'browser-continuation', inspectChatComposer);
assert.equal(continuationPage.run(authorizeChatComposerText, 'wrong', 'Continue study.'), false);
assert.equal(continuationPage.run(authorizeChatComposerText, 'browser-continuation', 'Continue study.'), true);
continuationPage.event('beforeinput', continuationPage.composer, {inputType:'insertText',data:'Continue study.'});
continuationPage.composer.innerText='Continue study.';
continuationPage.event('input', continuationPage.composer, {inputType:'insertText',data:'Continue study.'});
assert.equal(continuationPage.run(readChatComposerGuard,'browser-continuation').changed,false);
continuationPage.event('beforeinput', continuationPage.composer, {inputType:'insertText',data:'user edit'});
assert.equal(continuationPage.run(readChatComposerGuard,'browser-continuation').changed,true);
assert.equal(continuationPage.run(authorizeChatComposerText,'browser-continuation','Another continuation'),false);
const interfering = pageFixture();
interfering.run(installChatComposerGuard, ['image.png'], 'interfering', inspectChatComposer);
interfering.run(authorizeChatComposerText,'interfering','Continue study.');
interfering.event('beforeinput',interfering.composer,{inputType:'insertText',data:'x'});
assert.equal(interfering.run(readChatComposerGuard,'interfering').changed,true,'user input during authorized window is not masked');
console.log('Chat Composer: a single guarded Browser Agent continuation preserves user-edit protection');
