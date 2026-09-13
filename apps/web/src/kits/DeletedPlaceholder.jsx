/**
 * DeletedPlaceholder.jsx — what stands where a deleted item was, while it can be undone.
 *
 * Decides: that a delete leaves a visible trace in place for its undo window, that the
 * trace says what went, and that the undo is a real button with a name that says what it
 * undoes.
 *
 * Does NOT decide: how long the window is or what undoing does. The editor holds the
 * delete; `undoable` says whether it is still being held, and `onUndo` drops it.
 *
 * IN PLACE, NOT A TOAST. A toast appears somewhere else, disappears on its own clock and
 * is easy to miss or impossible to reach by keyboard in time. The placeholder sits in the
 * gap the item left, so the thing and its undo are in one place, and focus is moved onto
 * the undo button when the delete is confirmed — one keypress takes it back.
 *
 * ONCE THE WINDOW CLOSES THE BUTTON GOES. The delete is on its way to the server, which
 * has no undo, so offering one would be a promise the app cannot keep.
 */

import { useEffect, useRef } from 'react';

import { buttonClasses } from '../ui/Button.jsx';

export default function DeletedPlaceholder({ id, noun, undoable, onUndo, autoFocus = false, className = '' }) {
  const undoButton = useRef(null);

  // Only on mount: the placeholder that was just confirmed takes focus, and a later
  // re-render never steals it back from wherever the person has moved on to.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const frame = requestAnimationFrame(() => undoButton.current?.focus());
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-600 ${className}`}
    >
      <p role="status">
        {undoable ? `Deleted ${noun} ` : `Removing ${noun} `}
        <span className="font-mono">{id}</span>
        {undoable ? '.' : '…'}
      </p>
      {undoable ? (
        // A plain `<button>`: `Button` does not forward refs, and focus needs one.
        <button
          ref={undoButton}
          type="button"
          onClick={onUndo}
          aria-label={`Undo deleting ${id}`}
          className={buttonClasses({ variant: 'secondary', size: 'sm' })}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}
