# Running the pairing bake-off (P1-47)

The bake-off picks the default pairing model on evidence rather than on price alone. Each candidate is run against the golden dataset, the table is read, and the decision is written down as an ADR.

Everything it needs already exists:

- the adapters in `packages/llm` (P1-42 to P1-44)
- the dataset and harness in `packages/eval` (P1-45, P1-46)
- `pnpm eval`

What it needs from a person: credentials, agreed spend, and the decision.

## Before you start

- **Credentials live in your shell, never in a file.** Nothing here reads a `.env` file, and nothing should.
- **Bedrock model access in `eu-west-1`** for Nova Micro, Nova Lite and Nova 2 Lite, requested in the Bedrock console. A model being available in a region doesn't grant you access to it (ADR 0014).
- **A Gemini API key and an Anthropic API key**, each with a spending limit set in its own console.
- **Agreed spend.** `pnpm eval` sends 60 pairings twice, so each candidate costs 120 requests with a few thousand input tokens each. Price that from each provider's current pricing page before starting, and add the three live tests below.

Build first, because the suites and the CLI import built output:

```bash
pnpm build
```

## 1. Prove each adapter against the real API

The live tests check what the fakes can't: that each provider accepts the structured-output schema it is sent, and, for Nova, that the prompt cache is hit. A failure here is a finding, not a flake. A schema the provider rejects fails every request.

```bash
LIVE_BEDROCK=1 BEDROCK_NOVA_MODEL_ID=<inference profile id> pnpm exec vitest run packages/llm/test/bedrock-nova.live.test.ts
```

```bash
LIVE_GEMINI=1 GEMINI_MODEL=<model id> pnpm exec vitest run packages/llm/test/gemini.live.test.ts
```

```bash
LIVE_ANTHROPIC=1 ANTHROPIC_MODEL=claude-haiku-4-5 pnpm exec vitest run packages/llm/test/anthropic.live.test.ts
```

`GEMINI_API_KEY` and `ANTHROPIC_API_KEY` must already be exported in the shell. Nova reads the usual AWS credential chain and region.

## 2. Run each candidate

```bash
EVAL_PROVIDER=nova EVAL_MODEL=<inference profile id> pnpm eval
```

```bash
EVAL_PROVIDER=gemini EVAL_MODEL=<model id> pnpm eval
```

```bash
EVAL_PROVIDER=anthropic EVAL_MODEL=claude-haiku-4-5 pnpm eval
```

Run the Nova line once per Nova candidate.

Each run prints two things:

- one table row, with both runs in every cell
- the query ids reserved for human rating

`pnpm eval` refuses to start if any variable it needs is missing.

## 3. Read the table

- **Read the verdict first.** `disqualified` means schema failures above 2% in either run. That is a security criterion, not a quality preference: P2-25 depends on valid structured output, and no price makes up for it.
- **Check the spread before comparing.** Two providers closer together than either one's run-to-run spread can't be told apart.
- **Don't decide on recall@8 or MRR.** Until P2-20 exists they describe the lexical stand-in retriever, not the product.
- **Rate pairing quality by hand.** No judge model is wired yet, so rate the reserved sample against `PAIRING_RUBRIC` in `packages/eval/src/rubric.ts`. A defensible wine given for a wrong reason is a fail.
- **Work out cost per 1,000 messages** from the provider's reported token usage and its current prices.

## 4. Record the decision

Write the next ADR in `docs/adr/` from the template. It confirms or supersedes ADR 0014, and it holds:

- the table
- cost per 1,000 messages
- the human ratings
- the choice, and the escalation tier

The chat route (P2-29) takes its default provider from that ADR. The chosen provider's numbers become the regression baseline for P2's prompt work.
