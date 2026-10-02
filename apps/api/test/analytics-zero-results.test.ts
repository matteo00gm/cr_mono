import { RANGE_EXPECTED } from '@catalogorosso/core';
import type { UnansweredQuestion, ZeroResultsQuery } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import {
  createAnalyticsPort,
  unconfiguredAnalytics,
  type AnalyticsPort,
} from '../src/analytics.js';
import { createApp } from '../src/app.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The questions the catalogue could not answer (P6-04, §2.4): the port that
 * finds the patterns across them, and the route every member can read.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-01T15:30:00.000Z');

const question = (
  text: string,
  conversationIds: string[],
  overrides: Partial<UnansweredQuestion> = {},
): UnansweredQuestion => ({
  question: text,
  conversationIds,
  noMatch: conversationIds.length,
  notRecommended: 0,
  lastAskedAt: new Date('2026-09-30T19:12:00.000Z'),
  ...overrides,
});

const reading = (questions: UnansweredQuestion[]) => {
  const asked: [string, ZeroResultsQuery][] = [];
  const port = createAnalyticsPort({
    now: () => NOW,
    readZeroResults: (tenantId, query) => {
      asked.push([tenantId, query]);
      return Promise.resolve(questions);
    },
  });

  return { asked, port };
};

describe('the port', () => {
  it('reads over the range asked', async () => {
    const { asked, port } = reading([]);

    await port.zeroResults(TENANT, { from: '2026-09-01', to: '2026-09-30' });

    expect(asked).toEqual([
      [
        TENANT,
        {
          start: new Date('2026-09-01T00:00:00.000Z'),
          end: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
    ]);
  });

  it('answers with each question, both kinds, and when last asked', async () => {
    const { port } = reading([
      question('avete un passito?', ['c1', 'c2', 'c3'], { noMatch: 2, notRecommended: 1 }),
    ]);

    expect((await port.zeroResults(TENANT, {})).questions).toEqual([
      {
        question: 'avete un passito?',
        conversations: 3,
        noMatch: 2,
        notRecommended: 1,
        lastAskedAt: '2026-09-30T19:12:00.000Z',
      },
    ]);
  });

  it('counts a conversation once across its questions, for the total and for a theme', async () => {
    /* c1 asked about a passito and a moscato: one visitor who wanted something sweet. */
    const { port } = reading([
      question('avete un passito?', ['c1', 'c2']),
      question('e un moscato?', ['c1']),
      question('un franciacorta?', ['c3']),
    ]);

    const answer = await port.zeroResults(TENANT, {});

    expect(answer.conversations).toBe(3);
    expect(answer.themes).toEqual([
      { id: 'sweet', label: 'vini dolci', conversations: 2 },
      { id: 'sparkling', label: 'bollicine', conversations: 1 },
    ]);
  });

  it('lists no theme nobody asked about, and most asked first', async () => {
    const { port } = reading([
      question('un franciacorta?', ['c1']),
      question('del prosecco?', ['c2']),
      question('un passito?', ['c3']),
    ]);

    const { themes } = await port.zeroResults(TENANT, {});

    expect(themes.map((theme) => theme.id)).toEqual(['sparkling', 'sweet']);
  });

  it('lists a hundred questions, and finds the themes in all of them', async () => {
    const questions = [
      ...Array.from({ length: 100 }, (_, index) =>
        question(`domanda ${String(index)}`, [`q${String(index)}`]),
      ),
      question('un passito?', ['late']),
    ];
    const { port } = reading(questions);

    const answer = await port.zeroResults(TENANT, {});

    expect(answer.questions).toHaveLength(100);
    expect(answer.questions.map((row) => row.question)).not.toContain('un passito?');
    expect(answer.themes).toEqual([{ id: 'sweet', label: 'vini dolci', conversations: 1 }]);
    expect(answer.conversations).toBe(101);
  });

  it('refuses a range that is not one before asking the store', async () => {
    const { asked, port } = reading([]);

    await expect(port.zeroResults(TENANT, { from: '2026-13-01' })).rejects.toThrow(RANGE_EXPECTED);
    expect(asked).toEqual([]);
  });

  it('with nothing behind it, refuses loudly rather than reporting nothing unanswered', async () => {
    await expect(unconfiguredAnalytics.zeroResults(TENANT, {})).rejects.toThrow(/wiring bug/u);
  });
});

describe('the route', () => {
  const get = (path: string, role: 'OWNER' | 'EDITOR' = 'OWNER') => {
    const asked: [string, unknown][] = [];
    const analytics: AnalyticsPort = {
      funnel: () => Promise.reject(new Error('not this route')),
      top: () => Promise.reject(new Error('not this route')),
      refusedOrigins: () => Promise.reject(new Error('not this route')),
      zeroResults: (tenantId, range) => {
        asked.push([tenantId, range]);
        return reading([question('avete un passito?', ['c1'])]).port.zeroResults(tenantId, range);
      },
    };
    const response = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, role),
      analytics,
    }).request(path);

    return { asked, response };
  };

  it.each(['OWNER', 'EDITOR'] as const)(
    'answers %s: every member reads analytics',
    async (role) => {
      const { asked, response } = get('/v1/dashboard/analytics/zero-results', role);

      expect((await response).status).toBe(200);
      expect(asked.map(([tenantId]) => tenantId)).toEqual([TENANT]);
    },
  );

  it('passes the days asked for, and nothing else', async () => {
    const { asked, response } = get(
      '/v1/dashboard/analytics/zero-results?from=2026-09-01&to=2026-09-07&tenantId=x',
    );

    expect((await response).status).toBe(200);
    expect(asked).toEqual([[TENANT, { from: '2026-09-01', to: '2026-09-07' }]]);
  });

  it('refuses a range that is not one with a 422 saying what is wanted', async () => {
    const response = await get('/v1/dashboard/analytics/zero-results?to=domani').response;

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain('YYYY-MM-DD');
  });
});
