import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Repository } from 'typeorm';
import { AiService, type AiResponse } from './ai.service.js';
import { AiGeneration } from './entities/ai-generation.entity.js';
import type { PromptTemplate } from './entities/prompt-template.entity.js';
import { PromptTemplateService } from './prompt-template.service.js';

export interface PersistedAiResponse extends AiResponse {
  generationId: string;
}

export interface StoredGenerationResponse {
  id: string;
  status: 'completed' | 'failed';
  providerRequestId: string | null;
  model: string | null;
  responseText: string | null;
  usage: AiGeneration['usage'];
  inputMode: string | null;
  parserRequested: string | null;
  createdAt: Date;
}

export const PDF_ANALYSIS_PROMPT =
  'What is the project codename, and by what percentage was battery cooling energy consumption reduced? Answer briefly using only the attached document.';
const SYNTHETIC_PDF_PATH = resolve(
  process.cwd(),
  'test-assets',
  'synthetic-rd-project.pdf',
);
const MAX_PDF_SIZE_BYTES = 1024 * 1024;

@Injectable()
export class GenerationService {
  constructor(
    private readonly provider: AiService,
    private readonly templates: PromptTemplateService,
    @InjectRepository(AiGeneration)
    private readonly repository: Repository<AiGeneration>,
  ) {}

  generateDirect(prompt: string): Promise<PersistedAiResponse> {
    return this.generateAndPersist(prompt, null);
  }

  async analyzeSyntheticPdf(
    pdfPath = SYNTHETIC_PDF_PATH,
  ): Promise<PersistedAiResponse> {
    let size: number;
    try {
      size = (await stat(pdfPath)).size;
    } catch {
      throw new NotFoundException('Synthetic PDF fixture not found');
    }
    if (size > MAX_PDF_SIZE_BYTES) {
      throw new BadRequestException('Synthetic PDF exceeds the 1 MB limit');
    }

    const pdf = await readFile(pdfPath);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new BadRequestException('Synthetic PDF has an invalid signature');
    }

    const dataUrl = `data:application/pdf;base64,${pdf.toString('base64')}`;
    return this.generateAndPersist(
      PDF_ANALYSIS_PROMPT,
      null,
      () =>
        this.provider.generateWithPdf(
          PDF_ANALYSIS_PROMPT,
          basename(pdfPath),
          dataUrl,
        ),
      { inputMode: 'base64', parserRequested: 'cloudflare-ai' },
    );
  }

  async generateFromTemplate(
    templateKey: string,
    variables: Record<string, string>,
  ): Promise<PersistedAiResponse> {
    const rendered = await this.templates.renderLatest(templateKey, variables);
    return this.generateAndPersist(rendered.prompt, rendered.template);
  }

  async findById(id: string): Promise<StoredGenerationResponse> {
    const generation = await this.repository.findOneBy({ id });
    if (!generation) {
      throw new NotFoundException('Generation not found');
    }
    return {
      id: generation.id,
      status: generation.status,
      providerRequestId: generation.providerRequestId,
      model: generation.model,
      responseText: generation.responseText,
      usage: generation.usage,
      inputMode: generation.inputMode,
      parserRequested: generation.parserRequested,
      createdAt: generation.createdAt,
    };
  }

  private async generateAndPersist(
    prompt: string,
    template: PromptTemplate | null,
    generate: () => Promise<AiResponse> = () => this.provider.generate(prompt),
    metadata: {
      inputMode?: string;
      parserRequested?: string;
    } = {},
  ): Promise<PersistedAiResponse> {
    try {
      const result = await generate();
      const generation = await this.repository.save(
        this.repository.create({
          providerRequestId: result.id,
          promptTemplateId: template?.id ?? null,
          model: result.model,
          promptText: prompt,
          responseText: result.content,
          usage: result.usage,
          inputMode: metadata.inputMode ?? null,
          parserRequested: metadata.parserRequested ?? null,
          status: 'completed',
        }),
      );
      return { generationId: generation.id, ...result };
    } catch (error) {
      await this.repository.save(
        this.repository.create({
          providerRequestId: null,
          promptTemplateId: template?.id ?? null,
          model: null,
          promptText: prompt,
          responseText: null,
          usage: null,
          inputMode: metadata.inputMode ?? null,
          parserRequested: metadata.parserRequested ?? null,
          status: 'failed',
        }),
      );
      throw error;
    }
  }
}
