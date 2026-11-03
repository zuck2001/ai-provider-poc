import { readFileSync, statSync } from 'node:fs';
import { freemem } from 'node:os';
import { basename, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openrouter/free';
const PARSER = 'cloudflare-ai';
const DEFAULT_FILE = 'benchmark-assets/synthetic-80mb.pdf';
const DEFAULT_MAX_MIB = 80;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 32;
const SYNTHETIC_MARKERS = [
  'Synthetic large-file benchmark fixture',
  'Project codename ATLAS-100',
  'No real company or employee data',
];

function parseArguments(argv) {
  const options = {
    live: false,
    confirmed: false,
    file: DEFAULT_FILE,
    maxMiB: DEFAULT_MAX_MIB,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--live') options.live = true;
    else if (argument === '--confirm-large-upload') options.confirmed = true;
    else if (argument === '--file') options.file = argv[++index];
    else if (argument === '--max-mb') options.maxMiB = Number(argv[++index]);
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!Number.isFinite(options.maxMiB) || options.maxMiB < 1 || options.maxMiB > 200) {
    throw new Error('--max-mb must be between 1 and 200');
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 300_000
  ) {
    throw new Error('--timeout-ms must be an integer between 1000 and 300000');
  }
  if (options.live && !options.confirmed) {
    throw new Error('Live mode also requires --confirm-large-upload');
  }
  if (!options.live && options.confirmed) {
    throw new Error('--confirm-large-upload is only valid together with --live');
  }
  return options;
}

function readLocalEnvironment() {
  const environment = { ...process.env };
  try {
    const lines = readFileSync(resolve('.env'), 'utf8').split(/\r?\n/u);
    for (const line of lines) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
      if (!match || match[2].startsWith('#') || environment[match[1]] !== undefined) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      environment[match[1]] = value;
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  return environment;
}

function validateFixturePath(fileArgument) {
  const assetRoot = resolve('benchmark-assets');
  const filePath = resolve(fileArgument);
  const pathFromRoot = relative(assetRoot, filePath);
  if (
    pathFromRoot === '' ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    resolve(assetRoot, pathFromRoot) !== filePath
  ) {
    throw new Error('The test only accepts synthetic fixtures inside benchmark-assets');
  }
  return filePath;
}

function snapshotMemory() {
  const { rss, heapUsed, external } = process.memoryUsage();
  return { rss, heapUsed, external };
}

function validatePayload(payload) {
  const content = payload.messages?.[0]?.content;
  const filePart = Array.isArray(content) ? content.find((part) => part.type === 'file') : undefined;
  if (
    payload.model !== MODEL ||
    'models' in payload ||
    payload.provider?.allow_fallbacks !== false ||
    payload.plugins?.[0]?.id !== 'file-parser' ||
    payload.plugins?.[0]?.pdf?.engine !== PARSER ||
    payload.max_tokens !== MAX_OUTPUT_TOKENS ||
    typeof filePart?.file?.file_data !== 'string' ||
    !filePart.file.file_data.startsWith('data:application/pdf;base64,')
  ) {
    throw new Error('Internal payload validation failed');
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : null,
  };
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(
    'Usage: npm run test:large-pdf:openrouter -- [--file benchmark-assets/synthetic-80mb.pdf] [--max-mb 80] [--timeout-ms 120000] [--live --confirm-large-upload]',
  );
  process.exit(0);
}

const startedAt = performance.now();
const filePath = validateFixturePath(options.file);
const fileStats = statSync(filePath);
const maximumBytes = Math.floor(options.maxMiB * 1024 * 1024);
if (!fileStats.isFile() || fileStats.size < 1) throw new Error('Synthetic PDF fixture is empty or invalid');
if (fileStats.size > maximumBytes) {
  throw new Error(
    `Synthetic PDF is ${(fileStats.size / 1024 / 1024).toFixed(2)} MiB, exceeding the configured ${options.maxMiB} MiB maximum`,
  );
}

const projectedMiB = fileStats.size / 1024 / 1024 * 5 + 50;
const requiredFreeMiB = projectedMiB * 1.25;
const freeMiB = freemem() / 1024 / 1024;
if (freeMiB < requiredFreeMiB) {
  throw new Error(
    `Insufficient memory headroom: ${freeMiB.toFixed(0)} MiB free, ${requiredFreeMiB.toFixed(0)} MiB required`,
  );
}

const memorySnapshots = [snapshotMemory()];
let stageStartedAt = performance.now();
const pdf = readFileSync(filePath);
const readMs = performance.now() - stageStartedAt;
memorySnapshots.push(snapshotMemory());

if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
  throw new Error('Synthetic fixture has an invalid PDF signature');
}
const fixtureHeader = pdf.subarray(0, Math.min(pdf.length, 4096)).toString('latin1');
if (SYNTHETIC_MARKERS.some((marker) => !fixtureHeader.includes(marker))) {
  throw new Error('PDF is not a recognized synthetic benchmark fixture; real documents are prohibited');
}

stageStartedAt = performance.now();
const fileData = `data:application/pdf;base64,${pdf.toString('base64')}`;
const base64Ms = performance.now() - stageStartedAt;
memorySnapshots.push(snapshotMemory());

const payload = {
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is the project codename and target efficiency gain? Answer briefly using only the attached synthetic document.',
        },
        { type: 'file', file: { filename: basename(filePath), file_data: fileData } },
      ],
    },
  ],
  plugins: [{ id: 'file-parser', pdf: { engine: PARSER } }],
  provider: { allow_fallbacks: false },
  max_tokens: MAX_OUTPUT_TOKENS,
};
validatePayload(payload);

stageStartedAt = performance.now();
const serializedPayload = JSON.stringify(payload);
const serializeMs = performance.now() - stageStartedAt;
memorySnapshots.push(snapshotMemory());
const preparationMs = performance.now() - startedAt;

const baseResult = {
  mode: options.live ? 'live' : 'dry-run',
  requestSent: false,
  file: relative(resolve('.'), filePath),
  fileBytes: fileStats.size,
  base64Bytes: Buffer.byteLength(fileData) - Buffer.byteLength('data:application/pdf;base64,'),
  jsonPayloadBytes: Buffer.byteLength(serializedPayload),
  modelRequested: MODEL,
  parserRequested: PARSER,
  providerFallbacksAllowed: false,
  modelFallbacksConfigured: false,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  timeoutMs: options.timeoutMs,
  payloadStructureValid: true,
  timingsMs: { read: readMs, base64Encode: base64Ms, jsonSerialize: serializeMs, preparation: preparationMs },
};

if (!options.live) {
  const peakRssBytes = Math.max(...memorySnapshots.map(({ rss }) => rss));
  console.log(JSON.stringify({ ...baseResult, peakRssBytes }, null, 2));
  process.exit(0);
}

const environment = readLocalEnvironment();
const apiKey = environment.OPENROUTER_API_KEY;
if (typeof apiKey !== 'string' || apiKey.trim() === '') {
  throw new Error('OPENROUTER_API_KEY is not configured');
}

let sampledPeakRss = Math.max(...memorySnapshots.map(({ rss }) => rss));
const sampler = setInterval(() => {
  sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
}, 25);
sampler.unref();

const networkStartedAt = performance.now();
let response;
try {
  // Exactly one fetch call. There is intentionally no retry loop.
  response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: serializedPayload,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
} catch (error) {
  clearInterval(sampler);
  const timedOut =
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  console.log(
    JSON.stringify(
      {
        ...baseResult,
        requestSent: true,
        outcome: timedOut ? 'timeout' : 'network-error',
        networkMs: performance.now() - networkStartedAt,
        totalElapsedMs: performance.now() - startedAt,
        peakRssBytes: sampledPeakRss,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
  process.exit();
}

let responseBody;
try {
  responseBody = await response.json();
} catch {
  responseBody = null;
}
const networkMs = performance.now() - networkStartedAt;
clearInterval(sampler);
sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);

if (!response.ok) {
  const providerCode =
    responseBody && typeof responseBody === 'object' && responseBody.error && typeof responseBody.error === 'object'
      ? responseBody.error.code ?? null
      : null;
  console.log(
    JSON.stringify(
      {
        ...baseResult,
        requestSent: true,
        outcome: 'http-rejection',
        httpStatus: response.status,
        providerErrorCode:
          typeof providerCode === 'string' || typeof providerCode === 'number' ? providerCode : null,
        networkMs,
        totalElapsedMs: performance.now() - startedAt,
        peakRssBytes: sampledPeakRss,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
  process.exit();
}

const choice = responseBody?.choices?.[0];
const content = choice?.message?.content;
const actualModel = typeof responseBody?.model === 'string' ? responseBody.model : null;
const result = {
  ...baseResult,
  requestSent: true,
  outcome: 'completed',
  httpStatus: response.status,
  providerRequestId: typeof responseBody?.id === 'string' ? responseBody.id : null,
  actualModel,
  actualModelMarkedFree: actualModel?.endsWith(':free') ?? false,
  responseLengthChars: typeof content === 'string' ? content.length : null,
  expectedFactMatched:
    typeof content === 'string' && content.includes('ATLAS-100') && /23\s*(?:%|percent)/iu.test(content),
  finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  usage: normalizeUsage(responseBody?.usage),
  networkMs,
  totalElapsedMs: performance.now() - startedAt,
  peakRssBytes: sampledPeakRss,
};
console.log(JSON.stringify(result, null, 2));
