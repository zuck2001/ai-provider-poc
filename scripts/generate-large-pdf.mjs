import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MIB = 1024 * 1024;
const WRITE_CHUNK_BYTES = MIB;
const KNOWN_FACT =
  'Synthetic benchmark fact: Project codename ATLAS-100; target efficiency gain 23 percent. No real company or employee data.';

function parseArguments(argv) {
  const options = { sizeMiB: undefined, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--size-mb') options.sizeMiB = Number(argv[++index]);
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function pdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

async function writeSyntheticPdf(outputPath, attachmentBytes) {
  const handle = await open(outputPath, 'w');
  let position = 0;
  const offsets = [0];
  const write = async (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii');
    await handle.write(buffer, 0, buffer.length, position);
    position += buffer.length;
  };
  const object = async (number, body) => {
    offsets[number] = position;
    await write(`${number} 0 obj\n${body}\nendobj\n`);
  };

  try {
    await write('%PDF-1.7\n% Synthetic large-file benchmark fixture\n');
    await object(
      1,
      '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(synthetic-padding.bin) 7 0 R] >> >> >>',
    );
    await object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    await object(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    );
    const content = `BT /F1 12 Tf 72 720 Td (${pdfText(KNOWN_FACT)}) Tj ET\n`;
    await object(4, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    await object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

    offsets[6] = position;
    await write(
      `6 0 obj\n<< /Type /EmbeddedFile /Subtype /application#2Foctet-stream /Length ${attachmentBytes} >>\nstream\n`,
    );
    const chunk = Buffer.alloc(WRITE_CHUNK_BYTES, 0x41);
    let remaining = attachmentBytes;
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      await write(chunk.subarray(0, length));
      remaining -= length;
    }
    await write('\nendstream\nendobj\n');
    await object(
      7,
      '<< /Type /Filespec /F (synthetic-padding.bin) /UF (synthetic-padding.bin) /Desc (Synthetic repetitive attachment used only to control benchmark size) /EF << /F 6 0 R >> >>',
    );

    const xrefOffset = position;
    await write('xref\n0 8\n0000000000 65535 f \n');
    for (let number = 1; number <= 7; number += 1) {
      await write(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
    }
    await write(
      `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    );
  } finally {
    await handle.close();
  }
  return position;
}

export async function generateSyntheticPdf(sizeMiB, outputPath) {
  if (!Number.isInteger(sizeMiB) || sizeMiB <= 0 || sizeMiB > 500) {
    throw new Error('--size-mb must be an integer between 1 and 500');
  }
  const targetBytes = sizeMiB * MIB;
  const resolvedOutput = resolve(outputPath);
  await mkdir(dirname(resolvedOutput), { recursive: true });

  let attachmentBytes = Math.max(0, targetBytes - 2048);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actualBytes = await writeSyntheticPdf(resolvedOutput, attachmentBytes);
    const difference = targetBytes - actualBytes;
    if (difference === 0) break;
    attachmentBytes += difference;
    if (attachmentBytes < 0) throw new Error('Requested fixture is too small');
  }

  const result = await stat(resolvedOutput);
  if (result.size !== targetBytes) {
    await rm(resolvedOutput, { force: true });
    throw new Error(`Could not generate the exact target size: ${result.size} bytes`);
  }
  return { outputPath: resolvedOutput, sizeMiB, sizeBytes: result.size, attachmentBytes };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help || options.sizeMiB === undefined) {
      console.log('Usage: node scripts/generate-large-pdf.mjs --size-mb 80 [--output benchmark-assets/synthetic-80mb.pdf]');
      process.exit(options.help ? 0 : 1);
    }
    const output = options.output ?? `benchmark-assets/synthetic-${options.sizeMiB}mb.pdf`;
    const result = await generateSyntheticPdf(options.sizeMiB, output);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
