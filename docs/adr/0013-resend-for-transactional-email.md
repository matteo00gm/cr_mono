# 0013. Resend for transactional email

Status: Accepted
Date: 2026-09-05

## Context

Quota warnings, domain-claim notices, trial expiry and password resets all need email, whatever
the authentication choice turns out to be.

## Decision

Resend, with our own templates, behind a single `sendEmail` seam.

## Consequences

The free tier covers this scale, with two caveats that shape the design rather than being
footnotes: a 100-per-day cap means sends have to be staggered and an unlimited password-reset
endpoint is a way to burn it, and bounce suppression has to be handled rather than assumed.

The seam matters more than the vendor. One function means the provider can change without
touching a call site, and it means the placeholder that exists before the account is set up can
be a deliberate no-op rather than a broken import.

## Alternatives rejected

**Amazon SES** is cheaper at volume and requires leaving the sandbox, which is a support ticket
and a delay at exactly the point where the product needs to send its first email.
