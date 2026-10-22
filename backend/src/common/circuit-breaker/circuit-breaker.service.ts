import { Injectable } from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import Breaker from 'opossum';

export interface CircuitBreakerOptions {
  name: string;
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  rollingCountTimeout?: number;
  rollingCountBuckets?: number;
  fallback?: (error: Error) => Promise<unknown>;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new SanitizedLogger(CircuitBreakerService.name);
  private readonly breakers = new Map<string, Breaker>();

  getBreaker<T>(
    name: string,
    fn: (this: Breaker) => Promise<T>,
    options: CircuitBreakerOptions,
  ): Breaker {
    if (this.breakers.has(name)) {
      return this.breakers.get(name)!;
    }

    const breaker = new Breaker(fn, {
      timeout: options.timeout ?? 30000,
      errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
      resetTimeout: options.resetTimeout ?? 30000,
      rollingCountTimeout: options.rollingCountTimeout ?? 10000,
      rollingCountBuckets: options.rollingCountBuckets ?? 10,
      name,
    });

    if (options.fallback) {
      breaker.fallback(options.fallback);
    }

    breaker.on('open', () => {
      this.logger.warn(`Circuit breaker "${name}" is now OPEN. Failing fast.`);
    });

    breaker.on('halfOpen', () => {
      this.logger.log(`Circuit breaker "${name}" is now HALF_OPEN. Attempting recovery.`);
    });

    breaker.on('close', () => {
      this.logger.log(`Circuit breaker "${name}" is now CLOSED. Service recovered.`);
    });

    this.breakers.set(name, breaker);
    return breaker;
  }

  async execute<T>(name: string, fn: () => Promise<T>, options: CircuitBreakerOptions): Promise<T> {
    const breaker = this.getBreaker(
      name,
      async function (this: Breaker) {
        return fn();
      },
      options,
    );

    return breaker.fire() as Promise<T>;
  }

  getStatus(name: string): { state: string; stats: Breaker.Stats } | null {
    const breaker = this.breakers.get(name);
    if (!breaker) return null;

    return {
      state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
      stats: breaker.stats,
    };
  }

  getAllStatus(): Record<string, { state: string; stats: Breaker.Stats }> {
    const result: Record<string, { state: string; stats: Breaker.Stats }> = {};

    for (const [name, breaker] of this.breakers.entries()) {
      result[name] = {
        state: breaker.opened ? 'OPEN' : breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED',
        stats: breaker.stats,
      };
    }

    return result;
  }
}
