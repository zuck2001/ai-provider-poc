import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AiModule } from './ai/ai.module.js';

const dataDirectory = resolve(process.cwd(), 'data');
mkdirSync(dataDirectory, { recursive: true });

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database:
        process.env.AI_POC_DATABASE_PATH ??
        resolve(dataDirectory, 'ai-provider-poc.sqlite'),
      autoLoadEntities: true,
      // Local PoC only. Production deployments must use migrations instead.
      synchronize: true,
    }),
    AiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
