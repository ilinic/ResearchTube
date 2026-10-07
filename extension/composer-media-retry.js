// Bound readiness/acknowledgement checks; the caller controls guarded Send retries.
// File insertion is never repeated by this polling helper.
export async function waitForComposerMedia(probe, policy, { stage, beforeCheck = async () => {}, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => performance.now(), busyTimeoutMs = 300000 } = {}) {
  const started = now(); let retries = 0;
  for (;;) {
    await beforeCheck();
    const state = await probe();
    if (state?.ready) { log("Composer media condition confirmed", { stage, retries, elapsedMs: Math.round(now() - started) }); return state; }
    if (state?.busy) {
      if (now() - started >= busyTimeoutMs) break;
    } else if (retries >= policy.retryCount) break;
    else retries++;
    log("Composer media condition pending", { stage, retries, maximumRetries: policy.retryCount, intervalSeconds: policy.retryIntervalSeconds, busy: Boolean(state?.busy), elapsedMs: Math.round(now() - started) });
    await sleep(policy.retryIntervalSeconds * 1000);
  }
  const error = new Error(`ChatGPT did not confirm ${stage} within the configured retry budget (${policy.retryCount} retries, ${policy.retryIntervalSeconds}s interval), or its response wait expired. Existing files and Composer contents were preserved.`);
  error.code = "MEDIA_TO_CHAT_TIMEOUT";
  throw error;
}
