# 0018. Typed block templates, not React Email

Status: Accepted
Date: 2026-09-06

## Context

ADR 0013 settled the provider and the seam; it did not settle how a message body gets built.
The set is six templates — invite, password reset, quota at 80%, quota exhausted, trial
expiry, domain-claim notice — each needed in Italian and English, each needing an HTML part
and a plaintext part.

## Decision

Templates return a small list of blocks (`text`, `action`, `note`), and one renderer turns that
list into both parts. No template produces markup itself.

## Consequences

Two properties become structural rather than habitual. HTML escaping happens in exactly one
function, which matters because template props carry seller-supplied text — a winery's own name
— interpolated into mail sent to somebody else. And a template is incapable of producing an
HTML part without a plaintext one, so "always send a plaintext alternative" is a shape rather
than a rule to remember; HTML-only mail scores worse with spam filters, which is an own-goal on
the message a locked-out customer needs.

The renderer also validates link schemes. Escaping does nothing about `javascript:` in an
`href`, since the quotes are already correct, so `http`/`https` is checked where no template can
skip it.

The cost is expressiveness: a template that wants a layout the block list cannot describe has to
extend the block list, which is a deliberate speed bump on a surface that should stay plain.

## Alternatives rejected

**React Email** is genuinely pleasant and is the obvious choice at a larger template count. It
pulls React into a repository that deliberately runs one UI runtime, Preact, and for six
templates that is a large dependency to carry for ergonomics. Revisit past roughly a dozen
templates, or the first time a non-engineer needs to edit the copy — both are real thresholds
rather than a polite deferral.

**Template strings per template** is what the block list replaces. It is less code on day one
and puts six independent copies of the escaping decision into the tree, which is five more
chances to forget than the failure deserves.
