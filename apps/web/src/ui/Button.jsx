/**
 * Button.jsx — a real button, and the classes that make one look like a button.
 *
 * Decides: how a button looks, and that `type` defaults to `"button"`.
 *
 * Does NOT decide: what pressing it does. No handler of its own, no data, no request.
 *
 * THE `type` DEFAULT IS THE POINT. A `<button>` inside a `<form>` defaults to `submit`.
 * A "Cancel" or "Add a question" button placed in a form therefore submits it, and the
 * bug shows up as a form that saves when someone meant to dismiss it. Defaulting to
 * `"button"` makes submitting the deliberate choice, which is the right way round.
 *
 * WHY THERE IS NO `as="a"` ESCAPE HATCH. A link that renders as a `<button>` loses
 * middle-click, "open in new tab" and the browser's own handling of navigation, and it
 * is announced as a button to a screen reader when it is really a link. When something
 * navigates it stays an `<a>`/`<Link>` and borrows `buttonClasses` for the look. The
 * appearance is shared; the semantics are not negotiable.
 */

const VARIANTS = Object.freeze({
  primary: 'bg-slate-900 text-white hover:bg-slate-800 disabled:hover:bg-slate-900',
  secondary: 'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:hover:bg-white',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:hover:bg-red-700',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 disabled:hover:bg-transparent',
});

const SIZES = Object.freeze({
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
});

/**
 * The shared look, for the cases that must stay an anchor.
 * Focus styling is deliberately absent here — it is applied globally in `index.css` so
 * no component can drop it by forgetting a class.
 */
export function buttonClasses({ variant = 'primary', size = 'md', className = '' } = {}) {
  return [
    'inline-flex items-center justify-center gap-2 rounded-md font-medium',
    'disabled:cursor-not-allowed disabled:opacity-60',
    VARIANTS[variant] ?? VARIANTS.primary,
    SIZES[size] ?? SIZES.md,
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

export default function Button({
  type = 'button',
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...rest
}) {
  return (
    <button type={type} className={buttonClasses({ variant, size, className })} {...rest}>
      {children}
    </button>
  );
}
