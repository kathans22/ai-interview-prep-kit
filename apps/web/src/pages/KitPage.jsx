/**
 * KitPage.jsx — skeleton for one kit.
 *
 * Decides: nothing yet. Heading only.
 *
 * Does NOT decide: what a kit looks like on screen, or what an edit does. This is the
 * page that will have to make degradation visible — run notes, dropped requirements, a
 * thin job description — and show which items are pinned or hand-edited, because those
 * are what a regeneration may not overwrite.
 */

export default function KitPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Kit</h1>
      <p className="mt-2 text-sm text-slate-600">The kit view arrives with the kit hooks.</p>
    </section>
  );
}
