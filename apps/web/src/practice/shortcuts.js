/**
 * shortcuts.js — which key press means what, during practice.
 *
 * Decides: that Space reveals, 1–4 rate, and the left and right arrows move — and, just as
 * much, every key press that must mean nothing.
 *
 * Does NOT decide: what revealing, rating or moving do (`session.js`), or how the
 * shortcuts are shown on screen.
 *
 * PURE, SO THE REFUSALS CAN BE TESTED. Most of a keyboard handler's bugs are in what it
 * should have ignored, and every one of those cases is a line in the tests.
 *
 * WHAT IS IGNORED, AND WHY:
 *   - SPACE ON A FOCUSED BUTTON OR LINK. The browser already activates it. Handling Space
 *     as well would fire twice — press Space on "Previous" and the session would both move
 *     back and reveal the answer. The focused control wins.
 *   - ANY KEY WHILE TYPING, in an input, textarea, select or editable region, and any key
 *     mid-composition in an input method. A shortcut must never eat a character.
 *   - ANY KEY WITH CTRL, ALT OR META. Those belong to the browser and the operating system:
 *     Ctrl+1 switches tabs, and it must not also rate a card.
 *   - A HELD KEY'S REPEATS, for reveal and rate. Holding "1" must record one rating, not a
 *     dozen. The arrows do repeat, because holding one to skip through cards is intended.
 *   - 1–4 BEFORE THE ANSWER IS SHOWING. Confidence is only honest after seeing the answer,
 *     the same rule the rating buttons follow.
 *   - A KEY SOMETHING ELSE HAS ALREADY HANDLED (`defaultPrevented`).
 */

export const SHORTCUTS = Object.freeze([
  Object.freeze({ keys: Object.freeze(['Space']), action: 'Show the answer' }),
  Object.freeze({ keys: Object.freeze(['1', '2', '3', '4']), action: 'Again, Hard, Good, Easy — once the answer is showing' }),
  Object.freeze({ keys: Object.freeze(['←', '→']), action: 'Previous card, next card' }),
]);

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);

function isTyping(target) {
  if (!target) return false;
  return TYPING_TAGS.has(target.tagName) || target.isContentEditable === true;
}

function activatesOnSpace(target) {
  if (!target) return false;
  if (ACTIVATABLE_TAGS.has(target.tagName)) return true;
  return typeof target.getAttribute === 'function' && target.getAttribute('role') === 'button';
}

/**
 * The practice action a key press asks for, or null.
 *
 * @param {KeyboardEvent|object} event  anything with `key`, `target` and the modifier flags
 * @param {{ revealed: boolean }} context  whether the current card's answer is showing
 * @returns {{ type: 'reveal' } | { type: 'rate', value: number } | { type: 'previous' } | { type: 'next' } | null}
 */
export function shortcutFor(event, { revealed }) {
  if (!event || event.defaultPrevented || event.isComposing) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (isTyping(event.target)) return null;

  switch (event.key) {
    case ' ':
    case 'Spacebar':
      if (revealed || event.repeat || activatesOnSpace(event.target)) return null;
      return { type: 'reveal' };

    case 'ArrowLeft':
      return { type: 'previous' };

    case 'ArrowRight':
      return { type: 'next' };

    case '1':
    case '2':
    case '3':
    case '4':
      if (!revealed || event.repeat) return null;
      return { type: 'rate', value: Number(event.key) };

    default:
      return null;
  }
}
