import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  GenerationService,
  type PersistedAiResponse,
  type StoredGenerationResponse,
} from './generation.service.js';

@Controller('ai')
export class AiController {
  constructor(private readonly generations: GenerationService) {}

  @Post('generate')
  generate(@Body() body: unknown): Promise<PersistedAiResponse> {
    const prompt =
      typeof body === 'object' && body !== null && 'prompt' in body
        ? (body as { prompt?: unknown }).prompt
        : undefined;

    if (prompt !== undefined) {
      if (
        typeof prompt !== 'string' ||
        prompt.trim().length === 0 ||
        prompt.length > 10_000
      ) {
        throw new BadRequestException(
          'prompt must be a non-empty string of at most 10,000 characters',
        );
      }
      return this.generations.generateDirect(prompt);
    }

    const templateKey =
      typeof body === 'object' && body !== null && 'templateKey' in body
        ? (body as { templateKey?: unknown }).templateKey
        : undefined;
    const variables =
      typeof body === 'object' && body !== null && 'variables' in body
        ? (body as { variables?: unknown }).variables
        : undefined;

    if (
      typeof templateKey !== 'string' ||
      templateKey.trim().length === 0 ||
      typeof variables !== 'object' ||
      variables === null ||
      Array.isArray(variables) ||
      Object.values(variables).some((value) => typeof value !== 'string')
    ) {
      throw new BadRequestException(
        'provide either a valid prompt or templateKey with string variables',
      );
    }

    return this.generations.generateFromTemplate(
      templateKey,
      variables as Record<string, string>,
    );
  }

  @Post('analyze-pdf')
  analyzePdf(): Promise<PersistedAiResponse> {
    return this.generations.analyzeSyntheticPdf();
  }

  @Get('generations/:id')
  findGeneration(@Param('id') id: string): Promise<StoredGenerationResponse> {
    return this.generations.findById(id);
  }
}
