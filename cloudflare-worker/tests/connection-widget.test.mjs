import vm from 'node:vm';
import { expect, test } from 'vitest';
import { bindingWidget } from '../src/pages.ts';

test('connection proof starts immediately and completion updates model context without a status tool', () => {
  const nonce = 'b'.repeat(72), messages = [], states = [], listeners = {};
  const parent = { postMessage: value => messages.push(value) };
  const status = { textContent: '' };
  let intervals = 0;
  const context = {
    parent, Date, document: { getElementById: () => status },
    setInterval: () => { intervals++; return 1; }, clearInterval: () => { intervals--; },
    window: { parent, addEventListener: (type, callback) => { listeners[type] = callback; },
      openai: { toolResponseMetadata: { 'researchtube/cloudBinding': { nonce } }, setWidgetState: value => states.push(value) } }
  };
  vm.runInNewContext(bindingWidget().match(/<script>([\s\S]*)<\/script>/)[1], context);
  expect(messages.filter(value => value.source === 'researchtube-cloud-binding')).toHaveLength(1);
  expect(intervals).toBe(1);
  const result = { source: 'researchtube-cloud-binding', type: 'result', nonce, ok: true };
  listeners.message({ source: {}, data: result });
  expect(states).toHaveLength(0);
  listeners.message({ source: parent, data: result });
  expect(intervals).toBe(0);
  expect(states[0].modelContent).toContain('productive tool directly');
  expect(JSON.stringify(states)).not.toContain(nonce);
  expect(messages.some(value => value.method === 'tools/call')).toBe(false);
  expect(status.textContent).toBe('This Chrome chat is connected.');
});
