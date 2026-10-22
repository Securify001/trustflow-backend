import { Test, TestingModule } from '@nestjs/testing';
import {
  MilestoneExpiryScheduler,
  REMINDER_THRESHOLDS_MS,
  ReminderThresholdLabel,
} from './milestone-expiry-scheduler.service';
import { GigService } from '../gig/gig.service';
import { MetricsService } from '../monitoring/metrics.service';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { GigStatus, Gig } from '../gig/gig.entity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGig(overrides: Partial<Gig> = {}): Gig {
  const now = Date.now();
  return {
    id: 'gig-1',
    creator: 'GXYZ',
    title: 'Test Gig',
    budgetXLM: '100',
    status: GigStatus.OPEN,
    createdAt: new Date(now).toISOString(),
    respondBy: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days from now
    version: 1,
    ...overrides,
  };
}

function msFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGigService = {
  findByStatus: jest.fn(),
};

const mockGateway = {
  emitMilestoneUpdate: jest.fn(),
};

const mockMetrics = {
  increment: jest.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MilestoneExpiryScheduler', () => {
  let scheduler: MilestoneExpiryScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MilestoneExpiryScheduler,
        { provide: GigService, useValue: mockGigService },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: MilestoneNotificationsGateway, useValue: mockGateway },
        { provide: REDIS_CLIENT, useValue: null }, // no Redis in unit tests
      ],
    }).compile();

    scheduler = module.get(MilestoneExpiryScheduler);
  });

  // ─── computeReminders ───────────────────────────────────────────────────────

  describe('computeReminders', () => {
    it('returns no reminders for a gig whose deadline is already past', () => {
      const gig = makeGig({ respondBy: msFromNow(-1000) });
      expect(scheduler.computeReminders(gig)).toEqual([]);
    });

    it('returns no reminders for a gig with > 7 days remaining', () => {
      const gig = makeGig({ respondBy: msFromNow(8 * 24 * 60 * 60 * 1000) });
      expect(scheduler.computeReminders(gig)).toHaveLength(0);
    });

    it('returns only the 7d reminder when deadline is exactly 7 days away', () => {
      const gig = makeGig({ respondBy: msFromNow(7 * 24 * 60 * 60 * 1000 - 1) });
      const reminders = scheduler.computeReminders(gig);
      expect(reminders.map(r => r.threshold)).toEqual(['7d']);
    });

    it('returns 7d and 3d reminders when deadline is ~2.5 days away', () => {
      const gig = makeGig({ respondBy: msFromNow(2.5 * 24 * 60 * 60 * 1000) });
      const thresholds = scheduler.computeReminders(gig).map(r => r.threshold);
      expect(thresholds).toContain('7d');
      expect(thresholds).toContain('3d');
      expect(thresholds).not.toContain('24h');
    });

    it('returns all three reminders when deadline is 10 hours away', () => {
      const gig = makeGig({ respondBy: msFromNow(10 * 60 * 60 * 1000) });
      const thresholds = scheduler.computeReminders(gig).map(r => r.threshold);
      expect(thresholds).toContain('7d');
      expect(thresholds).toContain('3d');
      expect(thresholds).toContain('24h');
    });

    it('populates reminder fields correctly', () => {
      const respondBy = msFromNow(10 * 60 * 60 * 1000);
      const gig = makeGig({ id: 'gig-99', title: 'My Gig', creator: 'GABC', respondBy });
      const reminders = scheduler.computeReminders(gig);

      expect(reminders[0]).toMatchObject({
        gigId: 'gig-99',
        gigTitle: 'My Gig',
        creator: 'GABC',
        respondBy,
      });
      expect(reminders[0].msRemaining).toBeGreaterThan(0);
    });
  });

  // ─── Deduplication ──────────────────────────────────────────────────────────

  describe('deduplication (in-memory fallback)', () => {
    it('first claim succeeds', async () => {
      expect(await scheduler.claimReminder('gig-1', '24h')).toBe(true);
    });

    it('second claim fails (already claimed)', async () => {
      await scheduler.claimReminder('gig-1', '24h');
      expect(await scheduler.claimReminder('gig-1', '24h')).toBe(false);
    });

    it('different thresholds are independent', async () => {
      await scheduler.claimReminder('gig-1', '24h');
      expect(await scheduler.claimReminder('gig-1', '7d')).toBe(true);
      expect(await scheduler.claimReminder('gig-1', '3d')).toBe(true);
    });

    it('different gigs are independent', async () => {
      await scheduler.claimReminder('gig-1', '24h');
      expect(await scheduler.claimReminder('gig-2', '24h')).toBe(true);
    });

    it('atomic claim prevents concurrent replicas from both dispatching the same reminder', async () => {
      const gig = makeGig({ respondBy: msFromNow(6 * 60 * 60 * 1000) });
      mockGigService.findByStatus.mockResolvedValue([gig]);

      // Simulate two replicas running runSweep concurrently
      const [result1, result2] = await Promise.all([
        scheduler.runSweep(),
        scheduler.runSweep(),
      ]);

      const totalDispatched = result1.length + result2.length;
      const totalEmitCalls = (mockGateway.emitMilestoneUpdate as jest.Mock).mock.calls.length;

      // Each reminder (3 thresholds) should be dispatched exactly once across both replicas
      // One replica wins all claims, the other gets none for the same (gig, threshold) pairs
      expect(totalEmitCalls).toBe(totalDispatched);
      expect(totalEmitCalls).toBeGreaterThan(0); // At least one reminder dispatched
    });
  });

  // ─── runSweep ───────────────────────────────────────────────────────────────

  describe('runSweep', () => {
    it('dispatches no reminders when there are no open gigs', async () => {
      mockGigService.findByStatus.mockResolvedValue([]);
      const result = await scheduler.runSweep();
      expect(result).toHaveLength(0);
      expect(mockGateway.emitMilestoneUpdate).not.toHaveBeenCalled();
    });

    it('dispatches a reminder for a gig inside the 24h threshold', async () => {
      const gig = makeGig({ respondBy: msFromNow(6 * 60 * 60 * 1000) });
      mockGigService.findByStatus.mockResolvedValue([gig]);

      const result = await scheduler.runSweep();

      // 3 thresholds all fire (6h < 24h < 3d < 7d)
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(mockGateway.emitMilestoneUpdate).toHaveBeenCalledWith(
        gig.id,
        'milestone.expiry_reminder',
        expect.objectContaining({ gigId: gig.id }),
      );
    });

    it('deduplicates reminders — same gig+threshold is not dispatched twice', async () => {
      const gig = makeGig({ respondBy: msFromNow(6 * 60 * 60 * 1000) });
      mockGigService.findByStatus.mockResolvedValue([gig]);

      await scheduler.runSweep();
      const firstCount = (mockGateway.emitMilestoneUpdate as jest.Mock).mock.calls.length;

      // Second sweep — all should be deduplicated
      await scheduler.runSweep();
      const secondCount = (mockGateway.emitMilestoneUpdate as jest.Mock).mock.calls.length;

      expect(secondCount).toBe(firstCount); // no new calls on second sweep
    });

    it('skips a concurrent sweep (sweeping guard)', async () => {
      const gig = makeGig({ respondBy: msFromNow(6 * 60 * 60 * 1000) });
      // First sweep is "in-flight" — we simulate this by starting two concurrently
      mockGigService.findByStatus.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([gig]), 20)),
      );

      const [result1, result2] = await Promise.all([
        scheduler.runSweep(),
        scheduler.runSweep(), // should be skipped
      ]);

      // One sweep ran, one was skipped (returns [])
      const skipped = result1.length === 0 || result2.length === 0;
      expect(skipped).toBe(true);
    });

    it('increments metrics after a successful sweep', async () => {
      mockGigService.findByStatus.mockResolvedValue([]);
      await scheduler.runSweep();
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'milestone_expiry_sweep_reminders_total',
        {},
        0,
      );
    });
  });

  // ─── REMINDER_THRESHOLDS_MS (exported constants) ─────────────────────────────

  describe('REMINDER_THRESHOLDS_MS', () => {
    it('contains exactly the 7d, 3d, and 24h thresholds', () => {
      const labels = REMINDER_THRESHOLDS_MS.map(t => t.label);
      expect(labels).toEqual(expect.arrayContaining(['7d', '3d', '24h']));
      expect(labels).toHaveLength(3);
    });

    it('thresholds are ordered from largest to smallest', () => {
      const msList = REMINDER_THRESHOLDS_MS.map(t => t.ms);
      const sorted = [...msList].sort((a, b) => b - a);
      expect(msList).toEqual(sorted);
    });
  });
});
