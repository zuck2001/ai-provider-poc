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

/** A PDF passed to a provider as raw base64 (no data-URL prefix). */
export interface PdfAttachment {
  filename: string;
  mimeType: 'application/pdf';
  base64: string;
}

export interface GenerateOptions {
  maxTokens?: number;
}

/**
 * Strategy contract for AI providers. It also serves as the NestJS
 * injection token: consumers depend on `AiProvider`, and `AiModule` decides
 * which concrete provider is supplied (see `AI_PROVIDER`).
 */
export abstract class AiProvider {
  /** Stable identifier persisted with each generation, e.g. 'openrouter'. */
  abstract readonly name: string;

  /** PDF parser requested by this provider, persisted as `parserRequested`. */
  abstract readonly pdfParser: string | null;

  abstract generate(
    prompt: string,
    opts?: GenerateOptions,
  ): Promise<AiResponse>;

  abstract generateWithPdf(
    prompt: string,
    file: PdfAttachment,
    opts?: GenerateOptions,
  ): Promise<AiResponse>;
}
