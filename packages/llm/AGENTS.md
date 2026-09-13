# packages/llm

The model adapters behind P1-41's `LlmProvider` port, one file per provider. Imported by the API's chat route and the eval harness; never by a browser bundle.

## Invariants

- **Never write a prompt or a schema here.** Every adapter calls `buildPairingPrompt` and projects `pairingJsonSchema()`. An adapter with a prompt of its own escapes P2-23's sanitising, and in the bake-off it measures a different product (P2-23, P2-24, P1-47).
- **Never throw from `streamPairing` for a model or provider failure.** A refusal, a schema failure or a provider error is a chunk. A thrown error loses the text already streamed and skips P2-27's fallback (P1-41).
- **Never emit recommendations that did not pass `parsePairingOutput` and `leaksInstructions`.** Unvalidated output never becomes a card (P2-24, P2-25).
- **Hand the abort signal to the SDK call**, not only to the loop that reads the stream. A visitor who leaves must cancel the request in flight, or it runs on and is billed (P1-41).
- **Never import this package from `apps/dashboard` or `apps/widget`.** It carries vendor SDKs and reads provider credentials; `no-llm-in-browser-bundles` in `.dependency-cruiser.mjs` refuses it (P1-42).
- **Never let a vendor SDK read its credentials from the environment.** Keys come from SSM through the caller and are passed in; a factory given none throws rather than let the SDK fall back to `GEMINI_API_KEY`, or to `ANTHROPIC_API_KEY` and login profiles (P1-43, P1-44).
- **Never stream structured output to the visitor as it arrives.** Where the answer is JSON text, as Gemini's is, a delta is a fragment of JSON, not a sentence; the reply is said only after the whole answer has passed validation (P1-43).
- **Read the stop reason before the content.** A refusal can arrive as a successful response whose text so far looks like an answer; it is a `refusal` chunk, never cards (P1-44).
- **Every adapter runs the shared provider suite**, `test/provider-contract.ts`, with fakes in its own wire format. A vendor-specific test file does not replace it (P1-43).
- **A live test is skipped unless its `LIVE_*` variable is set.** Those tests cost money and need credentials, so they run with the bake-off, never in CI (P1-42, P1-47).

## Adding a provider

Implement `LlmProvider` in one file, forcing structured output through the provider's own mechanism with `pairingJsonSchema()` converted to what it accepts. Map refusals, schema failures and provider errors to their chunks, and report `PairingUsage` through `onUsage`.
