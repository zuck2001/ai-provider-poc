# Large PDF Base64 Performance and Feasibility Benchmark

Investigation date: 3 November 2026

## Executive summary

Local Base64 request preparation works for synthetic PDFs through 100 MiB on the development machine. It is fast in absolute terms—about 1.08 seconds median for 100 MiB—but memory intensive. Preparing a 100 MiB PDF produced a 133.33 MiB Base64 value and a 133.33 MiB JSON body, while the isolated Node.js process reached approximately 545 MiB sampled RSS.

This proves only that the local Node.js conversion and serialization complete. It does **not** prove that OpenRouter, its edge proxy, a selected model provider, or a PDF parser will accept an inline request of that size. No provider request was made.

Inline Base64 is therefore technically possible but not a practical default for average 80–100 MB production documents. It increases transfer size by about one third and, with the current whole-buffer implementation, creates several simultaneous large representations of the same document. A URL/reference or upload-based design should be evaluated for production, subject to security and retention requirements.

## Existing request preparation path

The current fixed-fixture endpoint performs these operations before sending a request:

1. `stat()` the PDF and enforce the existing 1 MiB PoC limit.
2. `readFile()` the complete PDF into a Node.js `Buffer`.
3. Check the first five bytes for `%PDF-`.
4. Call `Buffer.toString('base64')` and prepend `data:application/pdf;base64,`.
5. Insert that string into the Chat Completions file content part.
6. Call `JSON.stringify()` on the complete request body in `AiService`.
7. Pass the serialized body to native `fetch`.

The benchmark reproduces the memory-relevant read, Base64, data-URL, payload-construction, and serialization steps. It deliberately does not perform HTTP upload, TLS transfer, provider parsing, inference, or persistence.

## Synthetic fixture design

The generator creates a structurally valid PDF 1.7 document with:

- one page;
- a visible text layer containing the known synthetic fact `Project codename ATLAS-100; target efficiency gain 23 percent`;
- a statement that it contains no real company or employee information;
- a catalog, page tree, font, content stream, cross-reference table, trailer, and `startxref` pointer;
- one uncompressed, repetitive embedded-file attachment used to bring the file to the requested exact size.

The size is therefore driven by an **embedded attachment**, not by page count, meaningful text, or images. This is suitable for measuring byte handling and JSON preparation, but it is not representative of parser time, token count, OCR work, or model quality for a real 100 MB PDF. Real documents of the same byte size can behave very differently: compressed images may require OCR and CPU time, while a large text layer may generate a very large model context.

Generated fixtures are local-only under `benchmark-assets/`, which is ignored by Git. Exact 10, 50, 80, 100, and 150 MiB fixtures were generated sequentially. A 200 MiB fixture was not generated because it was optional and unnecessary for the stated 80–100 MB decision.

Basic validation confirmed the `%PDF-` header, embedded-file object, known fact, terminal `startxref`, cross-reference location, and exact byte size for every generated fixture. No independent PDF-validator executable was installed on this machine.

## Methodology

- Node.js high-resolution `performance.now()` timings were captured separately for file read, Base64 encoding, and JSON serialization.
- Total preparation time is the sum of those three measured operations.
- Each measured size ran three times.
- Each run used a fresh child process with `--expose-gc` and a 1,024 MiB V8 old-space ceiling.
- Garbage collection was requested before the initial memory snapshot.
- Files were processed one size and one run at a time.
- Before each child run, a conservative guard requires free physical memory of at least `1.25 × (5 × source MiB + 50 MiB)`; otherwise the run stops with an actionable error.
- Base64 and JSON contents were never printed and serialized request bodies were never written to disk.
- Only numeric results were written to the ignored `benchmark-assets/large-pdf-base64-results.json` file.
- RSS and heap figures are process-wide snapshots, not exact per-object attribution.
- “Peak RSS” is the maximum of explicit snapshots immediately before work and after read, Base64 conversion, and serialization. Synchronous operations prevent interval sampling during each individual operation, so a short-lived higher peak could have been missed.
- Reported “MB” fixture targets are implemented as MiB (`1 MiB = 1,048,576 bytes`) for deterministic local measurement.

## Environment

| Item | Value |
|---|---|
| Node.js | v24.22.2 |
| Operating system | Windows 10.0.19045 (`win32`) |
| CPU | Intel Core M-5Y71 @ 1.20 GHz |
| Logical CPUs | 4 |
| Available parallelism | 4 |
| Physical memory reported by Node | 8,500,887,552 bytes (about 7.92 GiB) |
| Free physical memory at benchmark start | 968,208,384 bytes (about 923 MiB) |

Timings and memory figures are machine- and load-specific. They should be treated as evidence of scaling behavior, not universal performance guarantees.

## Results

### Size expansion

| PDF size | Original bytes | Base64 bytes | JSON payload bytes | Base64 ratio |
|---:|---:|---:|---:|---:|
| 10 MiB | 10,485,760 | 13,981,016 | 13,981,345 | 1.333334× |
| 50 MiB | 52,428,800 | 69,905,068 | 69,905,397 | 1.333333× |
| 80 MiB | 83,886,080 | 111,848,108 | 111,848,437 | 1.333333× |
| 100 MiB | 104,857,600 | 139,810,136 | 139,810,466 | 1.333333× |

Base64 follows its expected `4 × ceil(n / 3)` size relationship. JSON structure added only about 329–330 bytes in this fixed payload because the large Base64 alphabet does not require JSON escaping.

In practical terms, an 80 MiB file became a 106.67 MiB request body and a 100 MiB file became a 133.33 MiB request body, before HTTP headers and transport framing.

### Timings

All values are milliseconds across three isolated runs.

| PDF size | Read median / max | Base64 median / max | JSON median / max | Total median / max |
|---:|---:|---:|---:|---:|
| 10 MiB | 8.64 / 10.03 | 8.01 / 10.23 | 50.80 / 53.73 | 68.84 / 72.61 |
| 50 MiB | 49.47 / 104.88 | 46.74 / 61.92 | 199.55 / 295.61 | 306.19 / 447.23 |
| 80 MiB | 140.06 / 150.56 | 56.81 / 129.08 | 364.60 / 590.76 | 569.55 / 859.89 |
| 100 MiB | 124.64 / 215.51 | 108.12 / 147.01 | 813.64 / 815.06 | 1,081.56 / 1,104.21 |

JSON serialization was the dominant local preparation cost. The non-monotonic read timings reflect operating-system file caching and other machine activity.

### Memory

Values are MiB. Peak means the highest sampled process-wide RSS stage, not exact memory attributable solely to the PDF.

| PDF size | RSS before median | RSS after median | RSS increase median / max | Peak RSS median / max | Heap increase median |
|---:|---:|---:|---:|---:|---:|
| 10 MiB | 44.79 | 95.14 | 50.35 / 50.36 | 95.14 / 95.14 | 26.67 |
| 50 MiB | 44.66 | 294.88 | 250.22 / 250.22 | 294.88 / 295.01 | 133.34 |
| 80 MiB | 44.70 | 435.62 | 400.14 / 400.50 | 435.62 / 445.00 | 213.33 |
| 100 MiB | 44.73 | 544.97 | 500.19 / 500.30 | 544.97 / 545.02 | 266.67 |

The current implementation scaled at roughly five additional MiB of RSS per MiB of source PDF during full request preparation. This is an observed relationship for this Node/V8 version and payload shape, not a guaranteed formula.

### Resource-limited case

The exact 150 MiB fixture was generated safely by streaming its synthetic attachment to disk, but it was not prepared three times. Linear extrapolation from the observed results predicts roughly 795 MiB total process RSS, while the machine had less than 1 GiB free at the start and other processes were active. Running it would have left an inadequate safety margin and could have forced heavy paging or destabilized the development session. The runner's safety check now prevents such a run when that margin is unavailable.

This is a resource-safety stop, not evidence that Node.js cannot encode a 150 MiB file. The benchmark supports `--max-mb` so a better-provisioned machine can run it explicitly.

## Provider feasibility findings

### Confirmed by current official OpenRouter documentation

- PDF input is supported by both `/api/v1/responses` and `/api/v1/chat/completions`. PDFs may be supplied as public URLs or Base64 data URLs. Chat Completions uses a `file` content part. [PDF Inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)
- When a model supports files natively, OpenRouter passes the PDF to that model. Otherwise, OpenRouter parses the file and passes parsed results to the model. [PDF Inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)
- `file-parser` supports `cloudflare-ai`, `mistral-ocr`, and `native`. `cloudflare-ai` converts a PDF to Markdown and is documented as free; `native` is limited to models with native file support. If no engine is specified, OpenRouter prefers native support and otherwise defaults to `mistral-ocr`. [PDF Inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)
- PDF URLs work with all documented processing engines. For Mistral OCR, the URL is passed directly to that service; for other engines OpenRouter fetches and processes the PDF internally. [PDF Inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)
- The Files API upload endpoint stores a file in the authenticating key’s workspace and documents a maximum file size of **100 MB**, with HTTP 413 as a possible response. [Upload a file](https://openrouter.ai/docs/api/api-reference/files/upload-file)
- Free-model requests are subject to account-dependent per-minute and daily limits, and upstream providers may also return rate-limit/capacity failures. [API limits](https://openrouter.ai/docs/api_reference/limits)

### Not documented or not established

The reviewed official documentation does **not** state:

- a maximum inline Base64 PDF size for Chat Completions;
- a maximum JSON request-body size for Chat Completions;
- a universal PDF byte or page limit shared by every parser and model;
- a universal inference timeout for large PDF requests;
- that the Files API’s 100 MB upload limit also applies to inline `file_data`;
- that a particular free model will accept an 80–100 MB PDF;
- that a large URL-referenced PDF will be accepted merely because the JSON body is small.

The Files API limit applies to `POST /api/v1/files` as documented. Applying it to inline Chat Completions would be an unsupported assumption.

Model context windows and provider-specific file rules still matter after a PDF is fetched or parsed. A byte-size limit and a context-token limit are different constraints: a small PDF can contain too much extracted text, while a large image-heavy PDF may contain relatively little text but require expensive parsing or OCR.

### URL implications

A URL reference avoids Base64’s approximately 33% request expansion and avoids holding the complete Base64 and serialized copies in the NestJS process. It does not remove the need to transfer, validate, parse, and fit the PDF content into provider/model constraints. For non-Mistral engines, the official documentation states that OpenRouter fetches the URL itself.

Using a short-lived signed URL is an engineering option rather than a provider acceptance guarantee. It must remain reachable for the complete fetch window, allow OpenRouter’s fetch behavior, avoid authentication headers unavailable to the fetcher, and account for expiry, redirects, logging, tenant isolation, and URL leakage. The documentation does not publish a signed-URL-specific maximum file size.

## Recommendation

Inline Base64 is acceptable for the existing small synthetic PoC and perhaps tightly bounded small documents. It should not be the provisional production transport for average 80–100 MB customer PDFs.

For 80–100 MB files, the local CPU time is manageable, but the important costs are:

- 106.67–133.33 MiB JSON request bodies;
- approximately 436–545 MiB sampled Node process RSS per in-flight preparation on this machine;
- event-loop-blocking synchronous work inside `JSON.stringify` and Base64 conversion;
- multiplied memory pressure if requests run concurrently;
- unknown OpenRouter edge, parser, provider, and model acceptance limits;
- transfer and parsing latency that were not measured locally.

The next production-oriented investigation should compare private object storage plus short-lived signed URLs with controlled server-side text extraction/chunking. That is a recommendation for further investigation, not an implementation change to this PoC.

## Is a separate live provider test justified?

Yes, but only as a deliberately approved, bounded experiment after OpenRouter support or current documentation clarifies inline body limits and after selecting a specific model/parser route. A sensible progression would test synthetic, non-sensitive documents at increasing sizes and stop at the first rejection, recording HTTP status, sanitized error category, actual routed model/provider, parser request, elapsed time, and token usage.

An initial live test should not start at 100 MB, should not use client data, and should not assume `openrouter/free` will route consistently. Account limits, parser costs, timeouts, and the PoC’s existing 30-second client timeout must be considered beforehand. No live request was performed for this investigation.

## Reproduction

Generate one exact-size fixture:

```powershell
npm run benchmark:pdf:generate -- --size-mb 80
```

Run the default three iterations for all sizes through 150 MiB, only on a machine with sufficient free memory:

```powershell
npm run benchmark:pdf -- --max-mb 150
```

Reproduce the safe range used for this report:

```powershell
npm run benchmark:pdf -- --sizes 10,50,80,100 --runs 3 --max-mb 100
```

Benchmark existing fixtures without regenerating them:

```powershell
npm run benchmark:pdf -- --sizes 80,100 --runs 3 --max-mb 100 --no-generate
```

Raw numeric results are written to `benchmark-assets/large-pdf-base64-results.json`. The entire directory is ignored and must not be committed.

## Remaining unknowns

- Actual inline Chat Completions request-body ceiling.
- Acceptance and parsing latency for 80–100 MB PDFs.
- Provider/model-specific PDF byte, page, image, and context constraints.
- Whether the existing 30-second PoC timeout is sufficient for a large remote fetch and parse.
- Cloudflare parser behavior for large real-world text, image-heavy, malformed, encrypted, or scanned PDFs.
- Network upload duration and memory behavior inside Node’s native `fetch` after serialization.
- Behavior under concurrent requests and NestJS process memory limits.
- Signed-URL fetch requirements, maximum duration, redirect behavior, and retry behavior.
- Whether Files API IDs can be used with the same inference path desired by this PoC and how its persistent storage model fits client privacy requirements.

## Official sources

- [OpenRouter PDF Inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)
- [OpenRouter file upload API](https://openrouter.ai/docs/api/api-reference/files/upload-file)
- [OpenRouter API limits](https://openrouter.ai/docs/api_reference/limits)
- [OpenRouter plugin overview](https://openrouter.ai/docs/guides/features/plugins/overview)
- [OpenRouter pricing](https://openrouter.ai/pricing)
- [OpenRouter privacy policy](https://openrouter.ai/privacy)
