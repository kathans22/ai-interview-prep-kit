/**
 * evalExtraction.js — scores requirement extraction against hand-labelled JDs.
 *
 * Decides: nothing yet. Placeholder so `npm run eval:extraction` resolves from a clean
 * clone instead of failing with a module-resolution error.
 *
 * Does NOT decide: the scoring method, the label format, or the pass threshold. Those
 * arrive with the extraction-eval stage, and the harness will read fixtures from
 * fixtures/extraction/ and call into @aipk/core rather than reimplementing extraction.
 *
 * Run with: npm run eval:extraction
 */

process.stdout.write(
  'eval:extraction — not implemented yet.\n' +
    'Arrives with the extraction-eval stage; it will score @aipk/core extraction against\n' +
    'the hand-labelled JDs in fixtures/extraction/.\n'
);
