import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  Optional,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { GigService } from '../gig/gig.service';
import { GigStatus, Gig } from '../gig/gig.entity';
import { MetricsService } from '../monitoring/metrics.service';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';

/** How often to run the expiry check sweep (every 24 hours). */
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Reminder thresholds in milliseconds — matching the 7d / 3d / 24h requirements. */
export const REMINDER_THRESHOLDS_MS = [
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '3d', ms: 3 * 24 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

export type ReminderThresholdLabel = (typeof REMINDER_THRESHOLDS_MS)[number]['label'];

/** Redis key prefix for deduplication records (TTL = threshold window). */
const REMINDER_DEDUP_PREFIX = 'milestone:reminder:sent:';

/** Maximum deduplication entries tracked in-memory when Redis is unavailable. */
const IN_MEMORY_DEDUP_MAX = 10_000;

export interface ReminderEvent {
  gigId: string;
  gigTitle: string;
  creator: string;
  respondBy: string;
  threshold: ReminderThresholdLabel;
  msRemaining: number;
}

/**
 * MilestoneExpiryScheduler runs a daily sweep over open gig milestones and
 * dispatches reminder notifications at the 7-day, 3-day, and 24-hour marks
 * before the response deadline.
 *
 * Deduplication:
 *   Each (gigId × threshold) pair is deduplicated so reminders fire at most
 *   once per threshold window.  Redis is the primary dedup store (TTL = threshold
 *   window), with an in-memory LRU fallback when Redis is unavailable.
 *
 * Follows the `GigExpiryWorkerService` pattern: plain `setInterval`, no
 * `@nestjs/schedule` decorators, configurable via env, single-concurrency guard,
 * and graceful shutdown.
 */
@Injectable()
export class MilestoneExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MilestoneExpiryScheduler.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  /** In-memory fallback dedup set when Redis is unavailable. */
  private readonly inMemoryDedup = new Set<string>();
  private readonly inMemoryDedupQueue: string[] = [];

  constructor(
    private readonly gigService: GigService,
    private readonly metrics: MetricsService,
    private readonly gateway: MilestoneNotificationsGateway,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log('Milestone expiry scheduler disabled (MILESTONE_EXPIRY_SWEEP_INTERVAL_MS <= 0)');
      return;
    }

    // Run once immediately so the first sweep doesn't wait a full day after startup.
    this.runSweep().catch(err =>
      this.logger.error('Initial milestone expiry sweep failed', err),
    );

    this.timer = setInterval(() => {
      this.runSweep().catch(err =>
        this.logger.error('Milestone expiry sweep tick failed', err),
      );
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Milestone expiry scheduler started — sweeping every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Run a single sweep over all open gigs, computing each one's time-to-deadline
   * and dispatching reminder notifications for gigs that fall within a threshold
   * window and have not already had that reminder sent.
   *
   * Exposed publicly so tests and admin endpoints can trigger a sweep on demand.
   */
  async runSweep(now: Date = new Date()): Promise<ReminderEvent[]> {
    if (this.sweeping) {
      this.logger.debug('Previous milestone sweep still in flight — skipping this tick');
      this.metrics.increment('milestone_expiry_sweep_skipped_total');
      return [];
    }

    this.sweeping = true;
    const startMs = Date.now();
    const dispatched: ReminderEvent[] = [];

    try {
      // Only open gigs can be nearing expiry — expired/accepted/cancelled are irrelevant.
      const openGigs = await this.gigService.findByStatus(GigStatus.OPEN);

      for (const gig of openGigs) {
        const reminders = await this.computeReminders(gig, now);
        for (const reminder of reminders) {
          const claimed = await this.claimReminder(reminder.gigId, reminder.threshold);
          if (!claimed) {
            this.logger.debug(
              `Reminder ${reminder.threshold} for gig ${reminder.gigId} already claimed or sent — skipping`,
            );
            continue;
          }

          await this.dispatchReminder(reminder);
          dispatched.push(reminder);
        }
      }

      const durationMs = Date.now() - startMs;
      this.metrics.increment('milestone_expiry_sweep_reminders_total', {}, dispatched.length);
      this.metrics.increment('milestone_expiry_sweep_duration_ms', { status: 'success' });
      this.logger.log(
        `Milestone expiry sweep completed in ${durationMs}ms — ${dispatched.length} reminder(s) dispatched across ${openGigs.length} open gig(s)`,
      );
    } catch (err) {
      this.metrics.increment('milestone_expiry_sweep_duration_ms', { status: 'error' });
      this.logger.error('Milestone expiry sweep failed', err);
    } finally {
      this.sweeping = false;
    }

    return dispatched;
  }

  /**
   * Determine which reminder thresholds apply to `gig` relative to `now`.
   * A threshold applies when the deadline is within that window but outside
   * the next-smaller window (so each gig triggers each reminder at most once
   * per sweep, regardless of how many thresholds it falls inside).
   */
  computeReminders(gig: Gig, now: Date = new Date()): ReminderEvent[] {
    const deadline = new Date(gig.respondBy).getTime();
    const msRemaining = deadline - now.getTime();

    if (msRemaining <= 0) {
      // Already past deadline — the expiry worker handles this, not reminders.
      return [];
    }

    const reminders: ReminderEvent[] = [];

    for (const threshold of REMINDER_THRESHOLDS_MS) {
      if (msRemaining <= threshold.ms) {
        reminders.push({
          gigId: gig.id,
          gigTitle: gig.title,
          creator: gig.creator,
          respondBy: gig.respondBy,
          threshold: threshold.label,
          msRemaining,
        });
      }
    }

    return reminders;
  }

  // ─── Deduplication ────────────────────────────────────────────────────────────

  /**
   * Atomically claims the right to send a (gigId × threshold) reminder.
   * Returns true if this replica won the claim and should dispatch the reminder;
   * false if another replica already claimed it or it was already sent.
   *
   * Uses Redis SET NX EX for atomic cross-replica deduplication, falling back
   * to in-memory when Redis is unavailable (#799).
   */
  async claimReminder(gigId: string, threshold: ReminderThresholdLabel): Promise<boolean> {
    const key = this.dedupKey(gigId, threshold);
    const ttlMs = REMINDER_THRESHOLDS_MS.find(t => t.label === threshold)?.ms ?? DEFAULT_SWEEP_INTERVAL_MS;
    const ttlSec = Math.ceil(ttlMs / 1000);

    if (this.redis) {
      try {
        const result = await this.redis.set(key, '1', 'EX', ttlSec, 'NX');
        if (result !== 'OK') {
          // Another replica already claimed this reminder
          return false;
        }
        return true;
      } catch (err) {
        this.logger.warn(`Redis dedup claim failed for ${key}, falling back to in-memory`, err);
      }
    }

    // In-memory LRU fallback
    if (this.inMemoryDedup.has(key)) {
      return false;
    }
    this.inMemoryDedup.add(key);
    this.inMemoryDedupQueue.push(key);
    if (this.inMemoryDedupQueue.length > IN_MEMORY_DEDUP_MAX) {
      const oldest = this.inMemoryDedupQueue.shift();
      if (oldest) this.inMemoryDedup.delete(oldest);
    }
    return true;
  }

  // ─── Notification dispatch ───────────────────────────────────────────────────

  /**
   * Dispatches a reminder notification to the WebSocket gateway so connected
   * clients subscribed to the gig room receive real-time alerts.
   */
  private async dispatchReminder(reminder: ReminderEvent): Promise<void> {
    try {
      this.gateway.emitMilestoneUpdate(reminder.gigId, 'milestone.expiry_reminder', {
        gigId: reminder.gigId,
        gigTitle: reminder.gigTitle,
        creator: reminder.creator,
        respondBy: reminder.respondBy,
        threshold: reminder.threshold,
        msRemaining: reminder.msRemaining,
        message: `Milestone deadline in ${reminder.threshold}: "${reminder.gigTitle}"`,
      });

      this.logger.log(
        `Dispatched ${reminder.threshold} expiry reminder for gig ${reminder.gigId} (${reminder.gigTitle})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to dispatch reminder for gig ${reminder.gigId}`,
        err,
      );
      throw err;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private dedupKey(gigId: string, threshold: ReminderThresholdLabel): string {
    return `${REMINDER_DEDUP_PREFIX}${gigId}:${threshold}`;
  }

  private getIntervalMs(): number {
    const raw = Number(process.env.MILESTONE_EXPIRY_SWEEP_INTERVAL_MS);
    return Number.isFinite(raw) && raw !== 0 ? raw : DEFAULT_SWEEP_INTERVAL_MS;
  }
}
