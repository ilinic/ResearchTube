// Runs in the ChatGPT page through CDP. Keep inspection scoped to the Composer.
export function inspectChatComposer() {
  const composer = document.querySelector('#prompt-textarea')
    || document.querySelector('[contenteditable="true"][role="textbox"]')
    || document.querySelector('textarea');
  const root = composer?.closest('form');
  if (!root) return { found: false, textEmpty: false, attachments: [], selectedFiles: [], removeTargets: [] };
  const visible = (element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const removalButtons = [...root.querySelectorAll('button, [role="button"]')].filter((element) => {
    const labels = ['aria-label', 'title', 'data-testid'].map((name) => element.getAttribute(name) || '').join(' ').trim();
    return visible(element) && /(?:\b(?:remove|delete)\b|удалить)/i.test(labels)
      && (/(?:\b(?:files?|attachments?|images?|uploads?)\b|файл|вложени|изображени)/i.test(labels) || /^(?:remove|delete|удалить)\s*$/i.test(labels));
  });
  const selectedFiles = [...document.querySelectorAll('input[type="file"]')]
    .filter((input) => !input.closest('form') || input.closest('form') === root)
    .flatMap((input) => [...(input.files || [])].map((file) => ({ name: file.name, size: file.size, lastModified: file.lastModified })));
  const attachments = removalButtons.map((button) => {
    const card = button.closest('[data-file-id], [data-testid*="attachment"], [data-testid*="file"], [data-testid*="image"]') || button.parentElement;
    const image = card?.querySelector('img');
    const text = [card?.innerText || '', button.getAttribute('aria-label') || '', button.getAttribute('title') || '', image?.getAttribute('alt') || ''].join(' ');
    return { text: text.slice(0, 500) };
  });
  const removeTargets = removalButtons.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2, enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true' };
  });
  // Unknown preview markup is evidence of a dirty Composer even without a remove control.
  const previewCount = [...root.querySelectorAll('img')].filter((image) => visible(image) && /^(?:blob:|data:)/i.test(image.getAttribute('src') || '')).length;
  const text = composer.value ?? composer.innerText ?? composer.textContent ?? '';
  return { found: true, textEmpty: String(text).trim() === '', attachments, selectedFiles, removeTargets, previewCount };
}

// Track user editing independently of the final text: typing then deleting still stops Send.
export function installChatComposerGuard(expectedNames, token) {
  const key = '__researchtubeChatComposerGuard';
  window[key]?.dispose?.();
  const composer = document.querySelector('#prompt-textarea')
    || document.querySelector('[contenteditable="true"][role="textbox"]')
    || document.querySelector('textarea');
  const root = composer?.closest('form');
  if (!root) return false;
  const expected = [...expectedNames].sort();
  const state = { token, changed: false, ownSelectionSeen: false };
  const listener = (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    // React can replace the Composer during upload; follow the current draft area.
    const liveComposer = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('textarea');
    const liveRoot = liveComposer?.closest('form');
    if (!liveRoot) { state.changed = true; return; }
    if (event.type === 'change' && target?.matches?.('input[type="file"]')) {
      if (target.closest('form') && target.closest('form') !== liveRoot) return;
      const names = [...(target.files || [])].map((file) => file.name).sort();
      const ownSelection = !state.ownSelectionSeen && names.length === expected.length && names.every((name, index) => name === expected[index]);
      if (ownSelection) state.ownSelectionSeen = true;
      else state.changed = true;
    } else if (liveRoot.contains(target)) {
      if (['beforeinput', 'input'].includes(event.type) && (target === liveComposer || liveComposer.contains(target))) state.changed = true;
      if (event.type === 'drop' && event.dataTransfer?.files?.length) state.changed = true;
      if (event.type === 'paste' && event.clipboardData?.files?.length) state.changed = true;
      if (event.type === 'click') {
        const button = target?.closest?.('button, [role="button"]');
        const label = ['aria-label', 'title', 'data-testid'].map((name) => button?.getAttribute(name) || '').join(' ');
        if (/(?:\b(?:remove|delete)\b|удалить)/i.test(label)) state.changed = true;
      }
    }
  };
  const types = ['beforeinput', 'input', 'change', 'drop', 'paste', 'click'];
  for (const type of types) document.addEventListener(type, listener, true);
  state.dispose = () => {
    for (const type of types) document.removeEventListener(type, listener, true);
    if (window[key] === state) delete window[key];
  };
  window[key] = state;
  return true;
}

export function readChatComposerGuard(token) {
  const state = window.__researchtubeChatComposerGuard;
  return state?.token === token ? { present: true, changed: state.changed } : { present: false, changed: true };
}

export function disposeChatComposerGuard(token) {
  const state = window.__researchtubeChatComposerGuard;
  if (state?.token === token) state.dispose();
  return true;
}
