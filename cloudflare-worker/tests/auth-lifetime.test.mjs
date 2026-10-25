import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('better-auth', () => ({ betterAuth: vi.fn() }));
import { betterAuth } from 'better-auth';
import { createAuth } from '../src/auth.ts';
const env = { DB: {}, PUBLIC_ORIGIN: 'https://rt.test', EXTENSION_ORIGINS: '[]', BETTER_AUTH_SECRET: 'random-test-secret-12345678901234567890' };
const instance = (context = Promise.resolve({})) => ({ $context: context, handler: vi.fn(async () => Response.json({ ok: true })),
  api: { getSession: vi.fn(async () => null), verifyResearchTubeToken: vi.fn(async () => ({})) } });
beforeEach(() => betterAuth.mockReset());
afterEach(() => vi.useRealTimers());
test('initialization is awaited and each request gets its own auth instance', async () => {
  let resolve;
  betterAuth.mockReturnValueOnce(instance(new Promise(done => { resolve = done; }))).mockReturnValueOnce(instance());
  let ready = false;
  const pending = createAuth(env).then(auth => { ready = true; return auth; });
  await Promise.resolve(); expect(ready).toBe(false);
  resolve({});
  const first = await pending, second = await createAuth(env);
  expect(first).not.toBe(second);
  expect(betterAuth).toHaveBeenCalledTimes(2);
  expect(betterAuth.mock.calls[0][0].advanced.database.validateSchema).toBe(false);
});
test('a stranded initialization times out without poisoning the next request', async () => {
  vi.useFakeTimers();
  betterAuth.mockReturnValueOnce(instance(new Promise(() => {}))).mockReturnValueOnce(instance());
  const failure = expect(createAuth(env)).rejects.toMatchObject({ code: 'AUTH_TIMEOUT', status: 503 });
  await vi.advanceTimersByTimeAsync(20_000); await failure;
  expect(await createAuth(env)).toHaveProperty('handler');
});
test('initialization and endpoint work share one deadline and never retry', async () => {
  vi.useFakeTimers();
  let resolve;
  const auth = instance(new Promise(done => { resolve = done; }));
  auth.handler.mockImplementation(() => new Promise(() => {}));
  betterAuth.mockReturnValue(auth);
  const pending = createAuth(env);
  await vi.advanceTimersByTimeAsync(10_000); resolve({});
  const ready = await pending;
  const failure = expect(ready.handler(new Request('https://rt.test/api/auth/get-session'))).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(10_000); await failure;
  expect(auth.handler).toHaveBeenCalledTimes(1);
});
