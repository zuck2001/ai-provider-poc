import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PromptTemplate } from './entities/prompt-template.entity.js';

const SEEDED_TEMPLATE = {
  key: 'rd-project-summary',
  version: 1,
  template:
    'Summarize the following R&D project in two sentences: {{description}}',
};

@Injectable()
export class PromptTemplateService implements OnModuleInit {
  constructor(
    @InjectRepository(PromptTemplate)
    private readonly repository: Repository<PromptTemplate>,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.repository.findOneBy({
      key: SEEDED_TEMPLATE.key,
      version: SEEDED_TEMPLATE.version,
    });
    if (!existing) {
      await this.repository.save(this.repository.create(SEEDED_TEMPLATE));
    }
  }

  async renderLatest(
    key: string,
    variables: Record<string, string>,
  ): Promise<{ prompt: string; template: PromptTemplate }> {
    const template = await this.repository.findOne({
      where: { key },
      order: { version: 'DESC' },
    });
    if (!template) {
      throw new NotFoundException('Prompt template not found');
    }

    const required = [
      ...new Set(
        Array.from(
          template.template.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g),
          (match) => match[1],
        ),
      ),
    ];
    const missing = required.filter(
      (name) => typeof variables[name] !== 'string',
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing template variables: ${missing.join(', ')}`,
      );
    }

    const prompt = template.template.replace(
      /\{\{([A-Za-z0-9_]+)\}\}/g,
      (_placeholder, name: string) => variables[name],
    );
    if (prompt.length > 10_000) {
      throw new BadRequestException(
        'Rendered prompt must be at most 10,000 characters',
      );
    }
    return { prompt, template };
  }
}
