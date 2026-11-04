import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { AiProvider } from './ai-provider.js';
import { aiProviderFactory, selectAiProvider } from './ai-provider.factory.js';
import { OpenRouterAiProvider } from './openrouter.provider.js';

describe('AI provider selection', () => {
  const config = (values: Record<string, string | undefined>) =>
    ({ get: vi.fn((key: string) => values[key]) }) as unknown as ConfigService;
  const openRouter = new OpenRouterAiProvider(config({}));

  it('defaults to OpenRouter when AI_PROVIDER is unset or blank', () => {
    expect(selectAiProvider(undefined, [openRouter])).toBe(openRouter);
    expect(selectAiProvider('  ', [openRouter])).toBe(openRouter);
  });

  it('selects the provider whose name matches AI_PROVIDER', () => {
    expect(selectAiProvider('openrouter', [openRouter])).toBe(openRouter);
  });

  it('matches AI_PROVIDER case-insensitively', () => {
    expect(selectAiProvider('OpenRouter', [openRouter])).toBe(openRouter);
    expect(selectAiProvider(' OPENROUTER ', [openRouter])).toBe(openRouter);
  });

  it('rejects two providers that share a name', () => {
    const copy = new OpenRouterAiProvider(config({}));
    expect(() => selectAiProvider('openrouter', [openRouter, copy])).toThrow(
      'Duplicate AI provider name "openrouter"',
    );
  });

  it('fails fast on an unknown AI_PROVIDER', () => {
    expect(() => selectAiProvider('nope', [openRouter])).toThrow(
      'Unknown AI_PROVIDER "nope". Expected one of: openrouter',
    );
  });

  it('binds the AiProvider token through ConfigService', () => {
    expect(aiProviderFactory.provide).toBe(AiProvider);
    expect(
      aiProviderFactory.useFactory(
        config({ AI_PROVIDER: 'openrouter' }),
        openRouter,
      ),
    ).toBe(openRouter);
  });
});
