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
