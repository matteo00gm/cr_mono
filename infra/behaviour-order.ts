/**
 * Whether every CloudFront behaviour can be reached (review fix).
 *
 * **CloudFront takes the first ordered behaviour whose pattern matches, not the
 * most specific.** A pattern placed after a broader one is dead, and nothing
 * fails: `/v1/*` ahead of `/v1/widget/config` means the config cache never
 * applies and the API simply answers uncached, and P3's `/v1/widget-*.js` after
 * `/v1/*` would serve the widget bundles from the API Lambda as JSON 404s.
 * `cdn.ts` said "inserted, not appended" in a comment; this is what holds it.
 *
 * Here rather than in `cdn.ts`, which constructs resources at import and cannot
 * be loaded outside a deploy.
 */

/** A CloudFront path pattern as a regular expression: `*` is any run of characters, `?` exactly one. */
const toRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${[...pattern]
      .map((char) => {
        if (char === '*') return '.*';
        if (char === '?') return '.';
        return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      })
      .join('')}$`,
  );

/** A path the pattern certainly matches, with each wildcard filled in. */
const sampleOf = (pattern: string): string => pattern.replaceAll('*', 'x').replaceAll('?', 'x');

export interface ShadowedBehaviour {
  readonly pattern: string;
  /** The earlier pattern CloudFront would match first. */
  readonly shadowedBy: string;
}

/**
 * Every behaviour an earlier one would take requests from.
 *
 * Conservative on purpose: a later pattern counts as shadowed as soon as an
 * earlier one matches a path it was written for. A behaviour that is only
 * partly reachable is a routing mistake too, and the fix is the same — put the
 * specific pattern first.
 */
export const shadowedBehaviours = (patterns: readonly string[]): readonly ShadowedBehaviour[] =>
  patterns.flatMap((pattern, index) => {
    const shadowedBy = patterns
      .slice(0, index)
      .find((earlier) => toRegExp(earlier).test(sampleOf(pattern)));

    return shadowedBy === undefined ? [] : [{ pattern, shadowedBy }];
  });

/**
 * The ordered behaviours, unchanged, once every one of them is reachable.
 *
 * Wrapped around the array in `cdn.ts`, so a distribution with an unreachable
 * behaviour fails to synthesise rather than deploying and quietly misrouting.
 */
export const checkedBehaviourOrder = <T extends { readonly pathPattern: string }>(
  behaviours: T[],
): T[] => {
  const shadowed = shadowedBehaviours(behaviours.map((behaviour) => behaviour.pathPattern));

  if (shadowed.length > 0) {
    throw new Error(
      'CloudFront takes the first matching behaviour, so these cannot apply as written:\n' +
        shadowed
          .map(({ pattern, shadowedBy }) => `    ${pattern} is matched first by ${shadowedBy}`)
          .join('\n') +
        '\n  Move each one above the pattern it names.',
    );
  }

  return behaviours;
};
