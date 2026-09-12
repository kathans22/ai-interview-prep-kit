/**
 * KitsPage.jsx — skeleton for the kit listing.
 *
 * Decides: nothing yet. Heading only.
 *
 * Does NOT decide: what a kit row shows, or the order. `GET /api/kits` already returns
 * them newest first and includes the failures — a listing that hides a failed kit
 * leaves the user with no way to tell a slow build from a dead one.
 */

export default function KitsPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Your kits</h1>
      <p className="mt-2 text-sm text-slate-600">The listing arrives with the kit hooks.</p>
    </section>
  );
}
