import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxEventDispatcher } from './outbox-event-dispatcher.service';
import { WebhookService } from '../webhook/webhook.service';
import { MetricsService } from '../monitoring/metrics.service';
import { OutboxEvent } from './outbox.types';
import { resetEnvConfig, validateEnv } from '../config/env.config';

validateEnv();

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'evt-1',
    dedupKey: 'gig:1:accepted',
    type: 'gig.accepted',
    aggregateType: 'gig',
    aggregateId: 'gig-1',
    payload: { ok: true },
    status: 'processing',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('OutboxRelayService', () => {
  let outbox: jest.Mocked<
    Pick<OutboxService, 'reclaimExpired' | 'claimDue' | 'sendWebhook' | 'markDelivered' | 'retry'>
  >;
  let publisher: { publish: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let metrics: { increment: jest.Mock };
  let relay: OutboxRelayService;

  beforeEach(() => {
    outbox = {
      reclaimExpired: jest.fn().mockResolvedValue(undefined),
      claimDue: jest.fn().mockResolvedValue([]),
      sendWebhook: jest.fn(),
      markDelivered: jest.fn().mockResolvedValue(undefined),
      retry: jest.fn().mockResolvedValue(undefined),
    } as never;
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(undefined) };
    metrics = { increment: jest.fn() };
    relay = new OutboxRelayService(
      outbox as unknown as OutboxService,
      publisher as unknown as OutboxPublisherService,
      {} as WebhookService,
      dispatcher as unknown as OutboxEventDispatcher,
      metrics as unknown as MetricsService,
    );
  });

  afterEach(() => {
    relay.onModuleDestroy();
    jest.useRealTimers();
  });

  it('reclaims expired leases before claiming a batch', async () => {
    await relay.runOnce();

    expect(outbox.reclaimExpired).toHaveBeenCalledWith(expect.any(Number), 100);
    expect(outbox.claimDue).toHaveBeenCalledWith(expect.any(Number), 30_000, 100);
    expect(outbox.reclaimExpired.mock.invocationCallOrder[0]).toBeLessThan(
      outbox.claimDue.mock.invocationCallOrder[0],
    );
  });

  it('delivers each claimed event to every destination and marks it delivered', async () => {
    const e = event();
    outbox.claimDue.mockResolvedValue([e]);

    await expect(relay.runOnce()).resolves.toBe(1);

    expect(publisher.publish).toHaveBeenCalledWith(e);
    // sendWebhook is only called for non-webhook aggregateType events
    expect(outbox.sendWebhook).toHaveBeenCalledWith(null, e.type, e.payload, e.dedupKey);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(e);
    expect(outbox.markDelivered).toHaveBeenCalledWith(e);
    expect(outbox.retry).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('outbox_delivery_total', {
      result: 'delivered',
      type: e.type,
    });
  });

  it('schedules a retry when a destination fails, without stopping the batch', async () => {
    const failing = event({ id: 'evt-fail' });
    const ok = event({ id: 'evt-ok', dedupKey: 'gig:2:accepted' });
    outbox.claimDue.mockResolvedValue([failing, ok]);
    const error = new Error('redis down');
    publisher.publish.mockRejectedValueOnce(error);

    await expect(relay.runOnce()).resolves.toBe(2);

    expect(outbox.retry).toHaveBeenCalledWith(failing, error);
    expect(outbox.markDelivered).toHaveBeenCalledTimes(1);
    expect(outbox.markDelivered).toHaveBeenCalledWith(ok);
    expect(metrics.increment).toHaveBeenCalledWith('outbox_delivery_total', {
      result: 'retry',
      type: failing.type,
    });
  });

  it("reports 'failed' once the retry marks the event as permanently failed", async () => {
    const e = event();
    outbox.claimDue.mockResolvedValue([e]);
    dispatcher.dispatch.mockRejectedValueOnce(new Error('boom'));
    outbox.retry.mockImplementation(async target => {
      target.status = 'failed';
    });

    await relay.runOnce();

    expect(metrics.increment).toHaveBeenCalledWith('outbox_delivery_total', {
      result: 'failed',
      type: e.type,
    });
  });

  it('polls on the configured interval and stops on destroy', async () => {
    jest.useFakeTimers();
    const runOnce = jest.spyOn(relay, 'runOnce').mockResolvedValue(0);

    relay.onModuleInit();
    jest.advanceTimersByTime(1000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    relay.onModuleDestroy();
    jest.advanceTimersByTime(5000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it('does not start polling when the interval is 0', () => {
    jest.useFakeTimers();
    process.env.OUTBOX_RELAY_INTERVAL_MS = '0';
    resetEnvConfig();
    validateEnv();
    try {
      const runOnce = jest.spyOn(relay, 'runOnce').mockResolvedValue(0);
      relay.onModuleInit();
      jest.advanceTimersByTime(10_000);
      expect(runOnce).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTBOX_RELAY_INTERVAL_MS;
      resetEnvConfig();
      validateEnv();
    }
  });

  it('does not spawn a new webhook event when relaying an existing webhook event', async () => {
    const webhookEvent = event({ id: 'webhook-evt', aggregateType: 'webhook' });
    outbox.claimDue.mockResolvedValue([webhookEvent]);

    await relay.runOnce();

    expect(publisher.publish).toHaveBeenCalledWith(webhookEvent);
    expect(outbox.sendWebhook).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).toHaveBeenCalledWith(webhookEvent);
    expect(outbox.markDelivered).toHaveBeenCalledWith(webhookEvent);
  });

  it('prevents perpetual re-spawning: webhook clones are not re-fanned out', async () => {
    const originalEvent = event({ type: 'escrow.created', aggregateType: 'escrow' });
    const webhookClone = event({
      id: 'webhook-clone',
      type: 'escrow.created',
      aggregateType: 'webhook',
      dedupKey: originalEvent.dedupKey,
    });

    // First runOnce processes the original event and spawns a webhook
    outbox.claimDue.mockResolvedValueOnce([originalEvent]);
    await relay.runOnce();
    expect(outbox.sendWebhook).toHaveBeenCalledTimes(1);

    // Second runOnce processes the spawned webhook clone
    outbox.claimDue.mockResolvedValueOnce([webhookClone]);
    await relay.runOnce();

    // sendWebhook should not be called again for the webhook clone
    expect(outbox.sendWebhook).toHaveBeenCalledTimes(1);
    // dispatcher.dispatch should still be called for the webhook clone
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });
});
