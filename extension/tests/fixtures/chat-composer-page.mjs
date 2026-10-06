import vm from 'node:vm';
import { chatComposerPageExpression } from '../../chat-composer.js';

export function pageFixture() {
  const listeners = new Map();
  const root = {
    controls: [], images: [],
    cards: [],
    querySelectorAll(selector) { return selector === 'img' ? this.images : selector === 'button, [role="button"]' ? this.controls : this.cards; },
    contains(target) { return target === composer || target?.root === this; }
  };
  const composer = { rich: true, tagName: 'DIV', innerText: '', getAttribute: (name) => name === 'contenteditable' ? 'true' : '', matches: () => composer.rich, getBoundingClientRect: () => ({left:0,top:100,width:300,height:40}), closest: () => root, contains: () => false };
  const input = { root, files: [], closest: () => root, matches: (selector) => selector === 'input[type="file"]' };
  const historyForm = {};
  const historicalInput = { files: [{ name: 'old-history.pdf', size: 10 }], closest: () => historyForm };
  const historyRemove = { getAttribute: () => 'Remove file' };
  const document = {
    querySelector: () => composer,
    querySelectorAll: (selector) => selector === 'input[type="file"]' ? [input, historicalInput] : [composer],
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    getElementById() { return null; },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }
  };
  const window = { getSelection: () => ({
    toString: () => document.activeElement?.innerText || '',
    removeAllRanges() {}, addRange() { composer.selected = true; }
  }) };
  composer.focus = () => { document.activeElement = composer; };
  document.createRange = () => ({ selectNodeContents(target) { if (target !== composer) throw new Error('Wrong editor selected'); } });
  const context = vm.createContext({ document, window, getComputedStyle: (element) => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible', pointerEvents: element.pointerBlocked ? 'none' : 'auto', opacity: element.pointerBlocked ? '0' : '1' }) });
  const run = (fn, ...args) => vm.runInContext(chatComposerPageExpression(fn, ...args), context);
  const event = (type, target, extra = {}) => { for (const listener of listeners.get(type) || []) listener({ type, target, isTrusted: true, ...extra }); };
  const button = (label, fileName, { disabled = false, hidden = false, iconPath = null, imageSrc = null, tooltip = "", markedCard = false, pointerBlocked = false } = {}) => {
    const image = imageSrc ? { root, getAttribute: (name) => name === 'src' ? imageSrc : name === 'alt' ? fileName : '', getBoundingClientRect: () => ({left:0,top:0,width:80,height:80}), closest: () => null } : null;
    const card = { root, hidden: hidden && !imageSrc, innerText: fileName, parentElement: root, getAttribute: () => '', querySelector: (selector) => selector === 'img' ? image : null, contains: (target) => target === image || target?.parentElement === card, getBoundingClientRect: () => ({left:0,top:0,width:80,height:80}) };
    if (image) { image.parentElement = card; root.images.push(image); }
    const node = { root, tagName: 'BUTTON', disabled, hidden, pointerBlocked, parentElement: card,
      getAttribute: (name) => name === 'aria-label' ? label : name === 'data-tooltip-content' ? tooltip : '',
      querySelector: () => null, querySelectorAll: (selector) => selector === 'svg path' && iconPath ? [{getAttribute: () => iconPath}] : [],
      getBoundingClientRect: () => ({ left: 10 + root.controls.indexOf(node) * 25, top: 20, width: 20, height: 20 }),
      closest: (selector) => selector === 'button, [role="button"]' ? node : markedCard ? card : null };
    if (/^(Remove file|Remove image)$/.test(label)) markedCard = true;
    root.controls.push(node); if (markedCard) root.cards.push(card); return node;
  };
  return { root, composer, input, document, window, listeners, run, event, button, historicalInput, context };
}
