import process from 'node:process';

/**
 * Metrics, as lines CloudWatch reads (Embedded Metric Format).
 *
 * **Written to stdout directly, never through the logger** (P7-02). The logger
 * redacts every key that is not on its allowlist (P0-56), and a metric line's
 * keys are not: `_aws`, the dimension, the metric's own name. Sent through it,
 * the line arrives as `"_aws":"[redacted]"`, CloudWatch finds no metric in it,
 * and the alarm on that metric sits quiet for ever — which is what
 * `ChatEscalationRate` did from the day it was written until this file was.
 *
 * Widening the allowlist would have been the wrong repair: a name added there
 * is open at every depth for every caller. What makes it safe to go around the
 * logger instead is the type below — **a metric is a number, and nothing else
 * can be put in the line**: no message, no id, no address. The one string is
 * the stage, which is the deployment's own name.
 *
 * The worker's jobs have always written their lines this way (`sweep.ts`,
 * `rollup.ts`), which is why their alarms worked.
 */

/** Refusals the widget's guards make, counted for the alarms that watch them. */
export const WIDGET_METRIC_NAMESPACE = 'Catalogorosso/Widget';

/**
 * A request for a key from a site that winery has not verified (§3.2). A run of
 * them is a copied snippet or a seller's own misconfiguration; both want a look.
 */
export const REFUSED_ORIGINS_METRIC = 'RefusedOrigins';

/** A message turned away because the winery's month is spent (P2-36). */
export const QUOTA_REFUSALS_METRIC = 'QuotaRefusals';

export interface Metrics {
  readonly namespace: string;
  /** The one dimension: which deployment this is. */
  readonly stage: string;
  /** Counts, by metric name. A value that is not a finite number is left out. */
  readonly metrics: Readonly<Record<string, number>>;
}

export type MetricSink = (line: string) => void;

/** One EMF line: the envelope CloudWatch looks for, the dimension, and the numbers. */
export const metricLine = (
  { namespace, stage, metrics }: Metrics,
  now: number = Date.now(),
): string => {
  /* `Number.isFinite` is false for anything that is not a number at all, a string included. */
  const counted = Object.entries(metrics).filter(([, value]) => Number.isFinite(value));

  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [['Stage']],
          Metrics: counted.map(([Name]) => ({ Name, Unit: 'Count' })),
        },
      ],
    },
    Stage: stage,
    ...Object.fromEntries(counted),
  });
};

const toStdout: MetricSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/**
 * Writes the line. **Never fails its caller**: a metric is not worth a
 * visitor's answer, and a refusal that could not be counted is still a refusal.
 */
export const emitMetrics = (metrics: Metrics, sink: MetricSink = toStdout): void => {
  try {
    sink(metricLine(metrics));
  } catch {
    /* Nothing to do, and nowhere better to say so than the log this could not reach. */
  }
};
