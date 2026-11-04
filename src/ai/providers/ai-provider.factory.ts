import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider } from './ai-provider.js';
import { OpenRouterAiProvider } from './openrouter.provider.js';

export const DEFAULT_AI_PROVIDER = 'openrouter';

/** Concrete strategies that can be selected through `AI_PROVIDER`. */
export const AI_PROVIDER_CLASSES = [OpenRouterAiProvider];

export function selectAiProvider(
  configured: string | undefined,
  providers: AiProvider[],
): AiProvider {
  const names = providers.map((candidate) => candidate.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    throw new Error(`Duplicate AI provider name "${duplicate}"`);
  }

  const name = configured?.trim().toLowerCase() || DEFAULT_AI_PROVIDER;
  const provider = providers.find((candidate) => candidate.name === name);
  if (!provider) {
    throw new Error(
      `Unknown AI_PROVIDER "${name}". Expected one of: ${names.join(', ')}`,
    );
  }
  return provider;
}

/** Binds the `AiProvider` token to the strategy named by `AI_PROVIDER`. */
export const aiProviderFactory: FactoryProvider<AiProvider> = {
  provide: AiProvider,
  inject: [ConfigService, ...AI_PROVIDER_CLASSES],
  useFactory: (config: ConfigService, ...providers: AiProvider[]) =>
    selectAiProvider(config.get<string>('AI_PROVIDER'), providers),
};
