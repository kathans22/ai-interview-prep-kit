/**
 * Spinner.jsx — a busy indicator that announces itself.
 *
 * Decides: that waiting is announced (`role="status"`) with real text, and that the
 * animation stops for anyone who has asked for reduced motion.
 *
 * Does NOT decide: what is being waited for. The label is the caller's, because "Loading
 * your kits" and "Building" are different facts and a generic "Loading…" tells a screen
 * reader user nothing about what will appear.
 *
 * THE LABEL IS NOT DECORATIVE. A bare spinning graphic is invisible to a screen reader:
 * the page simply says nothing for however long the request takes, which is
 * indistinguishable from a page that has finished and is empty. The text is visually
 * hidden rather than absent.
 *
 * `motion-reduce:animate-none` is applied here rather than left to the styling unit,
 * because shipping a component that spins indefinitely and fixing it two commits later
 * means two commits with a known accessibility defect in them. The global sweep still
 * covers everything else.
 */

const SIZES = Object.freeze({
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-10 w-10 border-[3px]',
});

export default function Spinner({ label = 'Loading…', size = 'md', className = '' }) {
  return (
    <span role="status" className={['inline-flex items-center gap-2', className].filter(Boolean).join(' ')}>
      <span
        aria-hidden="true"
        className={[
          'inline-block animate-spin rounded-full border-slate-300 border-t-slate-900',
          'motion-reduce:animate-none',
          SIZES[size] ?? SIZES.md,
        ].join(' ')}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
