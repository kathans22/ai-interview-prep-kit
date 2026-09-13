/**
 * localOps.js — what an edit looks like before the server has confirmed it.
 *
 * Decides: the on-screen effect of an edit operation, so a change appears the instant it
 * is made rather than after a round trip.
 *
 * Does NOT decide: whether an edit is allowed, what it does to coverage or the schedule,
 * or what the kit finally holds. The server applies the real operation, validates the
 * whole kit, recomputes the derived sections and returns the result — and that result
 * REPLACES whatever this module drew. This is a preview that the server overwrites, not
 * a second implementation that could disagree with it for long.
 *
 * WHY A LOCAL COPY OF THE EFFECT EXISTS AT ALL, given invariant 36 says the client
 * restates no server rule. The brief asks for optimistic updates: typing must show
 * immediately, and a request per keystroke is ruled out. So the client has to draw the
 * change itself. The duplication is kept to display effects only — set this text, mark
 * this item edited — and the provenance rule it mirrors (a generated item becomes
 * `edited`, a manual one stays `manual`) is asserted in a test against core's own
 * `markEdited`, so a change to the rule fails there rather than showing a wrong badge.
 *
 * NO TRIMMING WHILE TYPING. The server trims every text field it stores. Trimming here
 * would fight the cursor — a space typed between two words would vanish until the next
 * character arrived — so the preview shows exactly what was typed and the trimmed value
 * arrives with the server's confirmation.
 */

/** The text fields each edit operation can change. */
export const EDIT_FIELDS = Object.freeze({
  'edit-question': Object.freeze(['prompt', 'answer_outline']),
  'edit-flashcard': Object.freeze(['front', 'back']),
  'edit-brief': Object.freeze(['summary', 'what_they_do']),
});

/**
 * Mirror of core's `markEdited` for display. A person's own item stays `manual` however
 * often they edit it: "the model's work, corrected" and "not the model's work at all" are
 * different claims, and the badge must not blur them.
 */
function markEditedLocally(item) {
  return { ...item, origin: item?.origin === 'manual' ? 'manual' : 'edited', pinned: item?.pinned === true };
}

function findById(list, id) {
  return (Array.isArray(list) ? list : []).find((entry) => entry?.id === id);
}

/**
 * Put one category's questions in the given order, refilling the array slots that
 * category already occupies so no other category moves — the same rule as the server's
 * `reorder-questions`.
 *
 * TOLERANT WHERE THE SERVER IS STRICT, on purpose. The server refuses a list that is not
 * exactly the category's questions; this is used to draw a preview and to rebuild a list
 * just before it is sent, both against a kit that may have changed since the list was
 * made. So ids that are no longer in the category are skipped, and questions the list
 * does not name keep their existing relative order after the ones it does.
 */
export function orderCategory(questions, category, ids) {
  const list = Array.isArray(questions) ? questions : [];
  const inCategory = list.filter((question) => question?.category === category);
  const byId = new Map(inCategory.map((question) => [question.id, question]));

  const ordered = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(byId.get(id));
  }
  for (const question of inCategory) {
    if (!seen.has(question.id)) ordered.push(question);
  }

  let next = 0;
  return list.map((question) => (question?.category === category ? ordered[next++] : question));
}

/**
 * Apply one operation to a draft, in place. The caller owns the draft.
 *
 * An operation whose target no longer exists does nothing here — another writer may have
 * deleted it. The server is the one that reports that, when the operation reaches it.
 */
export function applyLocalOp(draft, op) {
  switch (op?.type) {
    case 'edit-question': {
      const question = findById(draft.questions, op.id);
      if (!question) return draft;
      question[op.field] = op.value;
      Object.assign(question, markEditedLocally(question));
      return draft;
    }

    case 'edit-flashcard': {
      const card = findById(draft.flashcards, op.id);
      if (!card) return draft;
      card[op.field] = op.value;
      Object.assign(card, markEditedLocally(card));
      return draft;
    }

    case 'edit-brief': {
      draft.company_brief = draft.company_brief ?? { summary: '', what_they_do: '', sources: [] };
      draft.company_brief[op.field] = op.value;
      const provenance = { ...(draft.company_brief.provenance ?? {}) };
      provenance[op.field] = markEditedLocally(provenance[op.field] ?? { origin: 'generated', pinned: false });
      draft.company_brief.provenance = provenance;
      return draft;
    }

    // An added item is drawn at once under a TEMPORARY id carried on the operation, so it
    // is stable however often the preview is recomputed. It is marked `pendingAdd` so the
    // screen renders it read-only: an edit aimed at a temporary id would reach the server
    // as an id it has never heard of. When the add confirms, the server's kit replaces the
    // base and the real item — with its real id — takes the temporary one's place.
    case 'add-question': {
      draft.questions = Array.isArray(draft.questions) ? draft.questions : [];
      if (!findById(draft.questions, op.tempId)) {
        draft.questions.push({
          id: op.tempId,
          requirement_ids: op.requirement_ids ?? [],
          category: op.category,
          prompt: op.prompt ?? '',
          answer_outline: op.answer_outline ?? '',
          difficulty: op.difficulty ?? 2,
          origin: 'manual',
          pinned: false,
          pendingAdd: true,
        });
      }
      return draft;
    }

    // A delete is drawn as a MARK, not a removal. The item stays in place flagged
    // `pendingDelete`, so the screen can put an undo placeholder exactly where it was —
    // and so undoing is just dropping the operation, with nothing to reinsert or reorder.
    // The real removal arrives with the server's kit when the delete is finally sent.
    case 'delete-question': {
      const question = findById(draft.questions, op.id);
      if (question) question.pendingDelete = true;
      return draft;
    }

    // Changing a question's category is a judgement about its content, so — as on the
    // server — it marks a generated question edited. Reordering is not, and marks nothing.
    case 'move-category': {
      const question = findById(draft.questions, op.id);
      if (!question) return draft;
      question.category = op.category;
      Object.assign(question, markEditedLocally(question));
      return draft;
    }

    case 'reorder-questions': {
      draft.questions = orderCategory(draft.questions, op.category, op.question_ids);
      return draft;
    }

    case 'delete-flashcard': {
      const card = findById(draft.flashcards, op.id);
      if (card) card.pendingDelete = true;
      return draft;
    }

    case 'add-flashcard': {
      draft.flashcards = Array.isArray(draft.flashcards) ? draft.flashcards : [];
      if (!findById(draft.flashcards, op.tempId)) {
        draft.flashcards.push({
          id: op.tempId,
          front: op.front ?? '',
          back: op.back ?? '',
          requirement_ids: op.requirement_ids ?? [],
          origin: 'manual',
          pinned: false,
          pendingAdd: true,
        });
      }
      return draft;
    }

    default:
      return draft;
  }
}

/**
 * Apply operations to a kit without touching it.
 *
 * With no operations the SAME object comes back, so a screen with nothing pending does
 * no cloning at all and anything memoised on the kit's identity stays memoised.
 */
export function applyLocalOps(kit, ops) {
  if (!kit || !Array.isArray(ops) || ops.length === 0) return kit;
  const draft = structuredClone(kit);
  for (const op of ops) applyLocalOp(draft, op);
  return draft;
}

/**
 * The value a field operation targets, as the given kit holds it — or `undefined` when
 * the target does not exist in that kit.
 */
export function currentValue(kit, op) {
  switch (op?.type) {
    case 'edit-question':
      return findById(kit?.questions, op.id)?.[op.field];
    case 'edit-flashcard':
      return findById(kit?.flashcards, op.id)?.[op.field];
    case 'edit-brief':
      return kit?.company_brief?.[op.field];
    default:
      return undefined;
  }
}
