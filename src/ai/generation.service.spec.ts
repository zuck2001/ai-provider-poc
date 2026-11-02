import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DataSource, type Repository } from 'typeorm';
import { AiService } from './ai.service.js';
import { AiGeneration } from './entities/ai-generation.entity.js';
import { PromptTemplate } from './entities/prompt-template.entity.js';
import { GenerationService } from './generation.service.js';
import { PromptTemplateService } from './prompt-template.service.js';

describe('Generation persistence workflow', () => {
  let dataSource: DataSource;
  let generations: Repository<AiGeneration>;
  let templates: Repository<PromptTemplate>;
  let provider: {
    generate: ReturnType<typeof vi.fn>;
    generateWithPdf: ReturnType<typeof vi.fn>;
  };
  let templateService: PromptTemplateService;
  let service: GenerationService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      dropSchema: true,
      entities: [PromptTemplate, AiGeneration],
      synchronize: true,
    });
    await dataSource.initialize();
    generations = dataSource.getRepository(AiGeneration);
    templates = dataSource.getRepository(PromptTemplate);
    templateService = new PromptTemplateService(templates);
    await templateService.onModuleInit();
    provider = { generate: vi.fn(), generateWithPdf: vi.fn() };
    service = new GenerationService(
      provider as unknown as AiService,
      templateService,
      generations,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const providerResponse = {
    id: 'provider-1',
    model: 'actual/model',
    content: 'Generated answer',
    usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
  };

  async function withTempFile(
    content: string | Buffer,
    test: (path: string) => Promise<void>,
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'ai-pdf-poc-'));
    const path = join(directory, 'fixture.pdf');
    try {
      await writeFile(path, content);
      await test(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('seeds the example prompt template idempotently', async () => {
    await templateService.onModuleInit();
    await expect(templates.count()).resolves.toBe(1);
    await expect(
      templates.findOneByOrFail({ key: 'rd-project-summary', version: 1 }),
    ).resolves.toMatchObject({
      template:
        'Summarize the following R&D project in two sentences: {{description}}',
    });
  });

  it('persists a successful direct prompt generation', async () => {
    provider.generate.mockResolvedValue(providerResponse);
    const result = await service.generateDirect('Direct prompt');
    const stored = await generations.findOneByOrFail({
      id: result.generationId,
    });

    expect(result).toEqual({
      generationId: expect.any(String),
      ...providerResponse,
    });
    expect(stored).toMatchObject({
      providerRequestId: 'provider-1',
      promptTemplateId: null,
      model: 'actual/model',
      promptText: 'Direct prompt',
      responseText: 'Generated answer',
      usage: providerResponse.usage,
      status: 'completed',
    });
  });

  it('reads the valid synthetic PDF and persists its generation metadata', async () => {
    provider.generateWithPdf.mockResolvedValue({
      ...providerResponse,
      content: 'HELIOS-47, 18 percent.',
    });

    const result = await service.analyzeSyntheticPdf(
      resolve('test-assets/synthetic-rd-project.pdf'),
    );
    expect(provider.generateWithPdf).toHaveBeenCalledWith(
      expect.stringContaining('What is the project codename'),
      'synthetic-rd-project.pdf',
      expect.stringMatching(/^data:application\/pdf;base64,JVBERi0/),
    );
    await expect(
      generations.findOneByOrFail({ id: result.generationId }),
    ).resolves.toMatchObject({
      providerRequestId: 'provider-1',
      responseText: 'HELIOS-47, 18 percent.',
      status: 'completed',
      inputMode: 'base64',
      parserRequested: 'cloudflare-ai',
    });
  });

  it('rejects a missing synthetic PDF', async () => {
    await expect(
      service.analyzeSyntheticPdf(join(tmpdir(), 'missing-synthetic.pdf')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.generateWithPdf).not.toHaveBeenCalled();
  });

  it('rejects an invalid PDF signature', async () => {
    await withTempFile('not a PDF', async (path) => {
      await expect(service.analyzeSyntheticPdf(path)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
    expect(provider.generateWithPdf).not.toHaveBeenCalled();
  });

  it('rejects an oversized PDF', async () => {
    await withTempFile(Buffer.alloc(1024 * 1024 + 1), async (path) => {
      await expect(service.analyzeSyntheticPdf(path)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
    expect(provider.generateWithPdf).not.toHaveBeenCalled();
  });

  it('persists a sanitized failed PDF provider request', async () => {
    provider.generateWithPdf.mockRejectedValue(
      new BadGatewayException('AI provider request failed'),
    );
    await expect(
      service.analyzeSyntheticPdf(
        resolve('test-assets/synthetic-rd-project.pdf'),
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    await expect(
      generations.findOneByOrFail({ status: 'failed' }),
    ).resolves.toMatchObject({
      providerRequestId: null,
      model: null,
      responseText: null,
      usage: null,
      inputMode: 'base64',
      parserRequested: 'cloudflare-ai',
    });
  });

  it('selects the latest template version and safely interpolates variables', async () => {
    const latest = await templates.save(
      templates.create({
        key: 'rd-project-summary',
        version: 2,
        template: 'Project description: {{description}}',
      }),
    );
    provider.generate.mockResolvedValue(providerResponse);

    const result = await service.generateFromTemplate('rd-project-summary', {
      description: '${notExecutable}',
    });
    expect(provider.generate).toHaveBeenCalledWith(
      'Project description: ${notExecutable}',
    );
    await expect(
      generations.findOneByOrFail({ id: result.generationId }),
    ).resolves.toMatchObject({
      promptTemplateId: latest.id,
      promptText: 'Project description: ${notExecutable}',
    });
  });

  it('rejects a missing template', async () => {
    await expect(
      service.generateFromTemplate('missing', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('rejects missing template variables', async () => {
    await expect(
      service.generateFromTemplate('rd-project-summary', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('persists a sanitized failed provider request', async () => {
    provider.generate.mockRejectedValue(
      new BadGatewayException('AI provider request failed'),
    );
    await expect(
      service.generateDirect('Failed prompt'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    await expect(
      generations.findOneByOrFail({ status: 'failed' }),
    ).resolves.toMatchObject({
      providerRequestId: null,
      model: null,
      promptText: 'Failed prompt',
      responseText: null,
      usage: null,
    });
  });

  it('retrieves a stored generation by internal ID', async () => {
    provider.generate.mockResolvedValue(providerResponse);
    const created = await service.generateDirect('Stored prompt');
    await expect(service.findById(created.generationId)).resolves.toMatchObject(
      {
        id: created.generationId,
        status: 'completed',
        providerRequestId: 'provider-1',
        model: 'actual/model',
        responseText: 'Generated answer',
        usage: providerResponse.usage,
        createdAt: expect.any(Date),
      },
    );
  });

  it('rejects an unknown generation ID', async () => {
    await expect(
      service.findById('00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
