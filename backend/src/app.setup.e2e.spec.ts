// Small, fast body limit for this file only. Must be set before validateEnv() runs (it
// caches its result at module scope), so it happens before any other import below.
process.env.BODY_LIMIT_MB = '1';

import { Test, TestingModule } from '@nestjs/testing';
import { Body, Controller, Get, INestApplication, NotFoundException, Post } from '@nestjs/common';
import request from 'supertest';
import { configureApp } from './app.setup';
import { SentryModule } from './sentry/sentry.module';
import { LoggingModule } from './common/logging/logging.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { validateEnv } from './config/env.config';

validateEnv();

@Controller('app-setup-test')
class AppSetupTestController {
  @Get('http-exception')
  throwHttpException(): never {
    throw new NotFoundException('thing not found');
  }

  @Get('unexpected-error')
  throwUnexpected(): never {
    // Stands in for any uncaught non-HttpException reaching the global filter (e.g. a
    // ZodError that slipped past a controller's own try/catch) — the filter treats every
    // non-HttpException identically: a generic 500 body, never the original message.
    throw new Error('unexpected failure with internal details that must not leak');
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return { received: body };
  }
}

/**
 * Exercises behavior that only exists because of the real HTTP-level stack configureApp()
 * wires up (body-size limit, the exception filter's response shape, CORS) — previously
 * impossible to test since every e2e-style spec rebuilt its own partial, inconsistent copy
 * of that stack by hand. See #420, #477.
 */
describe('configureApp (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [SentryModule, LoggingModule, MonitoringModule],
      controllers: [AppSetupTestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app, { skipSentryInit: true, skipIndexerStart: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('body size limit', () => {
    it('accepts a JSON body under the configured limit', async () => {
      await request(app.getHttpServer())
        .post('/v1/app-setup-test/echo')
        .send({ data: 'x'.repeat(1000) })
        .expect(201);
    });

    it('rejects a JSON body over the configured limit with 413', async () => {
      // BODY_LIMIT_MB=1 for this file; comfortably over 1 MB once JSON-encoded.
      await request(app.getHttpServer())
        .post('/v1/app-setup-test/echo')
        .send({ data: 'x'.repeat(2 * 1024 * 1024) })
        .expect(413);
    });
  });

  describe('global exception filter response shape', () => {
    it('renders a thrown HttpException with its own status and message', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/app-setup-test/http-exception')
        .expect(404);

      expect(res.body).toMatchObject({
        statusCode: 404,
        message: 'thing not found',
        path: '/v1/app-setup-test/http-exception',
      });
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('renders any other thrown error as a generic 500 without leaking the original message', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/app-setup-test/unexpected-error')
        .expect(500);

      expect(res.body).toMatchObject({
        statusCode: 500,
        message: 'Internal server error',
        path: '/v1/app-setup-test/unexpected-error',
      });
      expect(JSON.stringify(res.body)).not.toContain('internal details');
    });
  });

  describe('CORS', () => {
    it('answers a preflight request with the configured origin policy', async () => {
      const res = await request(app.getHttpServer())
        .options('/app-setup-test/echo')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });
});
