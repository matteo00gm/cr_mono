/**
 * Public surface of `@catalogorosso/llm` (P1-42, P1-43).
 *
 * The model adapters behind P1-41's `LlmProvider` port. Each translates one
 * vendor's streaming format into our chunks, using the shared prompt (P2-23)
 * and schema (P2-24) rather than its own. Imported by the API's chat route and
 * the eval harness; a browser bundle may not import it at all, because it
 * carries vendor SDKs and reads provider credentials.
 */
export {
  bedrockNovaProvider,
  NOVA_MAX_TOKENS,
  NOVA_TEMPERATURE,
  novaRequest,
  PAIRING_TOOL,
  toNovaMessages,
  type NovaOptions,
} from './bedrock-nova.js';

export {
  GEMINI_MAX_TOKENS,
  GEMINI_TEMPERATURE,
  geminiProvider,
  geminiRequest,
  toGeminiContents,
  toGeminiSchema,
  type GeminiOptions,
} from './gemini.js';

export type { PairingUsage } from './usage.js';
