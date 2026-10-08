// Generated from task-chat-page.js and shared Composer functions.
(() => {
function resolveChatComposer() {
  const candidates = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], #prompt-textarea, textarea')].filter((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity ?? '1') > 0 && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
      && (element.getAttribute('contenteditable') === 'true' || element.tagName === 'TEXTAREA');
  });
  const rich = candidates.filter((element) => element.matches('[data-composer-markdown], .ProseMirror'));
  const live = rich.length ? rich : candidates;
  // Ambiguity must stop automation; never guess which draft is the user's.
  if (live.length !== 1) return { composer: null, root: null, form: null };
  const composer = live[0];
  const form = composer.closest('form');
  const root = composer.closest('[data-composer-body]') || form;
  return root ? { composer, root, form } : { composer: null, root: null, form: null };
}

function inspectChatComposer() {
  const { composer, root, form } = resolveChatComposer();
  if (!root) return { found: false, textEmpty: false, attachments: [], selectedFiles: [], removeTargets: [], hoverTargets: [] };
  const visible = (element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const cardSelector = '[data-composer-attachments] [class~="group/composer-attachment"], [data-composer-attachments] .composer-attachment-surface[role="button"], [data-file-id], [data-testid*="attachment"]';
  const previewImages = [...root.querySelectorAll('img')].filter((image) => {
    if (!visible(image)) return false;
    const src = image.getAttribute('src') || '';
    const bounds = image.getBoundingClientRect();
    return /^(?:blob:|data:)/i.test(src) || /^https?:/i.test(src) && bounds.width >= 40 && bounds.height >= 40;
  });
  const attachmentCard = (button) => {
    const group = button.closest('[class~="group/composer-attachment"]');
    const marked = group && root.contains(group) ? group : button.closest(cardSelector);
    if (marked && marked !== root && root.contains(marked) && !marked.contains(composer)) return marked;
    // Preview close controls are often unlabelled siblings of an image wrapper.
    let parent = button.parentElement;
    for (let depth = 0; parent && parent !== root && depth < 5; depth++, parent = parent.parentElement) {
      if (parent.contains(composer)) break;
      if (previewImages.some((image) => parent.contains(image))) return parent;
    }
    return null;
  };
  const label = (button) => {
    const attributes = ['aria-label', 'title', 'data-testid', 'data-tooltip', 'data-tooltip-content'];
    const described = (button.getAttribute('aria-describedby') || '').split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '').join(' ');
    return [...attributes.map((name) => button.getAttribute(name) || ''), button.innerText || '', described].join(' ').trim();
  };
  const closeIcon = (button) => {
    if (/^(?:×|✕|✖|x)$/i.test((button.innerText || '').trim())) return true;
    if (button.querySelector('svg.lucide-x, svg[data-icon="x"], svg[data-icon="xmark"], use[href="#x"], use[href="#xmark"]')) return true;
    // Accept only a geometric two-stroke X, not arbitrary SVG icons in the toolbar.
    const segments = [...button.querySelectorAll('svg line')].map((line) =>
      ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name))));
    for (const path of button.querySelectorAll('svg path')) {
      const d = path.getAttribute('d') || '';
      if (/[^MmLl0-9.,+\-\s]/.test(d)) continue;
      const tokens = d.match(/[MmLl]|[-+]?(?:\d*\.\d+|\d+\.?\d*)/g) || [];
      let command = '', x = 0, y = 0;
      for (let index = 0; index < tokens.length;) {
        if (/^[MmLl]$/.test(tokens[index])) command = tokens[index++];
        if (!command || index + 1 >= tokens.length || /^[MmLl]$/.test(tokens[index]) || /^[MmLl]$/.test(tokens[index + 1])) break;
        let nx = Number(tokens[index++]), ny = Number(tokens[index++]);
        if (command === command.toLowerCase()) { nx += x; ny += y; }
        if (command.toLowerCase() === 'l') segments.push([x, y, nx, ny]);
        else command = command === 'm' ? 'l' : 'L';
        x = nx; y = ny;
      }
    }
    if (segments.length !== 2 || segments.some((points) => points.some((n) => !Number.isFinite(n)))) return false;
    const [a, b] = segments;
    const diagonal = ([x1, y1, x2, y2]) => Math.abs(x2 - x1) > 2 && Math.abs(Math.abs(x2 - x1) - Math.abs(y2 - y1)) < 1;
    return diagonal(a) && diagonal(b) && (a[2] - a[0]) * (a[3] - a[1]) * (b[2] - b[0]) * (b[3] - b[1]) < 0
      && Math.abs(a[0] + a[2] - b[0] - b[2]) < 1 && Math.abs(a[1] + a[3] - b[1] - b[3]) < 1;
  };
  const controls = [...root.querySelectorAll('button, [role="button"]')].map((button) => ({ button, card: attachmentCard(button), label: label(button) }));
  const removals = controls.filter(({ button, card, label: text }) => {
    // The preview itself can have role=button and a filename beginning with "Remove".
    if (button === card || button.matches?.('.composer-attachment-surface') || button.getAttribute('aria-haspopup') === 'dialog') return false;
    const remove = /(?:\b(?:remove|delete)\b|удалить)/i.test(text);
    const fileLabel = /(?:\b(?:files?|attachments?|images?|uploads?)\b|файл|вложени|изображени)/i.test(text);
    return remove && (fileLabel || /^(?:remove|delete|удалить)\s*$/i.test(text) || card)
      || card && button !== card && (/^(?:close|dismiss|cancel|закрыть)$/i.test(text) || closeIcon(button));
  });
  const selectedFiles = [...document.querySelectorAll('input[type="file"]')]
    .filter((input) => root.contains(input) || form && input.closest('form') === form || !input.closest('form'))
    .flatMap((input) => [...(input.files || [])].map((file) => ({ name: file.name, size: file.size, lastModified: file.lastModified })));
  const visibleRemovals = removals.filter(({ button }) => visible(button));
  const center = (element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  };
  const removeTargets = visibleRemovals.map(({ button }) => {
    const style = getComputedStyle(button);
    return { ...center(button), enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      && style.pointerEvents !== 'none' && Number(style.opacity ?? '1') > 0 };
  });
  const cards = new Set();
  const addCard = (card) => {
    if (!card || card === root || card.contains(composer) || !visible(card)) return;
    if (card.tagName === 'BUTTON' && !card.matches('.composer-attachment-surface')) return;
    if ([...cards].some((existing) => existing.contains(card))) return;
    for (const existing of cards) if (card.contains(existing)) cards.delete(existing);
    cards.add(card);
  };
  // A PDF/audio/document card can have no thumbnail and no visible close button.
  for (const card of root.querySelectorAll(cardSelector)) addCard(card);
  for (const { card } of removals) addCard(card);
  for (const image of previewImages) addCard(image.closest('[class~="group/composer-attachment"]') || image.closest(cardSelector) || image.parentElement);
  const attachments = [...cards].map((card) => {
    const removal = removals.find((item) => card.contains(item.button));
    const image = card.querySelector('img');
    const opener = card.querySelector('[aria-haspopup="dialog"], button.composer-attachment-surface[aria-label]');
    const removalName = (removal?.button.getAttribute('aria-label') || '').replace(/^(?:remove|delete|удалить)\s+/i, '');
    const name = opener?.getAttribute('aria-label') || card.getAttribute('aria-label') || image?.getAttribute('alt')
      || (/^(?:remove|delete|удалить)\s+/i.test(removal?.button.getAttribute('aria-label') || '') ? removalName : null);
    return { name: name || null, text: [card.innerText || '', removal?.label || '', image?.getAttribute('alt') || ''].join(' ').slice(0, 500) };
  });
  const hoverTargets = [...cards].map(center);
  const previewCount = cards.size;
  const text = composer.value ?? composer.innerText ?? composer.textContent ?? '';
  return { found: true, textEmpty: String(text).trim() === '', textLength: String(text).length,
    editor: composer.tagName, scope: root === form ? 'form' : 'composerBody',
    attachments, selectedFiles, removeTargets, hoverTargets, previewCount };
}

function installComposerWatchdog(seconds, inspect) {
  const previous = window.__researchtubeComposerWatchdog;
  if (previous) { previous.seconds = seconds; return previous.read(); }
  let key = null, changedAt = performance.now(), revision = 0, suppressed = false, requesting = false, holds = 0;
  const state = { seconds };
  function read() {
    const { composer, root } = resolveChatComposer();
    const inspected = inspect();
    const text = composer ? String(composer.value ?? composer.innerText ?? composer.textContent ?? "") : "";
    const attachments = Math.max(inspected.attachments?.length || 0, inspected.previewCount || 0);
    const next = JSON.stringify([Boolean(composer), text, attachments]);
    if (next !== key) { key = next; revision++; changedAt = performance.now(); }
    if (!text.trim() && !attachments) suppressed = false;
    const send = root?.querySelector('button[type="submit"]');
    const generating = Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]'));
    return { found: Boolean(composer && root), text, attachments, revision, stableMs: performance.now() - changedAt,
      idle: !generating, sendEnabled: Boolean(send && !send.disabled && send.getAttribute("aria-disabled") !== "true"),
      blocked: holds > 0 || suppressed };
  }
  state.read = read;
  state.hold = () => { holds++; };
  state.release = preserve => { holds = Math.max(0, holds - 1); if (preserve) suppressed = true; };
  state.suppress = () => { suppressed = true; };
  const sample = () => {
    const value = read();
    if (requesting || value.blocked || !value.found || !value.idle || !value.sendEnabled || !value.text.trim() && !value.attachments || value.stableMs < state.seconds * 1000) return;
    requesting = true;
    chrome.runtime.sendMessage({ type: "researchtube_composer_watchdog", revision: value.revision }).then(reply => {
      // Ignore a response to a draft that has changed while the worker ran.
      if (reply?.sent && read().revision === value.revision) state.suppress();
    }).catch(() => {}).finally(() => { requesting = false; });
  };
  const timer = setInterval(sample, 1000);
  const input = event => {
    const { composer } = resolveChatComposer();
    if (event.isTrusted && composer && (event.target === composer || composer.contains(event.target))) suppressed = false;
    read();
  };
  document.addEventListener("input", input, true);
  document.addEventListener("change", input, true);
  state.dispose = () => { clearInterval(timer); document.removeEventListener("input", input, true); document.removeEventListener("change", input, true); delete window.__researchtubeComposerWatchdog; };
  window.__researchtubeComposerWatchdog = state;
  return read();
}

globalThis.__researchtubeInstallComposerWatchdog = seconds => installComposerWatchdog(seconds, inspectChatComposer);
})();
