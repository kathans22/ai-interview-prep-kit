/**
 * coverage.test.js — gap detection across must and nice requirements.
 *
 * Decides: that coverage is exact set membership, that must gaps are reported separately
 * from nice ones, and that malformed input degrades to an honest answer rather than an
 * invented one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findGaps, coverageStats, isBlockingCoverageMet } from '../deterministic/coverage.js';

const requirements = [
  { id: 'r1', text: '5+ years React', kind: 'technical', priority: 'must' },
  { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'nice' },
  { id: 'r3', text: 'Logistics domain', kind: 'domain', priority: 'must' },
  { id: 'r4', text: 'GraphQL exposure', kind: 'technical', priority: 'nice' },
];

function question(id, requirementIds) {
  return { id, requirement_ids: requirementIds, category: 'technical', difficulty: 2 };
}

test('a requirement is covered when any question lists its id', () => {
  const { uncovered_requirement_ids: uncovered, covered_map: map } = findGaps(requirements, [
    question('q1', ['r1']),
    question('q2', ['r3', 'r4']),
  ]);

  assert.deepEqual(uncovered, ['r2']);
  assert.deepEqual(map.r1, ['q1']);
  assert.deepEqual(map.r3, ['q2']);
  assert.deepEqual(map.r4, ['q2']);
  assert.deepEqual(map.r2, [], 'uncovered requirements map to an empty array, not undefined');
});

test('must gaps are reported separately from nice gaps', () => {
  const result = findGaps(requirements, [question('q1', ['r2', 'r4'])]);

  assert.deepEqual(result.uncovered_requirement_ids, ['r1', 'r3']);
  assert.deepEqual(result.uncovered_must_ids, ['r1', 'r3'], 'both blocking gaps');

  const niceGapOnly = findGaps(requirements, [question('q1', ['r1', 'r3'])]);
  assert.deepEqual(niceGapOnly.uncovered_requirement_ids, ['r2', 'r4']);
  assert.deepEqual(niceGapOnly.uncovered_must_ids, [], 'nice gaps never block');
});

test('covered_map has one entry per requirement and preserves requirement order', () => {
  const { covered_map: map } = findGaps(requirements, []);
  assert.deepEqual(Object.keys(map), ['r1', 'r2', 'r3', 'r4']);
  for (const id of Object.keys(map)) assert.deepEqual(map[id], []);
});

test('several questions covering one requirement are all listed, without duplicates', () => {
  const { covered_map: map } = findGaps(requirements, [
    question('q1', ['r1']),
    question('q2', ['r1']),
    question('q3', ['r1', 'r1']), // the same id twice in one question
  ]);

  assert.deepEqual(map.r1, ['q1', 'q2', 'q3']);
});

test('a dangling reference never invents a covered requirement', () => {
  const result = findGaps(requirements, [question('q1', ['r99'])]);

  assert.deepEqual(result.uncovered_requirement_ids, ['r1', 'r2', 'r3', 'r4']);
  assert.equal('r99' in result.covered_map, false, 'unknown ids must not enter the map');
});

test('a question with no id cannot cover anything', () => {
  const { uncovered_requirement_ids: uncovered } = findGaps(requirements, [
    { requirement_ids: ['r1'] },
    { id: '', requirement_ids: ['r2'] },
  ]);
  assert.deepEqual(uncovered, ['r1', 'r2', 'r3', 'r4']);
});

test('empty and malformed inputs are handled without throwing', () => {
  assert.deepEqual(findGaps([], []), {
    uncovered_requirement_ids: [],
    uncovered_must_ids: [],
    covered_map: {},
  });
  assert.deepEqual(findGaps(null, undefined).uncovered_requirement_ids, []);
  assert.deepEqual(findGaps(requirements, 'not an array').uncovered_requirement_ids, [
    'r1',
    'r2',
    'r3',
    'r4',
  ]);
  assert.deepEqual(findGaps([{ text: 'no id' }, { id: '' }], []).covered_map, {});
});

test('a duplicate requirement id collapses to one entry', () => {
  const { covered_map: map } = findGaps(
    [
      { id: 'r1', priority: 'must' },
      { id: 'r1', priority: 'nice' },
    ],
    [question('q1', ['r1'])]
  );
  assert.deepEqual(Object.keys(map), ['r1']);
  assert.deepEqual(map.r1, ['q1']);
});

test('coverageStats reports overall and must-only ratios', () => {
  const stats = coverageStats(requirements, [question('q1', ['r1']), question('q2', ['r2'])]);

  assert.equal(stats.total, 4);
  assert.equal(stats.covered, 2);
  assert.equal(stats.ratio, 0.5);
  assert.equal(stats.mustTotal, 2);
  assert.equal(stats.mustCovered, 1);
  assert.equal(stats.mustRatio, 0.5);
});

test('an empty requirement set is fully covered, not zero percent covered', () => {
  const stats = coverageStats([], []);
  assert.equal(stats.ratio, 1);
  assert.equal(stats.mustRatio, 1);
  assert.equal(isBlockingCoverageMet([], []), true);
});

test('isBlockingCoverageMet ignores nice gaps and blocks on must gaps', () => {
  assert.equal(
    isBlockingCoverageMet(requirements, [question('q1', ['r1', 'r3'])]),
    true,
    'r2 and r4 are nice — a kit that misses them is finished, with a noted shortfall'
  );
  assert.equal(isBlockingCoverageMet(requirements, [question('q1', ['r1'])]), false);
});

test('requirements with no priority are never treated as must', () => {
  const result = findGaps([{ id: 'r1' }, { id: 'r2', priority: 'must' }], []);
  assert.deepEqual(result.uncovered_requirement_ids, ['r1', 'r2']);
  assert.deepEqual(result.uncovered_must_ids, ['r2']);
});
