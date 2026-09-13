/**
 * reorder.js — what a drop means, as edit operations.
 *
 * Decides: which operations turn "this question, dropped there" into the arrangement the
 * person sees — nothing when it lands where it started, a reorder within its category,
 * or a category move followed by a reorder of the category it lands in.
 *
 * Does NOT decide: where the pointer or the keyboard put it (`useQuestionDrag`), or how
 * the operations are saved (`useKitEditor`).
 *
 * TARGETS ARE IDS, NOT INDEXES. "Before q7" still names the same place after a question
 * above it is deleted or a save lands mid-drag; "position 3" silently names somewhere
 * else.
 *
 * ONE DROP ACROSS CATEGORIES IS TWO OPERATIONS IN ONE REQUEST: the move, then the order
 * of the category it lands in. The edit route applies a request all-or-nothing, so the
 * question can never be saved in its new category at the wrong position.
 *
 * A QUESTION STILL BEING ADDED IS LEFT OUT OF THE LIST. Its id is temporary and the
 * server has never seen it. The editor resolves every list again at the moment it is
 * sent, so the real question, once saved, keeps its place.
 */

import { applyLocalOps } from './localOps.js';

/**
 * @param {object[]} questions  the questions as the screen shows them
 * @param {{ id: string, category: string, beforeId?: string|null }} drop
 *   `beforeId` null means the end of the category.
 * @returns {object[]} edit operations; empty when the drop changes nothing
 */
export function planMove(questions, { id, category, beforeId = null }) {
  const list = (Array.isArray(questions) ? questions : []).filter((question) => question && !question.pendingAdd);
  const moving = list.find((question) => question.id === id);
  if (!moving || !category) return [];

  const current = list.filter((question) => question.category === category).map((question) => question.id);
  const others = current.filter((questionId) => questionId !== id);
  const at = beforeId === null ? -1 : others.indexOf(beforeId);
  const index = at === -1 ? others.length : at;
  const next = [...others.slice(0, index), id, ...others.slice(index)];

  const sameCategory = moving.category === category;
  if (sameCategory && next.every((questionId, position) => questionId === current[position])) return [];

  const ops = [];
  if (!sameCategory) ops.push({ type: 'move-category', id, category });
  ops.push({ type: 'reorder-questions', category, question_ids: next });
  return ops;
}

/**
 * The keyboard's move: one place up or down within the question's own category.
 *
 * Expressed as a drop — "before the question above", or "before the one two below" — so
 * a key press and a drag produce identical operations and share every guarantee. Empty
 * at either end of the category, which is what disables the control.
 */
export function planStep(questions, id, direction) {
  const list = (Array.isArray(questions) ? questions : []).filter((question) => question && !question.pendingAdd);
  const moving = list.find((question) => question.id === id);
  if (!moving) return [];

  const order = list.filter((question) => question.category === moving.category).map((question) => question.id);
  const index = order.indexOf(id);

  if (direction === 'up') {
    if (index <= 0) return [];
    return planMove(questions, { id, category: moving.category, beforeId: order[index - 1] });
  }
  if (direction === 'down') {
    if (index === -1 || index >= order.length - 1) return [];
    return planMove(questions, { id, category: moving.category, beforeId: order[index + 2] ?? null });
  }
  return [];
}

/**
 * Where a question will be once the operations apply, counted the way the screen lists
 * it — for the sentence announced after a move, since a screen reader user cannot see the
 * row jump.
 */
export function positionAfter(questions, ops, id) {
  const next = applyLocalOps({ questions: Array.isArray(questions) ? questions : [] }, ops).questions;
  const moved = next.find((question) => question.id === id);
  if (!moved) return null;
  const order = next.filter((question) => question.category === moved.category).map((question) => question.id);
  return { category: moved.category, position: order.indexOf(id) + 1, total: order.length };
}
