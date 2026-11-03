import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiController } from './ai.controller.js';
import { AiGeneration } from './entities/ai-generation.entity.js';
import { PromptTemplate } from './entities/prompt-template.entity.js';
import { GenerationService } from './generation.service.js';
import { PromptTemplateService } from './prompt-template.service.js';
import {
  AI_PROVIDER_CLASSES,
  aiProviderFactory,
} from './providers/ai-provider.factory.js';

@Module({
  imports: [TypeOrmModule.forFeature([PromptTemplate, AiGeneration])],
  providers: [
    ...AI_PROVIDER_CLASSES,
    aiProviderFactory,
    GenerationService,
    PromptTemplateService,
  ],
  controllers: [AiController],
})
export class AiModule {}
