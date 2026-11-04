# Provider-agnostic AI service (Strategy pattern in NestJS)

## Context
`AiService` ([src/ai/ai.service.ts](../src/ai/ai.service.ts)) is hard-wired to OpenRouter: the URL, the `OPENROUTER_*` env vars, the request format (the `file-parser` plugin), and the response parsing. OpenRouter details have also spread beyond that file:
- [generation.service.ts:70-81](../src/ai/generation.service.ts#L70-L81) builds an OpenRouter-style data URL and hard-codes `parserRequested: 'cloudflare-ai'`.
- [ai-generation.entity.ts:9](../src/ai/entities/ai-generation.entity.ts#L9) imports `AiUsage` from `ai.service.js`.

Goal: after this one-time refactor, switching providers is a config change only, with no code changes in the controller, `GenerationService`, or persistence. The plan uses hand-written strategies with no new dependencies (user's choice). Only OpenRouter is implemented in this step.

## Features the abstraction must keep (from the current code and tests)
| Feature | Where it lives today | Where it goes |
|---|---|---|
| `generate(prompt)` | `AiService.generate` | `AiProvider.generate` |
| PDF + prompt (base64, 1 MB limit, `%PDF-` check) | checks in `GenerationService`; payload in `AiService.generateWithPdf` | checks stay in `GenerationService`; payload built by each provider |
| `max_tokens: 100` for PDF only | `AiService.generateWithPdf` | `opts.maxTokens`, passed by `GenerationService` |
| Normalized `AiResponse {id, model, content, usage}` | `AiService.request` | `OpenRouterAiProvider` |
| Missing API key → 500, checked **when a request is made** (not at startup), no fetch | spec: "rejects a missing API key" | `OpenRouterAiProvider` (kept lazy, so an unused provider never needs keys) |
| Non-2xx → 502 with `providerStatus` | spec: "sanitizes…" | `OpenRouterAiProvider` |
| Network error → 503, timeout (30 s) → 504, malformed body → 502 | spec | `OpenRouterAiProvider` |
| Persisted `providerRequestId`, `model`, `usage`, `inputMode`, `parserRequested` | `GenerationService.generateAndPersist` | unchanged, except `parserRequested` now comes from the provider |
| Default model `openrouter/free` | `AiService.request` | OpenRouter provider config |

## Design

**`src/ai/providers/ai-provider.ts`** (new): the contract plus the shared types (moved out of `ai.service.ts`).
```ts
export interface AiUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number }
export interface AiResponse { id: string; model: string; content: string; usage: AiUsage | null }
export interface PdfAttachment { filename: string; mimeType: 'application/pdf'; base64: string } // raw base64, no data-URL prefix
export interface GenerateOptions { maxTokens?: number }

export abstract class AiProvider {
  abstract readonly name: string;              // 'openrouter' | 'openai'
  abstract readonly pdfParser: string | null;  // what gets persisted as parserRequested
  abstract generate(prompt: string, opts?: GenerateOptions): Promise<AiResponse>;
  abstract generateWithPdf(prompt: string, file: PdfAttachment, opts?: GenerateOptions): Promise<AiResponse>;
}
```
- Raw base64 + mimeType rather than a data URL. OpenAI-style APIs need a data URL; Anthropic/Gemini-style APIs need raw base64. Each provider formats it.
- `pdfParser` stops `GenerationService` from hard-coding `'cloudflare-ai'`.
- The abstract class is both the contract and the Nest DI token, so consumers just write `constructor(private ai: AiProvider)`.

**`src/ai/providers/openrouter.provider.ts`** (new): `OpenRouterAiProvider extends AiProvider` directly and holds the former `AiService` logic: lazy key check, fetch with 30 s timeout, error mapping, response validation, and the usage mapping from snake_case to camelCase. It reads `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` (default `openrouter/free`), sets `pdfParser = 'cloudflare-ai'`, and adds the `file-parser` plugin to PDF requests. `max_tokens` is sent only when `opts.maxTokens` is set, so the request body stays exactly the same as today.

**`src/ai/providers/openai.provider.ts`** (added later): `OpenAiProvider extends AiProvider` directly, with no shared base class. It calls `https://api.openai.com/v1/chat/completions` and requires both `OPENAI_API_KEY` and `OPENAI_MODEL`. It sends `max_completion_tokens` rather than `max_tokens`, because reasoning models reject `max_tokens` ([OpenAI help center](https://help.openai.com/en/articles/5072518-controlling-the-length-of-openai-model-responses)). PDFs go as a `file`/`file_data` data-URL content part ([File inputs guide](https://developers.openai.com/api/docs/guides/file-inputs)), and `pdfParser` is `null`. Because the request and error-handling code is copied rather than shared, `providers/ai-provider.contract.spec.ts` runs the same error tests against every class in `AI_PROVIDER_CLASSES`. A shared `OpenAiCompatibleProvider` base class remains deferred.

**`src/ai/providers/ai-provider.factory.ts`** (new) and **[src/ai/ai.module.ts](../src/ai/ai.module.ts)**: `AI_PROVIDER_CLASSES` lists the available strategies. `aiProviderFactory` binds the `AiProvider` token to the one whose `name` matches `AI_PROVIDER` (default `openrouter`), and an unknown value throws at startup. Adding a provider means adding a class that extends `AiProvider` to that list.

**[src/ai/generation.service.ts](../src/ai/generation.service.ts)**: inject `AiProvider`. Pass `{ filename, mimeType, base64: pdf.toString('base64') }` and `{ maxTokens: 100 }`. Persist `parserRequested: this.provider.pdfParser` and `provider: this.provider.name` on both the success and the failure path.

**Record which provider served each generation:** add a nullable `provider` column to [ai-generation.entity.ts](../src/ai/entities/ai-generation.entity.ts) (`synchronize: true` already handles this in the PoC) and return it in `StoredGenerationResponse`. Without it, stored rows from different providers can't be told apart. Also repoint the entity's `AiUsage` import to `providers/ai-provider.js`.

**Cleanup:** delete `src/ai/ai.service.ts`. Add `AI_PROVIDER=openrouter` to `.env.example`. Update the README's `AiService` and env-var sections (`README.md:56`, `README.md:95-100`) to describe `AI_PROVIDER` and the provider classes. Leave the older investigation docs that mention `AiService` as they are, because they're historical records. Standalone `scripts/*.mjs` stay OpenRouter-specific, which is fine.

## Tests
- Move [ai.service.spec.ts](../src/ai/ai.service.spec.ts) to `providers/openrouter.provider.spec.ts`. Only the call sites change, to `generateWithPdf('Question', { filename, mimeType, base64: 'JVBERi0=' }, { maxTokens: 100 })`. The assertions on the exact request body stay word for word and must still pass, which proves the wire format didn't change. Add tests for `name`/`pdfParser`, a configured model, and an explicit token limit.
- [generation.service.spec.ts](../src/ai/generation.service.spec.ts): the mock becomes `{ name, pdfParser, generate, generateWithPdf }` cast to `AiProvider`. Assert the persisted `provider`/`parserRequested` values and the `{ maxTokens: 100 }` argument.
- `providers/ai-provider.factory.spec.ts`: an unset or blank `AI_PROVIDER` resolves OpenRouter, a matching name resolves that provider, and an unknown value throws.
- The controller spec doesn't change.

## Verification
- `npm run test`, `npm run test:e2e`, `npm run build`, `npm run lint`.
- `grep -rn "AiService\|ai.service" src test` returns nothing.
- `npm run start:dev` with the default config, then `POST /ai/generate` and `POST /ai/analyze-pdf`. Responses should match the current behaviour, and `GET /ai/generations/:id` should show `provider: "openrouter"`, `parserRequested: "cloudflare-ai"`.
