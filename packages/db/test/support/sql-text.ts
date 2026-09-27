/**
 * The SQL text of a Drizzle `sql` template, for assertions about a statement.
 *
 * **Recursive, and that is the whole reason this file exists.** A statement
 * built from fragments — `${COLUMNS}`, `${predicate}` — carries them as nested
 * `queryChunks`, and a helper that reads one level returns nothing for them. A
 * negative assertion (`not.toContain('tenant_id')`) about a fragment then
 * passes whatever the fragment says. Eleven test files each had a copy of this
 * helper, and five of those copies read one level only.
 *
 * Bound parameters are not text and are left out: an assertion that a value is
 * *bound* belongs on `PgDialect().sqlToQuery(...).params`.
 */
export const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [])
    .flatMap((chunk): string[] => {
      if (typeof chunk !== 'object' || chunk === null) return [];

      const { value } = chunk as { value?: unknown };

      if (Array.isArray(value))
        return value.filter((part): part is string => typeof part === 'string');

      return Array.isArray((chunk as { queryChunks?: unknown }).queryChunks) ? [text(chunk)] : [];
    })
    .join(' ');
