import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AiController } from './ai.controller.js';
import { GenerationService } from './generation.service.js';

describe('AiController', () => {
  const response = {
    generationId: 'internal-1',
    id: 'generation-1',
    model: 'provider/model',
    content: 'Answer',
    usage: null,
  };
  function createController() {
    const service = {
      generateDirect: vi.fn().mockResolvedValue(response),
      generateFromTemplate: vi.fn().mockResolvedValue(response),
      analyzeSyntheticPdf: vi.fn().mockResolvedValue(response),
      findById: vi.fn().mockResolvedValue({ id: 'internal-1' }),
    } as unknown as GenerationService;
    return { controller: new AiController(service), service };
  }

  it('returns the normalized service response', async () => {
    const { controller, service } = createController();
    await expect(controller.generate({ prompt: 'Hello' })).resolves.toEqual(
      response,
    );
    expect(service.generateDirect).toHaveBeenCalledWith('Hello');
  });

  it('accepts a template generation request', async () => {
    const { controller, service } = createController();
    await controller.generate({
      templateKey: 'rd-project-summary',
      variables: { description: 'Battery research' },
    });
    expect(service.generateFromTemplate).toHaveBeenCalledWith(
      'rd-project-summary',
      { description: 'Battery research' },
    );
  });

  it('retrieves a generation by ID', async () => {
    const { controller, service } = createController();
    await controller.findGeneration('internal-1');
    expect(service.findById).toHaveBeenCalledWith('internal-1');
  });

  it('runs the fixed synthetic PDF experiment', async () => {
    const { controller, service } = createController();
    await expect(controller.analyzePdf()).resolves.toEqual(response);
    expect(service.analyzeSyntheticPdf).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    null,
    {},
    { prompt: '' },
    { prompt: '   ' },
    { prompt: 123 },
    { prompt: 'x'.repeat(10_001) },
  ])('rejects an invalid prompt', (body) => {
    const { controller, service } = createController();
    expect(() => controller.generate(body)).toThrow(BadRequestException);
    expect(service.generateDirect).not.toHaveBeenCalled();
    expect(service.generateFromTemplate).not.toHaveBeenCalled();
  });
});
