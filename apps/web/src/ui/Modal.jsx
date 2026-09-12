/**
 * Modal.jsx — a dialog built on the browser's own `<dialog>`.
 *
 * Decides: that modals use the native element with `showModal()`, and that the title is
 * the dialog's accessible name.
 *
 * Does NOT decide: what is inside it, or what closing means. `onClose` is the caller's.
 *
 * WHY THE NATIVE ELEMENT AND NOT A DIV. `showModal()` gives, for free and correctly,
 * every behaviour a hand-rolled modal gets wrong:
 *   - focus moves into the dialog, and is TRAPPED there while it is open
 *   - Escape closes it
 *   - the rest of the page becomes inert, so a screen reader does not read through it
 *     and Tab cannot land on a button behind the overlay
 *   - focus returns to whatever opened it on close
 *   - it renders in the top layer, which ends the z-index argument permanently
 *
 * Re-implementing that list with a `div` is somewhere around a hundred lines of focus
 * bookkeeping, and the usual result is a dialog that traps focus until the one case
 * nobody tested. The native element is not a shortcut here; it is the accessible option.
 *
 * The `close` event is the single close path, so Escape, the backdrop and the button all
 * funnel through one callback rather than three that can disagree.
 */

import { useEffect, useId, useRef } from 'react';

import Button from './Button.jsx';

export default function Modal({ open, onClose, title, description, footer, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();

  // Drive the element's own modal state from the prop. Calling `showModal` on an already
  // open dialog throws, so both directions are guarded.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // One close path for Escape, the backdrop and any button that calls `close()`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => onClose?.();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // A click on the backdrop lands on the dialog element itself rather than its
      // contents, which is what makes this test reliable without a wrapper div.
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current.close();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-slate-200 bg-white p-0 text-slate-900 backdrop:bg-slate-900/50"
    >
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 id={titleId} className="text-sm font-semibold text-slate-900">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1 text-sm text-slate-600">
              {description}
            </p>
          ) : null}
        </div>

        {/* A real button with a real accessible name — an icon-only "×" with no label is
            announced as nothing at all. */}
        <Button variant="ghost" size="sm" onClick={() => dialogRef.current?.close()} aria-label="Close dialog">
          <span aria-hidden="true">×</span>
        </Button>
      </div>

      {children ? <div className="px-4 py-4 text-sm text-slate-700">{children}</div> : null}

      {footer ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-4 py-3">{footer}</div>
      ) : null}
    </dialog>
  );
}
