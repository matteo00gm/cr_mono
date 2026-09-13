import { describe, expect, it } from 'vitest';

import { loadDataset } from '../src/dataset.js';
import { humanSample, PAIRING_RUBRIC } from '../src/rubric.js';

/** The pairing rubric and the human-rated sample (P1-46). */

describe('PAIRING_RUBRIC', () => {
  it.each(['tannin', 'acidity', 'sweet', 'Intensity', 'attributes', 'rejected'])(
    'scores the mechanics of pairing, naming %s',
    (word) => {
      expect(PAIRING_RUBRIC).toContain(word);
    },
  );
});

describe('humanSample', () => {
  const { queries } = loadDataset();

  it('is the same sample whatever order the queries arrive in, returned in id order', () => {
    const sample = humanSample(queries, 12).map((query) => query.id);

    expect(humanSample([...queries].reverse(), 12).map((query) => query.id)).toEqual(sample);
    expect(sample).toHaveLength(12);
    expect(sample).toEqual([...sample].sort());
  });

  it('grows by adding queries, never by swapping the ones already chosen', () => {
    const small = humanSample(queries, 5).map((query) => query.id);
    const large = humanSample(queries, 12).map((query) => query.id);

    expect(small.every((id) => large.includes(id))).toBe(true);
  });
});
