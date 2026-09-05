/**
 * Commit message rules (P0-61).
 *
 * **Not `@commitlint/config-conventional`, and that is a deliberate departure
 * from the row.** This repository has a convention already — roughly forty
 * commits of `P0-NN: what changed, in plain words` — and conventional commits
 * would reject every one of them.
 *
 * The choice is not arbitrary either way, so here is the reasoning. Conventional
 * commits earn their keep through automated semver and changelog grouping. This
 * is a private monorepo application: every package is `private: true` at version
 * `0.0.0`, nothing is published, and there is no version to bump. What the
 * `feat`/`fix`/`chore` prefix would buy is grouping, and the task id groups
 * better — it points at a specification that explains what the change was *for*,
 * which `feat` does not.
 *
 * So the rule enforces the convention that exists rather than replacing it.
 *
 * Accepted shapes:
 *
 *   P0-54: the API skeleton, and the two surfaces that must never share …
 *   P0-17a: CloudFront behaviours for the API, and two hazards removed …
 *   CI: run the integration suite on every pull request
 *   Plan: the ten-task chain is merged, so say so
 *   Deps: update dependency vitest to v4.1.12
 *
 * Merge commits are ignored by commitlint's own defaults.
 */

/**
 * A task id, or a short capitalised area.
 *
 * The area form exists for the changes that belong to no backlog row — CI
 * wiring, a plan sweep, a dependency bump. Keeping it capitalised and short is
 * what stops it becoming a second, sloppier convention.
 */
const HEADER = /^(P\d-\d{2}[a-z]?|[A-Z][A-Za-z]{1,14}(?: [A-Za-z]{2,14})?): (.+)$/;

export default {
  parserPreset: {
    parserOpts: {
      headerPattern: HEADER,
      // `scope` rather than `type`: the default conventional rules key on
      // `type`, and enabling any of them here would fail on every commit
      // because this parser never produces one.
      headerCorrespondence: ['scope', 'subject'],
    },
  },

  rules: {
    /*
     * 100, against a longest-so-far of 90.
     *
     * Deliberately not the conventional 72. These subjects say what changed in
     * plain words rather than naming a type, and truncating them to fit a
     * convention borrowed from a different workflow would cost the thing that
     * makes them worth reading.
     */
    'header-max-length': [2, 'always', 100],

    // Both halves of the header must exist. A missing scope means the pattern
    // did not match at all, which is the failure worth reporting clearly.
    'scope-empty': [2, 'never'],
    'subject-empty': [2, 'never'],

    // A trailing full stop in a subject reads as a sentence fragment in `git
    // log --oneline`, where every other line has none.
    'subject-full-stop': [2, 'never', '.'],

    /*
     * A body, when there is one, is separated by a blank line — otherwise git
     * folds it into the subject and `%s` returns the whole message.
     *
     * A body is not *required*. The bar this repository actually holds is that
     * the reasoning is written down, and P0-61's mechanism for that is the
     * pull request template, which is where a reviewer reads it. Requiring one
     * here would only push people to write "." to get past the hook.
     */
    'body-leading-blank': [2, 'always'],

    /*
     * `footer-leading-blank` is deliberately **off**, and the first commit
     * written under this config is why.
     *
     * commitlint parses any line beginning `word:` as the start of a footer.
     * The bodies in this repository are prose that routinely quotes
     * configuration — `run: echo …`, `Status: Accepted`, `Verified: …` — so a
     * paragraph explaining a YAML snippet becomes a "footer", and the prose
     * after it is then reported as a body with no leading blank.
     *
     * That is a false positive on legitimate content, and a rule that fires on
     * correct commits is a rule people learn to bypass with `--no-verify` —
     * which switches off the gitleaks and lint-staged hooks at the same time.
     * The cost of dropping it is that a genuinely malformed trailer goes
     * unreported, which is a cosmetic problem where the other is a security one.
     */
  },
};
