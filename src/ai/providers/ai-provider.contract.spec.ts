import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from './ai-provider.js';
import { AI_PROVIDER_CLASSES } from './ai-provider.factory.js';

/**
 * Shared error contract every provider must honour. Each class registered in
 * AI_PROVIDER_CLASSES is checked automatically; add its valid config here.
 */
const VALID_CONFIG: Record<string, Record<string, string>> = {
  openrouter: { OPENROUTER_API_KEY: 'test-key' },
  openai: { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-test' },
};

function configFor(values: Record<string, string>): ConfigService {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function createProvider(
  ProviderClass: (typeof AI_PROVIDER_CLASSES)[number],
): AiProvider {
  const name = new ProviderClass(configFor({})).name;
  const values = VALID_CONFIG[name];
  if (!values) {
    throw new Error(`Add a valid test config for provider "${name}"`);
  }
  return new ProviderClass(configFor(values));
}

describe.each(AI_PROVIDER_CLASSES.map((cls) => [cls.name, cls] as const))(
  '%s error contract',
  (_label, ProviderClass) => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sanitizes non-successful provider responses', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response('sensitive details', { status: 402 }),
          ),
      );
      const error = await createProvider(ProviderClass)
        .generate('Hello')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as BadGatewayException).getResponse()).toEqual({
        message: 'AI provider request failed',
        providerStatus: 402,
      });
    });

    it('handles network failures', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new TypeError('network')),
      );
      await expect(
        createProvider(ProviderClass).generate('Hello'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('handles request timeouts', async () => {
      const timeout = new Error('timed out');
      timeout.name = 'TimeoutError';
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
      await expect(
        createProvider(ProviderClass).generate('Hello'),
      ).rejects.toBeInstanceOf(GatewayTimeoutException);
    });

    it.each([
      () => new Response('not JSON', { status: 200 }),
      () =>
        new Response(JSON.stringify({ id: 'generation-1', choices: [] }), {
          status: 200,
        }),
    ])('rejects malformed provider responses', async (makeResponse) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse()));
      await expect(
        createProvider(ProviderClass).generate('Hello'),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  },
);
