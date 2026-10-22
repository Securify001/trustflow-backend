import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { RateLimitGuard } from './rate-limit.guard';
import { RedisModule } from '../redis/redis.module';
import { MonitoringModule } from '../../monitoring/monitoring.module';
import { ReputationModule } from '../../reputation/reputation.module';

@Module({
  imports: [JwtModule, RedisModule, MonitoringModule, ReputationModule],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class RateLimitModule {}
