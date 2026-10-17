import { Writable } from 'node:stream';

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { loggerOptions } from '../src/middleware/logger.js';
import {
  emitMetrics,
  metricLine,
  QUOTA_REFUSALS_METRIC,
  REFUSED_ORIGINS_METRIC,
  WIDGET_METRIC_NAMESPACE,
} from '../src/metrics.js';

/**
 * Metric lines (P7-02): what CloudWatch needs to find in one, and why they do
 * not go through the logger.
 *
 * That the routes write them — a refused origin, a spent month, a chat turn —
 * is asserted where those routes are tested (`widget-chat.test.ts`).
 */

interface EmfLine {
  readonly _aws: {
    readonly Timestamp: number;
    readonly CloudWatchMetrics: readonly {
      readonly Namespace: string;
      readonly Dimensions: readonly (readonly string[])[];
      readonly Metrics: readonly { readonly Name: string; readonly Unit: string }[];
    }[];
  };
  readonly Stage: string;
  readonly [metric: string]: unknown;
}

describe('a metric line', () => {
  it('is what CloudWatch extracts a metric from: the envelope, the dimension, the number', () => {
    const line = JSON.parse(
      metricLine(
        {
          namespace: 'Catalogorosso/Chat',
          stage: 'production',
          metrics: { Turns: 1, Escalations: 0 },
        },
        1_760_263_200_000,
      ),
    ) as EmfLine;

    expect(line).toEqual({
      _aws: {
        Timestamp: 1_760_263_200_000,
        CloudWatchMetrics: [
          {
            Namespace: 'Catalogorosso/Chat',
            Dimensions: [['Stage']],
            Metrics: [
              { Name: 'Turns', Unit: 'Count' },
              { Name: 'Escalations', Unit: 'Count' },
            ],
          },
        ],
      },
      Stage: 'production',
      Turns: 1,
      Escalations: 0,
    });
  });

  it('carries numbers and nothing else, which is what makes it safe to write unredacted', () => {
    const line = JSON.parse(
      metricLine({
        namespace: WIDGET_METRIC_NAMESPACE,
        stage: 'dev',
        metrics: {
          [REFUSED_ORIGINS_METRIC]: 3,
          /* What a careless caller could hand it, past the type. */
          question: 'qualcosa per una bistecca' as unknown as number,
          email: 'giulia@example.com' as unknown as number,
          broken: Number.NaN,
          endless: Number.POSITIVE_INFINITY,
        },
      }),
    ) as EmfLine;

    expect(Object.keys(line).sort()).toEqual(['RefusedOrigins', 'Stage', '_aws']);
    expect(line._aws.CloudWatchMetrics[0]?.Metrics).toEqual([
      { Name: 'RefusedOrigins', Unit: 'Count' },
    ]);
    expect(JSON.stringify(line)).not.toContain('bistecca');
    expect(JSON.stringify(line)).not.toContain('giulia');
  });

  it('names the two things the widget’s alarms count', () => {
    expect([WIDGET_METRIC_NAMESPACE, REFUSED_ORIGINS_METRIC, QUOTA_REFUSALS_METRIC]).toEqual([
      'Catalogorosso/Widget',
      'RefusedOrigins',
      'QuotaRefusals',
    ]);
  });

  it('is written whole, and a sink that fails fails nobody', () => {
    const written: string[] = [];

    emitMetrics({ namespace: 'N', stage: 's', metrics: { Count: 2 } }, (line) => {
      written.push(line);
    });

    expect(written).toHaveLength(1);
    expect((JSON.parse(written[0] ?? '{}') as EmfLine).Count).toBe(2);
    expect(() => {
      emitMetrics({ namespace: 'N', stage: 's', metrics: { Count: 1 } }, () => {
        throw new Error('stdout is closed');
      });
    }).not.toThrow();
  });
});

describe('why it does not go through the logger', () => {
  /** The process logger, as configured, writing to a buffer instead of stdout. */
  const logged = (fields: Record<string, unknown>): Record<string, unknown> => {
    const lines: string[] = [];
    const log = pino(
      /* The suite runs silent; this is the one place a line has to be written to be read. */
      { ...loggerOptions, level: 'info' },
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );

    log.info(fields, 'widget chat turn');

    return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  };

  it('has every key of it redacted there, so CloudWatch finds no metric and the alarm never fires', () => {
    /*
     * This is the line the chat route wrote from P2-28 until P7-02, and the
     * reason `ChatEscalationRate` could not fire. The redaction is right — the
     * allowlist governs every key for every caller (P0-56) — and the metric was
     * in the wrong place. Kept as a test so the next metric is not put there.
     */
    const line = JSON.parse(
      metricLine({ namespace: 'Catalogorosso/Chat', stage: 'production', metrics: { Turns: 1 } }),
    ) as Record<string, unknown>;

    expect(logged(line)).toMatchObject({
      _aws: '[redacted]',
      Stage: '[redacted]',
      Turns: '[redacted]',
    });
  });
});
