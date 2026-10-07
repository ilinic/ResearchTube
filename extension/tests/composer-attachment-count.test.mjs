import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { waitForComposerMedia } from '../composer-media-retry.js';
import { pageFixture } from './fixtures/chat-composer-page.mjs';
import { resolveChatComposer, inspectChatComposer, chatComposerPageExpression, readChatComposerGuard } from '../chat-composer.js';

const policy = { retryCount: 15, retryIntervalSeconds: 2 };
const section = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
};
for (const path of ['../background.js', '../dist/background.js']) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  new vm.Script(source.replace(/^import .*?;\r?\n/gm, ''));
  const expressionContext = vm.createContext({ resolveChatComposer, inspectChatComposer });
  vm.runInContext(section(source, 'function cdpAttachmentStateExpression(', '\nasync function cdpWaitForAttachmentAccepted('), expressionContext);
  const names = ['one.jpg', 'two.jpg', 'three.jpg', 'four.jpg'];
  const page = pageFixture();
  for (let index = 0; index < 4; index++) page.button('Remove image', '', { markedCard: true, imageSrc: 'blob:' + index });
  const expression = expressionContext.cdpAttachmentStateExpression(names);
  for (const name of names) assert.ok(!expression.includes(name), 'filename must not be serialized into count verification');
  const evaluate = () => vm.runInContext(expression, page.context);
  assert.equal(evaluate().accepted, true, 'four unnamed images are enough');
  assert.equal(evaluate().attachmentCount, 4);
  page.input.files = [{ name: 'an unrelated filename.docx' }];
  assert.equal(evaluate().accepted, true, 'native FileList and names do not affect acceptance');
  page.root.images = []; page.root.cards = []; page.root.controls = [];
  for (let index = 0; index < 4; index++) page.button('Remove arbitrary-name-' + index, 'arbitrary-name-' + index, { markedCard: true });
  assert.equal(evaluate().accepted, true, 'same-count replacements and different types are allowed');
  page.root.cards.pop(); page.root.controls.pop();
  assert.equal(evaluate().accepted, false, 'three cards cannot confirm four files');
  page.root.cards = []; page.root.controls = [];
  page.input.files = names.map(name => ({ name }));
  assert.equal(evaluate().accepted, false, 'a populated FileList is not proof of visible attachments');

  const helpers = section(source, 'async function currentChatComposerState(', '\nasync function prepareCurrentChatComposer(');
  async function scenario({ readyAt = 0, unavailableUntil = 0, extra = false, mutation = null } = {}) {
    let now = 0, reads = 0, sent = 0, cancelled = false, closed = false, guardChanged = false;
    const state = { found: true, textEmpty: true, attachments: [{ name: null, text: '' }], selectedFiles: [], removeTargets: [], previewCount: 1 };
    const logs = [];
    const context = vm.createContext({
      waitForComposerMedia, resolveChatComposer, inspectChatComposer, chatComposerPageExpression, readChatComposerGuard,
      composerVisibleAttachmentCount: state => Math.max(state.attachments.length, state.previewCount || 0),
      composerAttachmentCount: state => Math.max(state.attachments.length, state.selectedFiles.length, state.previewCount || 0),
      configuredComposerMediaRetry: async () => policy,
      normalizeComposerTextForComparison: text => String(text).replace(/\s+/g, ' ').trim(),
      requireCurrentChatTarget: async target => {
        assert.equal(target.tabId, 42);
        if (closed) throw Object.assign(new Error('target closed'), { code: 'MEDIA_TO_CHAT_TARGET_NOT_FOUND' });
      },
      localAgentError: (code, message) => Object.assign(new Error(message), { code }),
      cdpLog: (step, detail) => logs.push({ step, detail }),
      cdpEvaluate: async (_tabId, expression) => {
        if (expression.includes('function readChatComposerGuard')) return { value: { present: true, changed: guardChanged } };
        if (expression.includes('function inspectChatComposer')) {
          reads++;
          state.found = now >= unavailableUntil;
          state.attachments = now < readyAt ? [] : Array.from({ length: extra ? 2 : 1 }, () => ({ name: null, text: '' }));
          state.previewCount = state.attachments.length;
          return { value: state };
        }
        throw new Error('Unexpected evaluation');
      },
      sleep: async ms => {
        now += ms;
        if (now >= 4000) {
          if (mutation === 'cancel') cancelled = true;
          if (mutation === 'close') closed = true;
          if (mutation === 'text') { guardChanged = true; state.textEmpty = false; }
        }
      }
    });
    vm.runInContext(helpers, context);
    const work = (async () => {
      await context.assertCurrentChatComposer({ tabId: 42 }, {
        fileNames: ['expected-name.jpg'], guardToken: 'token', retryPolicy: policy,
        checkCancelled: () => { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'MEDIA_TO_CHAT_CANCELLED' }); }
      });
      sent++;
    })();
    if (readyAt === Infinity || extra) {
      await assert.rejects(work, error => error.code === 'MEDIA_TO_CHAT_TIMEOUT');
      assert.equal(now, 30000);
      assert.equal(reads, 16);
      assert.equal(sent, 0);
    } else if (mutation) {
      await assert.rejects(work);
      assert.equal(now, 4000, 'cancel, target closure and text edits interrupt polling');
      assert.equal(sent, 0);
    } else {
      await work;
      assert.equal(now, Math.max(readyAt, unavailableUntil));
      assert.equal(sent, 1);
    }
    assert.ok(logs.every(({ detail }) => !('expectedNames' in detail) && !('cardNames' in detail)));
    return { now, reads, logs };
  }
  await scenario();
  await scenario({ readyAt: 28000 });
  await scenario({ readyAt: 30000 });
  await scenario({ unavailableUntil: 6000 });
  await scenario({ readyAt: Infinity });
  await scenario({ extra: true });
  for (const mutation of ['cancel', 'close', 'text']) await scenario({ readyAt: 28000, mutation });
}
console.log('Composer count: unnamed/mixed/replaced files, no filename serialization, no FileList shortcut, 15/2 retries, final-boundary success, unavailable Composer, exhaustion, cancellation, target closure and text edit: ok');
