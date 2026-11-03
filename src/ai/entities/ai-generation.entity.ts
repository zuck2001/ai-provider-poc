import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AiUsage } from '../providers/ai-provider.js';
import { PromptTemplate } from './prompt-template.entity.js';

export type GenerationStatus = 'completed' | 'failed';

@Entity('ai_generations')
export class AiGeneration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar', { nullable: true })
  provider: string | null;

  @Column('varchar', { nullable: true })
  providerRequestId: string | null;

  @Column('varchar', { nullable: true })
  promptTemplateId: string | null;

  @ManyToOne(() => PromptTemplate, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'promptTemplateId' })
  promptTemplate: PromptTemplate | null;

  @Column('varchar', { nullable: true })
  model: string | null;

  @Column('text')
  promptText: string;

  @Column('text', { nullable: true })
  responseText: string | null;

  @Column('simple-json', { nullable: true })
  usage: AiUsage | null;

  @Column('varchar', { nullable: true })
  inputMode: string | null;

  @Column('varchar', { nullable: true })
  parserRequested: string | null;

  @Column('varchar')
  status: GenerationStatus;

  @CreateDateColumn()
  createdAt: Date;
}
