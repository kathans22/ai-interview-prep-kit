/**
 * weakSpots.js — which requirements a person's scored answers say they are weak on NOW.
 *
 * Decides: from the record of scored answers, the requirement ids whose most recent verdict
 * was "missed".
 *
 * Does NOT decide: what a weak requirement does to practice (`orderCards` takes the ids),
 * or how an answer is scored (`scoreAnswer`).
 *
 * THE LATEST VERDICT DECIDES, per requirement. Missing r2 on Monday and covering it on
 * Tuesday means r2 is no longer weak; the opposite order means it is. A count of misses
 * would keep a learned requirement pulled forward for ever — the same reason practice
 * ordering uses the latest rating rather than an average.
 *
 * VERDICTS ACROSS QUESTIONS COUNT TOGETHER. Two questions can cover the same requirement,
 * and a hit on either is evidence about the requirement, not about the question.
 *
 * "UNJUDGED" IS NOT EVIDENCE. A requirement the scorer gave no verdict on neither becomes
 * weak nor stops being weak.
 */

const timeOf = (value) => {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/**
 * @param {Array<{ at?: string|Date, verdicts?: Array<{ requirementId: string, verdict: string }> }>} scores
 *   the record of scored answers, in any order
 * @param {{ requirementIds?: string[] }} [options]  when given, only these ids can be
 *   reported — a requirement a regeneration removed is not a weak spot any more
 * @returns {string[]} weak requirement ids, in the order their deciding miss happened
 */
export function weakRequirementIds(scores, { requirementIds } = {}) {
  const allowed = Array.isArray(requirementIds) ? new Set(requirementIds) : null;
  const latest = new Map();

  (Array.isArray(scores) ? scores : []).forEach((score, position) => {
    const time = timeOf(score?.at) ?? -Infinity;
    for (const entry of Array.isArray(score?.verdicts) ? score.verdicts : []) {
      const id = entry?.requirementId;
      if (!id || (entry.verdict !== 'hit' && entry.verdict !== 'missed')) continue;
      if (allowed && !allowed.has(id)) continue;

      const current = latest.get(id);
      // Later in time wins; at the same time, later in the log wins, because the log is
      // appended in the order answers were scored.
      if (current && (time < current.time || (time === current.time && position < current.position))) continue;
      latest.set(id, { verdict: entry.verdict, time, position });
    }
  });

  return [...latest.entries()]
    .filter(([, value]) => value.verdict === 'missed')
    .sort((a, b) => a[1].time - b[1].time || a[1].position - b[1].position)
    .map(([id]) => id);
}
