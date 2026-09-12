/**
 * Input.jsx — a labelled field, with its hint and its error wired to it.
 *
 * Decides: that a field always has a real `<label htmlFor>`, and that a hint or an error
 * is associated with the input through `aria-describedby` rather than merely sitting
 * near it.
 *
 * Does NOT decide: what a valid value is. Validation answers come from the server, which
 * owns the rules; a component that re-implemented them would create a second copy that
 * goes stale.
 *
 * A LABEL, NOT A PLACEHOLDER. Placeholder text vanishes the moment someone types, is
 * frequently too low-contrast to read, and is not reliably announced as the field's
 * name. A form whose fields are identified only by placeholders is unusable with a
 * screen reader and merely annoying with a mouse, so the label is not optional here —
 * it is a required prop.
 *
 * `aria-invalid` is set from the presence of an error rather than from a separate flag,
 * so the two can never disagree.
 */

import { useId } from 'react';

export default function Input({
  label,
  hint,
  error,
  id,
  className = '',
  textarea = false,
  ...rest
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  const Field = textarea ? 'textarea' : 'input';

  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-900">
        {label}
      </label>

      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-slate-600">
          {hint}
        </p>
      ) : null}

      <Field
        id={inputId}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
        className={[
          'mt-1 block w-full rounded-md border px-3 py-2 text-sm text-slate-900',
          error ? 'border-red-600' : 'border-slate-300',
          textarea ? 'min-h-32' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />

      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
