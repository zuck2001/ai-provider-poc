# AI Provider PoC

> **Non-production proof of concept.** This repository is a standalone technical investigation for WeXcute and a prospective client. It is not the client's production application and does not provide production authentication, document management, cloud storage, migrations, operational controls, or compliance guarantees.

## Purpose

This small NestJS application demonstrates the core questions from the AI-provider investigation:

- Server-to-server OpenRouter communication using an API key held by the backend.
- Direct and database-managed prompt submission.
- Normalized AI responses with successful and failed generation persistence.
- Retrieval by an internal generation ID.
- One controlled PDF experiment using an inline Base64 document.

The business context is an AI-assisted German R&D tax incentive workflow (Forschungszulage). The PoC intentionally uses only synthetic data.

## Verified capabilities

The following flows have been exercised successfully against OpenRouter:

- Direct text generation through `openrouter/free`.
- Loading and rendering a versioned prompt template from SQLite.
- Persisting and retrieving normalized generation results.
- Sending the synthetic PDF through Chat Completions as inline Base64.
- Explicitly requesting the free `cloudflare-ai` PDF parser.
- Extracting `HELIOS-47` and `18 percent` from the fixture.

Recorded PDF experiment result:

| Field | Value |
|---|---|
| Actual model | `nvidia/nemotron-3.5-super-vl:free` |
| Prompt tokens | 150 |
| Completion tokens | 98 |
| Total tokens | 248 |
| Input mode | `base64` |
| Requested parser | `cloudflare-ai` |
| Status | `completed` |

`parserRequested` records the configuration sent to OpenRouter. It is not independent evidence of the parser OpenRouter executed internally.

## Architecture

```text
HTTP request
    │
    ▼
AiController
    │ validates direct/template requests or selects the fixed PDF fixture
    ▼
GenerationService
    │ renders templates, validates/encodes the PDF, and persists outcomes
    ├──────────────► PromptTemplateService ──► prompt_templates
    │
    ▼
AiService
    │ native fetch + server-side Bearer authentication
    ▼
OpenRouter Chat Completions
    │
    ▼
Normalized response ──► ai_generations ──► retrieval endpoint
```

The OpenRouter boundary returns only the provider request ID, actual model, generated text, and token usage. Raw provider responses, credentials, authorization headers, PDF bytes, and Base64 data URLs are not persisted.

## Technology stack

- Node.js 24 LTS
- NestJS 12
- TypeScript with ESM/NodeNext conventions
- Native `fetch`
- TypeORM with `better-sqlite3`
- Vitest and Supertest
- Oxlint and Prettier

## Prerequisites

- Node.js 24 LTS
- npm
- An OpenRouter API key for manual provider calls

The automated test suites mock OpenRouter and do not consume API credits.

## Installation

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` locally and replace the API-key placeholder. Never commit `.env`.

```dotenv
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openrouter/free
PORT=3000
```

`OPENROUTER_MODEL` is optional in code and defaults to `openrouter/free`. Keep it set to `openrouter/free` for the verified zero-model-cost PoC path. The PDF request explicitly selects `cloudflare-ai` and does not configure a paid model fallback or `mistral-ocr`.

## Run locally

Run commands from the repository root so the fixed PDF and default database paths resolve correctly.

```powershell
npm run start:dev
```

The API listens on `http://localhost:3000` by default. The local database is created at `data/ai-provider-poc.sqlite`.

## API examples

### Direct prompt

```powershell
$body = @{
  prompt = "Explain R&D tax credits in one sentence."
} | ConvertTo-Json

$result = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/ai/generate" `
  -ContentType "application/json" `
  -Body $body

$result
```

### Stored prompt template

At startup, the PoC idempotently seeds version 1 of:

```text
Key: rd-project-summary
Template: Summarize the following R&D project in two sentences: {{description}}
```

Use it with:

```powershell
$body = @{
  templateKey = "rd-project-summary"
  variables = @{
    description = "Development of a new energy-efficient battery system."
  }
} | ConvertTo-Json -Depth 3

$result = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/ai/generate" `
  -ContentType "application/json" `
  -Body $body

$result
```

The latest template version is selected deterministically by descending version number. Missing placeholders are rejected; values are inserted literally and are never executed as template code.

### Synthetic PDF experiment

```powershell
$result = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/ai/analyze-pdf"

$result
```

This endpoint accepts no upload and always reads `test-assets/synthetic-rd-project.pdf`. It verifies existence, enforces a 1 MiB maximum, checks the `%PDF-` signature, creates an in-memory Base64 data URL, and submits the fixed question:

```text
What is the project codename, and by what percentage was battery cooling energy consumption reduced? Answer briefly using only the attached document.
```

The expected answer contains `HELIOS-47` and either `18%` or `18 percent`.

The OpenRouter content parts are conceptually:

```json
[
  {
    "type": "text",
    "text": "<fixed question>"
  },
  {
    "type": "file",
    "file": {
      "filename": "synthetic-rd-project.pdf",
      "file_data": "data:application/pdf;base64,<in-memory bytes>"
    }
  }
]
```

The request also includes:

```json
{
  "plugins": [
    {
      "id": "file-parser",
      "pdf": {
        "engine": "cloudflare-ai"
      }
    }
  ],
  "max_tokens": 100
}
```

The Base64 value is neither logged nor stored.

### Retrieve a generation

Every successful generation response includes both IDs:

```json
{
  "generationId": "internal-database-uuid",
  "id": "openrouter-provider-request-id",
  "model": "actual/model-returned-by-openrouter",
  "content": "Generated text",
  "usage": {
    "promptTokens": 10,
    "completionTokens": 5,
    "totalTokens": 15
  }
}
```

Retrieve the persisted result using the internal `generationId`:

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/ai/generations/$($result.generationId)"
```

Retrieval returns status, provider request ID, actual model, response text, usage, PDF-mode metadata when applicable, and creation timestamp. It does not return credentials, raw provider payloads, or PDF content.

## Persistence

`prompt_templates` contains:

- Internal UUID.
- Prompt key.
- Positive integer version.
- Template text.
- Creation timestamp.
- Composite uniqueness on `(key, version)` so a key can have multiple versions.

`ai_generations` contains:

- Internal UUID, distinct from the nullable OpenRouter request ID.
- Nullable exact prompt-template version reference.
- Actual model returned by OpenRouter for completed requests.
- Exact rendered prompt text.
- Nullable response text and token usage.
- `completed` or `failed` status.
- Optional `inputMode` and `parserRequested` experiment metadata.
- Creation timestamp.

Failed provider calls are persisted without raw provider error bodies, credentials, or authorization headers.

The project uses `synchronize: true` solely to keep this local PoC small. **It must not be used in production.** A production system requires reviewed migrations and a production database.

## Testing and validation

```powershell
npm run build
npm run lint
npm test
npm run test:e2e
```

Focused tests cover:

- Text response normalization and regression behavior.
- Missing configuration, HTTP failures, malformed responses, network errors, and timeouts.
- Prompt validation.
- Template seeding, latest-version selection, literal interpolation, and missing variables.
- Successful and failed persistence.
- Generation retrieval and missing IDs.
- Valid, missing, malformed, and oversized synthetic PDFs.
- Exact multimodal request shape and explicit `cloudflare-ai` parser selection.

Unit persistence tests and E2E tests use isolated in-memory SQLite databases. OpenRouter calls are mocked.

## File-handling investigation

The full read-only investigation is preserved at [docs/openrouter-file-handling-investigation.md](docs/openrouter-file-handling-investigation.md).

Its conclusions are:

- Inline Base64 is the smallest meaningful OpenRouter PDF experiment.
- Private cloud object storage should remain the source of truth in a future production design.
- Server-side text extraction is a strong default for narrative documents.
- Short-lived signed URLs or native PDF processing should be considered selectively for scans, tables, diagrams, and layout-dependent content.
- OpenRouter's persistent Files API is not needed for this PoC.

No cloud storage or signed URL support is implemented here.

## Security and operational limitations

This PoC deliberately has significant non-production limitations:

- No authentication, authorization, tenant isolation, or rate limiting.
- Endpoints must not be exposed publicly.
- No upload endpoint, malware scanning, PDF structural validation, OCR, or content moderation.
- The PDF signature check is intentionally minimal and not a security scanner.
- No secrets manager or API-key rotation workflow.
- No request tracing, metrics, audit log, retries, or production observability.
- No transactional outbox or queue; provider calls and database writes are synchronous.
- Failed database persistence can obscure the original provider error.
- SQLite and schema synchronization are local-development choices only.
- `openrouter/free` is dynamically routed and its selected model can change.
- `parserRequested = cloudflare-ai` records intent, not independent proof of execution.
- Provider privacy, retention, training, regional routing, and contractual terms require separate legal and security review before real client data is used.
- Uploaded documents can contain prompt injection; this PoC has no document-tool execution but does not claim complete prompt-injection protection.

Only the synthetic PDF may be used for demonstrations. Do not use real company, employee, salary, or client documents.

## Repository outputs and secrets

The following are intentionally ignored by Git:

- `.env` and environment variants, except `.env.example`.
- `node_modules/`.
- `dist/` and TypeScript build metadata.
- Local SQLite databases and their WAL/journal sidecars under `data/`.
- Log files.

Do not commit API keys, generated databases, logs, Base64 documents, or real client content.

## Further work

Any production follow-up should happen in the actual client architecture and separately evaluate authentication, tenant isolation, EU-region private object storage, upload validation, malware scanning, extraction/OCR quality, provider policies, data retention, migrations, and operational monitoring. Those concerns are intentionally outside this PoC.
