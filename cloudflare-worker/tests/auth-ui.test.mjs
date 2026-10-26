import vm from 'node:vm';
import { afterEach, expect, test, vi } from 'vitest';
import { authScript } from '../src/pages.ts';

afterEach(() => vi.useRealTimers());
async function ui(fetch, search = '', page = 'sign-in') {
  const button = { disabled: false, dataset: { provider: 'google' } };
  const status = { textContent: '' }, requests = [], destinations = [];
  const elements = { status };
  const context = vm.createContext({
    document: { body: { dataset: { page } }, getElementById: id => elements[id] || null, querySelectorAll: () => [button] },
    location: { origin: 'https://rt.test', search, assign: url => destinations.push(url) },
    fetch: (path, options) => { requests.push({ path, ...options, body: JSON.parse(options.body) }); return fetch(path, options); },
    URL, URLSearchParams, AbortController, Error, TypeError, setTimeout, clearTimeout
  });
  vm.runInContext(await authScript().text(), context);
  return { button, status, requests, destinations };
}
test('Google click obtains a JSON redirect before navigating, preserving OAuth continuation', async () => {
  const view = await ui(async () => Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test' }), '?client_id=test&sig=signed');
  await view.button.onclick();
  expect(view.requests).toHaveLength(1);
  expect(view.requests[0]).toMatchObject({ path: '/api/auth/sign-in/social', redirect: 'error', credentials: 'same-origin',
    body: { provider: 'google', disableRedirect: true, callbackURL: 'https://rt.test/api/auth/oauth2/authorize?client_id=test&sig=signed' } });
  expect(view.destinations).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=test']);
});
test('extension sign-in resumes only the fixed enrollment route with its nonce', async () => {
  const query = '?extensionId=' + 'a'.repeat(32) + '&nonce=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const view = await ui(async () => Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }), query, 'setup');
  await view.button.onclick();
  expect(view.requests[0].body.callbackURL).toBe('https://rt.test/setup' + query);
});
test.each([
  [() => Response.json({}), 'did not return'],
  [() => Response.json({ url: 'javascript:alert(1)' }), 'invalid redirect'],
  [() => new Response('<html>private upstream error</html>', { status: 502 }), 'HTTP 502'],
  [() => Response.json({ error: { code: 'AUTH_TIMEOUT', message: 'secret private body' } }, { status: 503 }), 'AUTH_TIMEOUT']
])('failed sign-in restores the button and exposes only safe diagnostics', async (response, message) => {
  const view = await ui(async () => response());
  await view.button.onclick();
  expect(view.button.disabled).toBe(false);
  expect(view.destinations).toEqual([]);
  expect(view.status.textContent).toContain(message);
  expect(view.status.textContent).not.toContain('private');
});
test('a hung HTTP request times out, is aborted and is never automatically repeated', async () => {
  vi.useFakeTimers();
  const view = await ui(() => new Promise(() => {}));
  const click = view.button.onclick();
  expect(view.button.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(25_000);
  await click;
  expect(view.button.disabled).toBe(false);
  expect(view.requests[0].signal.aborted).toBe(true);
  expect(view.requests).toHaveLength(1);
  expect(view.status.textContent).toContain('timed out');
});
test('the same deadline covers a hung response body', async () => {
  vi.useFakeTimers();
  const view = await ui(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  const click = view.button.onclick();
  await vi.advanceTimersByTimeAsync(25_000);
  await click;
  expect(view.button.disabled).toBe(false);
  expect(view.status.textContent).toContain('timed out');
});
