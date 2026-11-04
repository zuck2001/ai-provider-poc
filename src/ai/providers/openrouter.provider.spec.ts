import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterAiProvider } from './openrouter.provider.js';

describe('OpenRouterAiProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createService(config: Record<string, string | undefined>) {
    const configService = {
      get: vi.fn((key: string) => config[key]),
    } as unknown as ConfigService;
    return new OpenRouterAiProvider(configService);
  }

  it('normalizes a successful OpenRouter response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'generation-1',
          model: 'provider/model',
          choices: [{ message: { content: 'A concise answer.' } }],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createService({ OPENROUTER_API_KEY: 'test-key' }).generate('Hello'),
    ).resolves.toEqual({
      id: 'generation-1',
      model: 'provider/model',
      content: 'A concise answer.',
      usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'openrouter/free',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('sends and normalizes the documented PDF request shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'pdf-generation-1',
          model: 'free/pdf-model',
          choices: [{ message: { content: 'HELIOS-47, 18 percent.' } }],
          usage: { prompt_tokens: 25, completion_tokens: 6, total_tokens: 31 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createService({ OPENROUTER_API_KEY: 'test-key' }).generateWithPdf(
        'Question',
        {
          filename: 'synthetic.pdf',
          mimeType: 'application/pdf',
          base64: 'JVBERi0=',
        },
        { maxTokens: 100 },
      ),
    ).resolves.toEqual({
      id: 'pdf-generation-1',
      model: 'free/pdf-model',
      content: 'HELIOS-47, 18 percent.',
      usage: { promptTokens: 25, completionTokens: 6, totalTokens: 31 },
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      model: 'openrouter/free',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Question' },
            {
              type: 'file',
              file: {
                filename: 'synthetic.pdf',
                file_data: 'data:application/pdf;base64,JVBERi0=',
              },
            },
          ],
        },
      ],
      plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],
      max_tokens: 100,
    });
  });

  it('rejects a missing API key without calling the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createService({}).generate('Hello')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes its provider name and PDF parser', () => {
    const provider = createService({});
    expect(provider.name).toBe('openrouter');
    expect(provider.pdfParser).toBe('cloudflare-ai');
  });

  it('honours a configured model and an explicit token limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'generation-2',
          model: 'custom/model',
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createService({
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL: 'custom/model',
    }).generate('Hello', { maxTokens: 50 });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      model: 'custom/model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 50,
    });
  });
});
