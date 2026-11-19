// Native DOM/file-input/CDP smoke test against an isolated local page, not ChatGPT.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RESEARCHTUBE_PLAYWRIGHT_MODULE || 'playwright');
const folder = await mkdtemp(join(tmpdir(), 'researchtube-composer-'));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.RESEARCHTUBE_BROWSER_CHANNEL || 'msedge', headless: true });
  const browserContext = await browser.newContext();
  await browserContext.route('**/*', route => route.abort());
  const page = await browserContext.newPage();
  await page.setContent(`<form><div data-composer-body>
    <div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div>
    <div data-composer-attachments></div><input type="file">
    <button type="submit" disabled>Send</button></div></form>`);
  await page.evaluate(() => {
    window.uploads = 0; window.submits = 0; window.trustedClicks = 0;
    const button = document.querySelector('button');
    button.addEventListener('click', event => { if (event.isTrusted) window.trustedClicks++; });
    document.querySelector('input').addEventListener('change', () => {
      window.uploads++;
      const card = document.createElement('div'); card.dataset.fileId = 'native-image';
      card.textContent = 'tiny.png'; card.style.cssText = 'width:80px;height:80px';
      document.querySelector('[data-composer-attachments]').append(card);
      // Longer than the entire configured dispatch retry budget below.
      setTimeout(() => { button.disabled = false; }, 900);
    });
    document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); window.submits++;
      if (window.submits === 1) return; // Exercise trusted pointer fallback.
      button.disabled = true;
      setTimeout(() => {
        document.querySelector('[data-composer-attachments]').replaceChildren();
        const message = document.createElement('div'); message.dataset.messageAuthorRole = 'user';
        message.dataset.messageId = 'native-send'; document.body.append(message);
      }, 150);
    });
  });
  const foreground = await browserContext.newPage(); await foreground.bringToFront();
  const cdp = await browserContext.newCDPSession(page);
  const event = { addListener() {} };
  const worker = vm.createContext({ URL, Intl, TextEncoder, TextDecoder, AbortController, crypto: webcrypto,
    performance, setTimeout, clearTimeout, console: { info() {} },
    chrome: { runtime: { getManifest: () => ({ version: 'native-test' }), id: 'test', getURL: p => p,
      onInstalled: event, onStartup: event, onMessage: event }, tabs: {}, alarms: { onAlarm: event } }
  });
  vm.runInContext(await readFile(new URL('../dist/background.js', import.meta.url), 'utf8'), worker);
  worker.cdpEvaluate = async (_id, expression) => {
    const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(response.exceptionDetails, undefined);
    return response.result;
  };
  worker.cdpCommand = (_id, method, params) => cdp.send(method, params);
  const policy = { retryCount: 10, retryIntervalSeconds: 0.05 };
  const file = join(folder, 'tiny.png');
  await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDecAAAAASUVORK5CYII=', 'base64'));
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await worker.cdpWaitForAttachmentAccepted(1, ['tiny.png'], policy);
  let commits = 0;
  await worker.cdpSendAttachedFiles(1, 1, { retryPolicy: policy, timeoutMs: 5000,
    beforeClick: async () => {
      const state = await worker.cdpReadMediaSubmissionState(1);
      assert.equal(state.found, true); assert.equal(state.attachments, 1);
    }, onSendCommit: () => { commits++; }
  });
  const result = await page.evaluate(() => ({ uploads, submits, trustedClicks,
    attachments: document.querySelectorAll('[data-file-id]').length,
    messages: document.querySelectorAll('[data-message-author-role="user"]').length }));
  assert.deepEqual(result, { uploads: 1, submits: 2, trustedClicks: 1, attachments: 0, messages: 1 });
  assert.equal(commits, 1);
  console.log('Native Chromium: delayed disabled Send, one file upload, form/pointer retries and one acknowledged message passed.');
} finally {
  await browser?.close();
  await rm(folder, { recursive: true, force: true });
}
