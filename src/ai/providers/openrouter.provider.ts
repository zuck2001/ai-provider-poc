import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProvider,
  type AiResponse,
  type GenerateOptions,
  type PdfAttachment,
} from './ai-provider.js';

const PDF_ENGINE = 'cloudflare-ai';

interface OpenRouterResponse {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

@Injectable()
export class OpenRouterAiProvider extends AiProvider {
  readonly name = 'openrouter';
  readonly pdfParser = PDF_ENGINE;

  constructor(private readonly configService: ConfigService) {
    super();
  }

  generate(prompt: string, opts?: GenerateOptions): Promise<AiResponse> {
    return this.request(
      { messages: [{ role: 'user', content: prompt }] },
      opts,
    );
  }

  generateWithPdf(
    prompt: string,
    file: PdfAttachment,
    opts?: GenerateOptions,
  ): Promise<AiResponse> {
    return this.request(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'file',
                file: {
                  filename: file.filename,
                  file_data: `data:${file.mimeType};base64,${file.base64}`,
                },
              },
            ],
          },
        ],
        plugins: [{ id: 'file-parser', pdf: { engine: PDF_ENGINE } }],
      },
      opts,
    );
  }

  private async request(
    payload: Record<string, unknown>,
    opts?: GenerateOptions,
  ): Promise<AiResponse> {
    const apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    const model =
      this.configService.get<string>('OPENROUTER_MODEL') || 'openrouter/free';

    if (!apiKey) {
      throw new InternalServerErrorException('AI provider is not configured');
    }

    let response: Response;

    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          ...payload,
          ...(opts?.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new GatewayTimeoutException('AI provider request timed out');
      }

      throw new ServiceUnavailableException('AI provider is unavailable');
    }

    if (!response.ok) {
      throw new BadGatewayException({
        message: 'AI provider request failed',
        providerStatus: response.status,
      });
    }

    let data: OpenRouterResponse;

    try {
      data = (await response.json()) as OpenRouterResponse;
    } catch {
      throw new BadGatewayException('AI provider returned an invalid response');
    }

    const content = data.choices?.[0]?.message?.content;
    if (
      typeof data.id !== 'string' ||
      typeof data.model !== 'string' ||
      typeof content !== 'string'
    ) {
      throw new BadGatewayException('AI provider returned an invalid response');
    }

    const usage = data.usage
      ? {
          ...(typeof data.usage.prompt_tokens === 'number' && {
            promptTokens: data.usage.prompt_tokens,
          }),
          ...(typeof data.usage.completion_tokens === 'number' && {
            completionTokens: data.usage.completion_tokens,
          }),
          ...(typeof data.usage.total_tokens === 'number' && {
            totalTokens: data.usage.total_tokens,
          }),
        }
      : null;

    return { id: data.id, model: data.model, content, usage };
  }
}
