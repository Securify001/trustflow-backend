import { EscrowReconciliationWorkerService } from './escrow-reconciliation-worker.service';
import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { resetEnvConfig, setTestEnv, validateEnv } from '../config/env.config';

// runOnce()/onModuleInit() read config.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS, which requires
// validateEnv() to have run first — normally done once in main.ts.
validateEnv();

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function fakeLock(): jest.Mocked<Pick<DistributedLockService, 'tryAcquire' | 'release'>> {
  return {
    tryAcquire: jest.fn().mockResolvedValue('fake-token'),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

describe('EscrowReconciliationWorkerService', () => {
  const originalInterval = process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS;
  let reconciliationService: jest.Mocked<Pick<EscrowReconciliationService, 'reconcile'>>;
  let lock: jest.Mocked<Pick<DistributedLockService, 'tryAcquire' | 'release'>>;
  let worker: EscrowReconciliationWorkerService;

  beforeEach(() => {
    reconciliationService = {
      reconcile: jest.fn().mockResolvedValue({ runId: 'recon-1', driftCount: 0 }),
    };
    lock = fakeLock();
    worker = new EscrowReconciliationWorkerService(
      reconciliationService as unknown as EscrowReconciliationService,
      lock as unknown as DistributedLockService,
    );
  });

  afterEach(async () => {
    await worker.onModuleDestroy();
    jest.useRealTimers();
    if (originalInterval === undefined) delete process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS;
    else process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS = originalInterval;
    // Re-validate so a per-test override (via setTestEnv) doesn't leak into the next test.
    resetEnvConfig();
    validateEnv();
  });

  describe('runOnce', () => {
    it('delegates to the reconciliation service', async () => {
      await worker.runOnce();
      expect(reconciliationService.reconcile).toHaveBeenCalledWith();
    });

    it('does not run overlapping sweeps in the same process', async () => {
      let releaseSweep!: () => void;
      reconciliationService.reconcile.mockImplementation(
        () =>
          new Promise(resolve => {
            releaseSweep = () =>
              resolve({
                runId: 'recon-blocked',
                startedAt: '',
                completedAt: '',
                checked: 0,
                driftCount: 0,
                repairedCount: 0,
                drifts: [],
                errorCount: 0,
                errors: [],
              });
          }),
      );

      const first = worker.runOnce();
      await flushPromises();
      await worker.runOnce();

      expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
      releaseSweep();
      await first;
    });

    it('skips a sweep when another instance holds the distributed lock', async () => {
      lock.tryAcquire.mockResolvedValue(null);

      await worker.runOnce();

      expect(reconciliationService.reconcile).not.toHaveBeenCalled();
      expect(lock.release).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('schedules periodic sweeps at the default interval', () => {
      jest.useFakeTimers();
      delete process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS;
      resetEnvConfig();
      validateEnv();

      worker.onModuleInit();
      expect(reconciliationService.reconcile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(10 * 60 * 1000);
      return Promise.resolve().then(() => {
        expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
      });
    });

    it('honors a custom ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS', () => {
      jest.useFakeTimers();
      setTestEnv({ ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS: '1000' });

      worker.onModuleInit();
      jest.advanceTimersByTime(999);
      expect(reconciliationService.reconcile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      return Promise.resolve().then(() => {
        expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
      });
    });

    it('does not schedule a sweep when the interval is disabled', () => {
      jest.useFakeTimers();
      setTestEnv({ ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS: '0' });

      worker.onModuleInit();
      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(reconciliationService.reconcile).not.toHaveBeenCalled();
    });

    it('stops sweeping once destroyed', () => {
      jest.useFakeTimers();
      setTestEnv({ ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS: '1000' });

      worker.onModuleInit();
      worker.onModuleDestroy();
      jest.advanceTimersByTime(10000);

      expect(reconciliationService.reconcile).not.toHaveBeenCalled();
    });
  });

  describe('sweep failures', () => {
    it('logs and swallows an error instead of crashing the interval', () => {
      jest.useFakeTimers();
      setTestEnv({ ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS: '1000' });
      reconciliationService.reconcile.mockRejectedValue(new Error('boom'));

      worker.onModuleInit();
      expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    });
  });
});
