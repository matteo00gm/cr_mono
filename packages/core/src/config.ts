/**
 * Configuration loading (P0-15).
 *
 * This package stays free of the AWS SDK on purpose — see the P0-09 boundary
 * rule. The store is a port; the SSM-backed adapter is constructed at the edge,
 * in the app that owns the IAM role. That keeps these tests plain unit tests
 * with no mocked cloud, which is the stated reason the boundary exists.
 */

/** Namespaced parameter path: `/sommelier/<stage>/<name>` (§P0-15). */
export const parameterPath = (stage: string, name: string): string => `/sommelier/${stage}/${name}`;

/**
 * Reads parameters by full path.
 *
 * Implementations must **omit** names they cannot read rather than returning an
 * empty string for them. The difference decides whether a denied IAM path
 * surfaces as a clear failure or as a silently empty secret.
 */
export interface ParameterStore {
  get(paths: readonly string[]): Promise<Readonly<Record<string, string>>>;
}

/** Thrown when any requested parameter is absent or blank. */
export class MissingConfigError extends Error {
  public readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Missing configuration: ${missing.join(', ')}. ` +
        'Check the parameter exists for this stage and that the function role grants ssm:GetParameter on it.',
    );
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

/**
 * Builds a memoised loader.
 *
 * Memoised on the resolved promise, not the value, so concurrent callers during
 * a cold start share one round trip. A rejected load is evicted, so a transient
 * SSM failure does not poison the container for its whole life — caching the
 * failure would turn one blip into an outage lasting as long as the container.
 */
export const createConfigLoader = <Name extends string>(
  store: ParameterStore,
  options: { readonly stage: string; readonly names: readonly Name[] },
): (() => Promise<Readonly<Record<Name, string>>>) => {
  let inflight: Promise<Readonly<Record<Name, string>>> | undefined;

  const load = async (): Promise<Readonly<Record<Name, string>>> => {
    const paths = options.names.map((name) => parameterPath(options.stage, name));
    const raw = await store.get(paths);

    const resolved = {} as Record<Name, string>;
    const missing: string[] = [];

    for (const name of options.names) {
      const value = raw[parameterPath(options.stage, name)];
      // Fail closed. An absent or blank secret must never reach the caller as
      // `undefined`, which reads as "not configured" and tends to be treated
      // as a default rather than an error.
      if (value === undefined || value.length === 0) {
        missing.push(parameterPath(options.stage, name));
      } else {
        resolved[name] = value;
      }
    }

    if (missing.length > 0) throw new MissingConfigError(missing);
    return Object.freeze(resolved);
  };

  return () => {
    inflight ??= load().catch((error: unknown) => {
      inflight = undefined;
      throw error;
    });
    return inflight;
  };
};
