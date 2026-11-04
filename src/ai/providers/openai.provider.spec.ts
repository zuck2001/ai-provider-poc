import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiProvider } from './openai.provider.js';

const VALID_CONFIG = { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-test' };

describe('OpenAiProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createProvider(config: Record<string, string | undefined>) {
    const configService = {
      get: vi.fn((key: string) => config[key]),
    } as unknown as ConfigService;
    return new OpenAiProvider(configService);
  }

  function mockSuccess(content = 'A concise answer.') {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-test-2026-01-01',
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('exposes its provider name and no PDF parser', () => {
    const provider = createProvider({});
    expect(provider.name).toBe('openai');
    expect(provider.pdfParser).toBeNull();
  });

  it('normalizes a successful OpenAI response', async () => {
    const fetchMock = mockSuccess();

    await expect(
      createProvider(VALID_CONFIG).generate('Hello'),
    ).resolves.toEqual({
      id: 'chatcmpl-1',
      model: 'gpt-test-2026-01-01',
      content: 'A concise answer.',
      usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('sends the PDF as a file part with max_completion_tokens', async () => {
    const fetchMock = mockSuccess('HELIOS-47, 18 percent.');

    await createProvider(VALID_CONFIG).generateWithPdf(
      'Question',
      {
        filename: 'synthetic.pdf',
        mimeType: 'application/pdf',
        base64: 'JVBERi0=',
      },
      { maxTokens: 100 },
    );

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      model: 'gpt-test',
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
      max_completion_tokens: 100,
    });
  });

  it.each([
    ['API key', { OPENAI_MODEL: 'gpt-test' }],
    ['model', { OPENAI_API_KEY: 'test-key' }],
  ])(
    'rejects a missing %s without calling the provider',
    async (_missing, config) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        createProvider(config).generate('Hello'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
