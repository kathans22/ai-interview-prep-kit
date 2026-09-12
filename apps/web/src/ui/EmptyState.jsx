/**
 * EmptyState.jsx — nothing here yet, and what to do about it.
 *
 * Decides: how "no results" reads.
 *
 * Does NOT decide: why it is empty. The caller knows whether this is a new account with
 * no kits or a filter matching nothing, and those need different words.
 *
 * AN EMPTY STATE WITHOUT AN ACTION IS A DEAD END. The whole reason to render one rather
 * than a blank area is to tell someone what comes next, so `action` is where a button or
 * a link goes. A blank region is also indistinguishable from a failed load, which is the
 * other half of why this exists as its own state.
 */

export default function EmptyState({ title, description, action, className = '' }) {
  return (
    <div
      className={['rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center', className]
        .filter(Boolean)
        .join(' ')}
    >
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description ? <p className="mx-auto mt-1 max-w-prose text-sm text-slate-600">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
