import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { generateSyntheticPdf } from './generate-large-pdf.mjs';

const DEFAULT_SIZES = [10, 50, 80, 100, 150];

function parseArguments(argv) {
  const options = { sizes: DEFAULT_SIZES, runs: 3, maxMiB: 150, generate: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--sizes') options.sizes = argv[++index].split(',').map(Number);
    else if (argument === '--runs') options.runs = Number(argv[++index]);
    else if (argument === '--max-mb') options.maxMiB = Number(argv[++index]);
    else if (argument === '--no-generate') options.generate = false;
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error('--runs must be an integer from 1 to 10');
  }
  if (!Number.isFinite(options.maxMiB) || options.maxMiB < 1 || options.maxMiB > 500) {
    throw new Error('--max-mb must be between 1 and 500');
  }
  if (options.sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 500)) {
    throw new Error('--sizes must contain integers from 1 to 500');
  }
  return options;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregate(runs, path) {
  const values = runs.map((run) => path(run));
  return { median: median(values), max: Math.max(...values) };
}

function runWorker(filePath) {
  const worker = resolve('scripts/benchmark-large-pdf-worker.mjs');
  const child = spawnSync(
    process.execPath,
    ['--expose-gc', '--max-old-space-size=1024', worker, filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5 * 60 * 1000 },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Benchmark worker failed: ${child.stderr.trim() || `exit ${child.status}`}`);
  }
  return JSON.parse(child.stdout.trim());
}

function assertMemoryHeadroom(sizeMiB) {
  // Empirical guard for this whole-buffer benchmark: observed peak RSS is about
  // 5x the source size plus the child baseline. Keep a 25% margin as well.
  const projectedMiB = sizeMiB * 5 + 50;
  const requiredFreeMiB = projectedMiB * 1.25;
  const freeMiB = freemem() / (1024 * 1024);
  if (freeMiB < requiredFreeMiB) {
    throw new Error(
      `Insufficient memory headroom for ${sizeMiB} MiB: ${freeMiB.toFixed(0)} MiB free, ` +
        `${requiredFreeMiB.toFixed(0)} MiB required by the conservative safety check. ` +
        'Lower --max-mb or run on a better-provisioned machine.',
    );
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node scripts/benchmark-large-pdf.mjs [--sizes 10,50,80,100,150] [--runs 3] [--max-mb 150] [--no-generate]');
  process.exit(0);
}

const sizes = [...new Set(options.sizes)].filter((size) => size <= options.maxMiB);
if (sizes.length === 0) throw new Error('No requested sizes are within --max-mb');

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: platform(),
    osRelease: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
  },
  methodology: {
    runsPerSize: options.runs,
    childProcessPerRun: true,
    maxOldSpaceMiB: 1024,
    peakRssIsSampledProcessWide: true,
    memorySafetyCheck: 'free memory >= 1.25 * (5 * source MiB + 50 MiB)',
    fixtureSizeDriver: 'one uncompressed repetitive embedded-file attachment',
  },
  results: [],
};

for (const sizeMiB of sizes) {
  const filePath = resolve(`benchmark-assets/synthetic-${sizeMiB}mb.pdf`);
  if (options.generate) {
    console.error(`Generating ${sizeMiB} MiB fixture...`);
    await generateSyntheticPdf(sizeMiB, filePath);
  }
  const runs = [];
  for (let run = 1; run <= options.runs; run += 1) {
    assertMemoryHeadroom(sizeMiB);
    console.error(`Benchmarking ${sizeMiB} MiB, run ${run}/${options.runs}...`);
    runs.push(runWorker(filePath));
  }
  report.results.push({
    sizeMiB,
    originalBytes: runs[0].originalBytes,
    encodedBytes: runs[0].encodedBytes,
    serializedBytes: runs[0].serializedBytes,
    expansionRatio: runs[0].encodedBytes / runs[0].originalBytes,
    timingsMs: {
      read: aggregate(runs, (run) => run.timingsMs.read),
      base64Encode: aggregate(runs, (run) => run.timingsMs.base64Encode),
      jsonSerialize: aggregate(runs, (run) => run.timingsMs.jsonSerialize),
      totalPreparation: aggregate(runs, (run) => run.timingsMs.totalPreparation),
    },
    memoryBytes: {
      rssBefore: aggregate(runs, (run) => run.memoryBytes.rssBefore),
      rssAfter: aggregate(runs, (run) => run.memoryBytes.rssAfter),
      rssDelta: aggregate(runs, (run) => run.memoryBytes.rssDelta),
      peakRssSampled: aggregate(runs, (run) => run.memoryBytes.peakRssSampled),
      heapUsedDelta: aggregate(runs, (run) => run.memoryBytes.heapUsedDelta),
    },
    runs,
  });
}

await writeFile(
  resolve('benchmark-assets/large-pdf-base64-results.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(report, null, 2));
