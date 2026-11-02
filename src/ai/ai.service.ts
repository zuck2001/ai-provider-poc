import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiResponse {
  id: string;
  model: string;
  content: string;
  usage: AiUsage | null;
}

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
export class AiService {
  constructor(private readonly configService: ConfigService) {}

  async generate(prompt: string): Promise<AiResponse> {
    return this.request({
      messages: [{ role: 'user', content: prompt }],
    });
  }

  async generateWithPdf(
    prompt: string,
    filename: string,
    fileData: string,
  ): Promise<AiResponse> {
    return this.request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'file', file: { filename, file_data: fileData } },
          ],
        },
      ],
      plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],
      max_tokens: 100,
    });
  }

  private async request(payload: Record<string, unknown>): Promise<AiResponse> {
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
