import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('prompt_templates')
@Unique(['key', 'version'])
@Check(`"version" > 0`)
export class PromptTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  key: string;

  @Column('integer')
  version: number;

  @Column('text')
  template: string;

  @CreateDateColumn()
  createdAt: Date;
}
