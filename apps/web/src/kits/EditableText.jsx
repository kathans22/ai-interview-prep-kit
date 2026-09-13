/**
 * EditableText.jsx — a piece of kit text a person can change in place.
 *
 * Decides: how a field moves between reading and editing, and how the keyboard drives it.
 *
 * Does NOT decide: what an edit does or when it is saved. `onChange` fires on every
 * keystroke and the editor behind it merges and debounces; `onRevert` puts the field
 * back. This component never sends anything itself.
 *
 * A REAL BUTTON OPENS IT, AND FOCUS COMES BACK TO THAT BUTTON. Click-to-edit on bare text
 * is invisible to a keyboard and to a screen reader: there is nothing to tab to and
 * nothing announced as editable. So each field has an Edit button whose accessible name
 * says WHICH field ("Edit prompt for q3"), the textarea has a real label, and when
 * editing ends focus returns to the Edit button — otherwise it falls to the top of the
 * page and a keyboard user has to find their place again.
 *
 * ESCAPE CANCELS, CTRL/CMD+ENTER FINISHES. Enter alone inserts a newline, because these
 * fields hold paragraphs; stealing Enter would make multi-line answers impossible to type.
 *
 * THE SAVE STATE IS TEXT, NOT A LIVE REGION. It changes on a timer while someone types,
 * and announcing "Unsaved… Saving…" would talk over them. Failures are the thing worth
 * interrupting for, and those go to the toast surface, which is already a live region.
 */

import { useId, useRef, useState } from 'react';

import { buttonClasses } from '../ui/Button.jsx';

const STATUS_TEXT = Object.freeze({
  queued: 'Unsaved changes',
  saving: 'Saving…',
});

export default function EditableText({
  value,
  label,
  onChange,
  onRevert,
  status = null,
  rows = 3,
  children,
  className = '',
}) {
  const [editing, setEditing] = useState(false);
  const original = useRef(value);
  const editButton = useRef(null);
  const fieldId = useId();

  function open() {
    original.current = value;
    setEditing(true);
  }

  function close() {
    setEditing(false);
    // After the button has re-rendered, so there is something to focus.
    requestAnimationFrame(() => editButton.current?.focus());
  }

  function cancel() {
    onRevert?.(original.current);
    close();
  }

  if (!editing) {
    return (
      <div className={['flex items-start gap-2', className].filter(Boolean).join(' ')}>
        <div className="min-w-0 flex-1">{children ?? value}</div>
        <button
          ref={editButton}
          type="button"
          onClick={open}
          aria-label={`Edit ${label}`}
          className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'shrink-0' })}
        >
          Edit
        </button>
        {status ? <span className="shrink-0 self-center text-xs text-slate-500">{STATUS_TEXT[status]}</span> : null}
      </div>
    );
  }

  return (
    <div className={className}>
      <label htmlFor={fieldId} className="sr-only">
        {label}
      </label>
      <textarea
        id={fieldId}
        // Focus belongs in the field the person just asked to edit.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        rows={rows}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            close();
          }
        }}
        className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" onClick={close} className={buttonClasses({ size: 'sm' })}>
          Done
        </button>
        <button type="button" onClick={cancel} className={buttonClasses({ size: 'sm', variant: 'ghost' })}>
          Cancel
        </button>
        <span className="text-xs text-slate-500">
          {status ? STATUS_TEXT[status] : 'Ctrl+Enter to finish, Escape to cancel'}
        </span>
      </div>
    </div>
  );
}
