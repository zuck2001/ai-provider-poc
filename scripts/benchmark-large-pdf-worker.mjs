import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const filePath = process.argv[2];
if (!filePath) throw new Error('A PDF path is required');

const snapshots = [];
const snapshot = (stage) => {
  const usage = process.memoryUsage();
  snapshots.push({ stage, ...usage });
};
const elapsed = (start) => performance.now() - start;

if (global.gc) global.gc();
snapshot('before');

let start = performance.now();
let pdf = readFileSync(filePath);
const readMs = elapsed(start);
snapshot('afterRead');

if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
  throw new Error('Fixture does not have a valid PDF signature');
}

start = performance.now();
let encoded = pdf.toString('base64');
const encodeMs = elapsed(start);
snapshot('afterBase64');

start = performance.now();
let dataUrl = `data:application/pdf;base64,${encoded}`;
let payload = {
  model: 'openrouter/free',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read the known synthetic fact from the attached PDF.' },
        { type: 'file', file: { filename: basename(filePath), file_data: dataUrl } },
      ],
    },
  ],
  plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],
  max_tokens: 100,
};
let serialized = JSON.stringify(payload);
const serializeMs = elapsed(start);
snapshot('afterSerialize');

const originalBytes = statSync(filePath).size;
const encodedBytes = Buffer.byteLength(encoded);
const serializedBytes = Buffer.byteLength(serialized);
const peakRssBytes = Math.max(...snapshots.map(({ rss }) => rss));
const before = snapshots[0];
const after = snapshots.at(-1);

const result = {
  filePath: resolve(filePath),
  originalBytes,
  encodedBytes,
  serializedBytes,
  timingsMs: {
    read: readMs,
    base64Encode: encodeMs,
    jsonSerialize: serializeMs,
    totalPreparation: readMs + encodeMs + serializeMs,
  },
  memoryBytes: {
    rssBefore: before.rss,
    rssAfter: after.rss,
    rssDelta: after.rss - before.rss,
    peakRssSampled: peakRssBytes,
    heapUsedBefore: before.heapUsed,
    heapUsedAfter: after.heapUsed,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    externalBefore: before.external,
    externalAfter: after.external,
  },
  snapshots,
};

console.log(JSON.stringify(result));

pdf = null;
encoded = null;
dataUrl = null;
payload = null;
serialized = null;
if (global.gc) global.gc();
