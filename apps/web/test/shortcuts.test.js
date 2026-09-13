// Practice shortcuts: what each key does, and — most of the handler's risk — what it must
// leave alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SHORTCUTS, shortcutFor } from '../src/practice/shortcuts.js';

const BODY = { tagName: 'BODY' };
const press = (key, extra = {}) => ({ key, target: BODY, ...extra });
const hidden = { revealed: false };
const shown = { revealed: true };

test('Space reveals the answer, once', () => {
  assert.deepEqual(shortcutFor(press(' '), hidden), { type: 'reveal' });
  assert.deepEqual(shortcutFor(press('Spacebar'), hidden), { type: 'reveal' }, 'the older key name too');
  assert.equal(shortcutFor(press(' '), shown), null, 'already showing');
  assert.equal(shortcutFor(press(' ', { repeat: true }), hidden), null, 'a held key is one press');
});

test('Space on a focused control is left to the browser, so nothing fires twice', () => {
  assert.equal(shortcutFor(press(' ', { target: { tagName: 'BUTTON' } }), hidden), null);
  assert.equal(shortcutFor(press(' ', { target: { tagName: 'A' } }), hidden), null);
  assert.equal(shortcutFor(press(' ', { target: { tagName: 'DIV', getAttribute: () => 'button' } }), hidden), null);
  // A focusable region that is not a control — the revealed answer — does not activate.
  assert.deepEqual(shortcutFor(press(' ', { target: { tagName: 'DIV', getAttribute: () => null } }), hidden), { type: 'reveal' });
});

test('1 to 4 rate, but only once the answer is showing', () => {
  for (const [key, value] of [['1', 1], ['2', 2], ['3', 3], ['4', 4]]) {
    assert.deepEqual(shortcutFor(press(key), shown), { type: 'rate', value });
    assert.equal(shortcutFor(press(key), hidden), null, `${key} before the answer is seen`);
  }
  assert.equal(shortcutFor(press('5'), shown), null);
  assert.equal(shortcutFor(press('0'), shown), null);
  assert.equal(shortcutFor(press('!'), shown), null, 'shift+1 is not 1');
  assert.equal(shortcutFor(press('1', { repeat: true }), shown), null, 'holding 1 records one rating');
});

test('the arrows move whether or not the answer is showing, on a focused button too, and do repeat', () => {
  assert.deepEqual(shortcutFor(press('ArrowLeft'), hidden), { type: 'previous' });
  assert.deepEqual(shortcutFor(press('ArrowRight'), shown), { type: 'next' });
  assert.deepEqual(shortcutFor(press('ArrowRight', { target: { tagName: 'BUTTON' } }), hidden), { type: 'next' });
  assert.deepEqual(shortcutFor(press('ArrowRight', { repeat: true }), hidden), { type: 'next' });
  assert.equal(shortcutFor(press('ArrowUp'), hidden), null, 'up and down still scroll');
});

test('with Ctrl, Alt or Meta held, the key belongs to the browser', () => {
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(shortcutFor(press('1', { [modifier]: true }), shown), null, `${modifier}+1`);
    assert.equal(shortcutFor(press('ArrowRight', { [modifier]: true }), shown), null, `${modifier}+→`);
    assert.equal(shortcutFor(press(' ', { [modifier]: true }), hidden), null, `${modifier}+Space`);
  }
});

test('nothing is a shortcut while typing, composing, or after something else handled the key', () => {
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(shortcutFor(press(' ', { target }), hidden), null, `${target.tagName} space`);
    assert.equal(shortcutFor(press('2', { target }), shown), null, `${target.tagName} digit`);
    assert.equal(shortcutFor(press('ArrowLeft', { target }), hidden), null, `${target.tagName} arrow`);
  }
  assert.equal(shortcutFor(press('1', { isComposing: true }), shown), null);
  assert.equal(shortcutFor(press('1', { defaultPrevented: true }), shown), null);
  assert.equal(shortcutFor(null, shown), null);
});

test('the on-screen list names every shortcut the handler honours', () => {
  assert.deepEqual(
    SHORTCUTS.map((shortcut) => shortcut.keys),
    [['Space'], ['1', '2', '3', '4'], ['←', '→']]
  );
});
