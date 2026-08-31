/**
 * Which stages hold real data.
 *
 * Both spellings, for the same reason as `sst.config.ts`: the check is an exact
 * string match, so a stage deployed as `production` rather than `prod` would
 * otherwise be treated as disposable. `sst.config.ts` keeps its own copy
 * because it must stay self-contained — it is evaluated before the infra
 * modules are loaded.
 */
export const PROTECTED_STAGES = new Set(['prod', 'production']);

export const isProtectedStage = (stage: string): boolean => PROTECTED_STAGES.has(stage);
