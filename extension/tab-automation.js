// A shared queue for all automation touching a physical tab. Different tabs
// proceed independently; rejected work never poisons the next operation.
export function createTabAutomationQueue() {
  const tails = new Map();
  function run(tabId, work) {
    const pending = (tails.get(tabId) || Promise.resolve()).catch(() => {}).then(work);
    const tail = pending.catch(() => {});
    tails.set(tabId, tail);
    void tail.then(() => { if (tails.get(tabId) === tail) tails.delete(tabId); });
    return pending;
  }
  return { run };
}

// Browser pages retain a connection; short Composer/file operations borrow it.
// A borrower must never detach another operation's live connection.
export function createDebuggerLeases(host) {
  const leases = new Map();
  const transitions = createTabAutomationQueue();
  const attach = tabId => transitions.run(tabId, async () => {
    const previous = leases.get(tabId);
    if (previous) { previous.count++; return; }
    const lease = { count: 1 };
    leases.set(tabId, lease);
    try { await host.attach(tabId); }
    catch (error) { if (leases.get(tabId) === lease) leases.delete(tabId); throw error; }
  });
  const detach = tabId => transitions.run(tabId, async () => {
    const lease = leases.get(tabId);
    if (!lease || --lease.count > 0) return;
    try { await host.detach(tabId); }
    finally { if (leases.get(tabId) === lease) leases.delete(tabId); }
  });
  function lost(tabId) { leases.delete(tabId); }
  return { attach, detach, lost, has: tabId => leases.has(tabId) };
}
