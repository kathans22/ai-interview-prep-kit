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
