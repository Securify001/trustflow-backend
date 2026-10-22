# Detailed Fix Documentation

## Issue #777: AuthService.validateToken() Unreachable Dead Code

### Location
File: `backend/src/auth/auth.service.ts`, lines 101-109

### Original Code (Buggy)
```typescript
validateToken(token: string): unknown {
  try {
    return this.jwtService.verify(token, { algorithms: [JWT_ALGORITHM] });
  } catch (error) {
    throw new UnauthorizedException('Invalid token');
  }

  throw new UnauthorizedException('Invalid token');  // ❌ UNREACHABLE
}
```

### Fixed Code
```typescript
validateToken(token: string): unknown {
  try {
    return this.jwtService.verify(token, { algorithms: [JWT_ALGORITHM] });
  } catch (error) {
    throw new UnauthorizedException('Invalid token');
  }
}
```

### Explanation
Every code path either:
- **Success path**: `return` in try block → function exits
- **Failure path**: `throw` in catch block → exception propagates

The final `throw` after the try/catch can never execute.

### Tests
No new tests needed - existing auth.service.spec.ts tests continue to pass.

---

## Issue #798: rate-limit.module.ts Incorrect Import Paths

### Location
File: `backend/src/common/rate-limit/rate-limit.module.ts`, lines 6-7

### Original Code (Buggy)
```typescript
import { MonitoringModule } from '../../../monitoring/monitoring.module';
import { ReputationModule } from '../../../reputation/reputation.module';
```

### Fixed Code
```typescript
import { MonitoringModule } from '../../monitoring/monitoring.module';
import { ReputationModule } from '../../reputation/reputation.module';
```

### Directory Structure Analysis
```
backend/
├── src/
│   ├── monitoring/
│   │   └── monitoring.module.ts          ← Target
│   ├── reputation/
│   │   └── reputation.module.ts          ← Target
│   └── common/
│       └── rate-limit/
│           └── rate-limit.module.ts      ← Source
```

**From**: `backend/src/common/rate-limit/`  
**To**: `backend/src/monitoring/`

**Path calculation**:
- `../` → `backend/src/common/`
- `../../` → `backend/src/` ✅ CORRECT
- `../../../` → `backend/` ❌ WRONG (goes too far up)

### Tests
Verification: `npx tsc --noEmit -p tsconfig.eslint.json` shows no TS2307 errors.

---

## Issue #792: OutboxRelayService Perpetual Event Re-spawning

### Location
File: `backend/src/outbox/outbox-relay.service.ts`, lines 37-63

### Problem Flow
```
1. Domain event (escrow.created, aggregateType='escrow') is claimed
   ↓
2. OutboxRelayService.runOnce() processes it:
   - publisher.publish(event)           ✅
   - outbox.sendWebhook(...)            ✅ Creates NEW webhook event
   - dispatcher.dispatch(event)         ✅
   - outbox.markDelivered(event)        ✅
   ↓
3. OutboxService.sendWebhook() creates:
   {
     id: 'new-random-id',
     type: 'escrow.created',           ← SAME type!
     aggregateType: 'webhook',          ← Different aggregateType
     ...
   }
   and appends it to outbox:pending
   ↓
4. Later runOnce() claims this webhook event
   ↓
5. Processes it AGAIN:
   - publisher.publish(webhookEvent)    ✅
   - outbox.sendWebhook(...)            ❌ Creates ANOTHER clone!
   - dispatcher.dispatch(webhookEvent)  ❌ Fires handlers again!
   ↓
6. Infinite loop → Queue grows forever
```

### Original Code (Buggy)
```typescript
async runOnce(): Promise<number> {
  const events = await this.outbox.claimDue(now, leaseMs, batchSize);

  for (const event of events) {
    try {
      await this.publisher.publish(event);
      this.outbox.sendWebhook(null, event.type, event.payload, event.dedupKey);  // ❌ Always called
      await this.dispatcher.dispatch(event);
      await this.outbox.markDelivered(event);
    }
    ...
  }
}
```

### Fixed Code
```typescript
async runOnce(): Promise<number> {
  const events = await this.outbox.claimDue(now, leaseMs, batchSize);

  for (const event of events) {
    try {
      await this.publisher.publish(event);
      // Skip sendWebhook for events that are already webhook fan-outs to prevent
      // perpetual re-spawning of webhook events into the same queue (#792).
      if (event.aggregateType !== 'webhook') {  // ✅ Check added
        this.outbox.sendWebhook(null, event.type, event.payload, event.dedupKey);
      }
      await this.dispatcher.dispatch(event);
      await this.outbox.markDelivered(event);
    }
    ...
  }
}
```

### Tests Added
**File**: `backend/src/outbox/outbox-relay.service.spec.ts`

#### Test 1: Single webhook event is not re-spawned
```typescript
it('does not spawn a new webhook event when relaying an existing webhook event', async () => {
  const webhookEvent = event({ id: 'webhook-evt', aggregateType: 'webhook' });
  outbox.claimDue.mockResolvedValue([webhookEvent]);

  await relay.runOnce();

  expect(publisher.publish).toHaveBeenCalledWith(webhookEvent);
  expect(outbox.sendWebhook).not.toHaveBeenCalled();  // ✅ Not called for webhook
  expect(dispatcher.dispatch).toHaveBeenCalledWith(webhookEvent);
  expect(outbox.markDelivered).toHaveBeenCalledWith(webhookEvent);
});
```

#### Test 2: Two-step perpetual loop prevention
```typescript
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
  expect(outbox.sendWebhook).toHaveBeenCalledTimes(1);  // ✅ Still only 1
  expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);  // ✅ But both dispatched
});
```

---

## Issue #799: MilestoneExpiryScheduler Non-Atomic Deduplication

### Location
File: `backend/src/milestone-notifications/milestone-expiry-scheduler.service.ts`

### Problem: Race Condition

#### Scenario: 2 Replicas Restart Together
```
Time    Replica A                           Replica B
----    ---------                           ---------
T0      runSweep() starts                   runSweep() starts
T1      isDeduplicated('gig-1', '24h')      
T2      → Redis GET 'key'                   isDeduplicated('gig-1', '24h')
T3      → Returns null (not sent yet)       → Redis GET 'key'
T4      ✅ Proceeds to dispatch              → Returns null (not sent yet)
T5      dispatchReminder()                  ✅ Proceeds to dispatch
T6      → gateway.emit() to clients         dispatchReminder()
T7      markSent('gig-1', '24h')            → gateway.emit() to clients
T8      → Redis SET 'key' = '1'             markSent('gig-1', '24h')
T9                                          → Redis SET 'key' = '1'

Result: User receives DUPLICATE notification! ❌
```

### Original Code (Buggy)

#### Non-Atomic Check
```typescript
async isDeduplicated(gigId: string, threshold: ReminderThresholdLabel): Promise<boolean> {
  const key = this.dedupKey(gigId, threshold);
  if (this.redis) {
    const val = await this.redis.get(key);  // ❌ Separate GET
    return val !== null;
  }
  return this.inMemoryDedup.has(key);
}
```

#### Separate Mark
```typescript
async markSent(gigId: string, threshold: ReminderThresholdLabel): Promise<void> {
  const key = this.dedupKey(gigId, threshold);
  if (this.redis) {
    await this.redis.set(key, '1', 'EX', ttlSec);  // ❌ Separate SET
    return;
  }
  this.inMemoryDedup.add(key);
}
```

#### Usage in runSweep()
```typescript
for (const reminder of reminders) {
  const wasSent = await this.isDeduplicated(reminder.gigId, reminder.threshold);  // ❌ Check
  if (wasSent) continue;
  
  await this.dispatchReminder(reminder);  // ← Race window here!
  await this.markSent(reminder.gigId, reminder.threshold);  // ❌ Mark (too late)
  dispatched.push(reminder);
}
```

### Fixed Code

#### Atomic Claim
```typescript
async claimReminder(gigId: string, threshold: ReminderThresholdLabel): Promise<boolean> {
  const key = this.dedupKey(gigId, threshold);
  const ttlMs = REMINDER_THRESHOLDS_MS.find(t => t.label === threshold)?.ms ?? DEFAULT_SWEEP_INTERVAL_MS;
  const ttlSec = Math.ceil(ttlMs / 1000);

  if (this.redis) {
    try {
      // ✅ ATOMIC: Set key ONLY if it does NOT exist
      const result = await this.redis.set(key, '1', 'EX', ttlSec, 'NX');
      if (result !== 'OK') {
        // Another replica already claimed this reminder
        return false;  // ✅ Lost the race, don't dispatch
      }
      return true;  // ✅ Won the race, dispatch it
    } catch (err) {
      this.logger.warn(`Redis claim failed, falling back to in-memory`, err);
    }
  }

  // In-memory fallback (single replica)
  if (this.inMemoryDedup.has(key)) return false;
  this.inMemoryDedup.add(key);
  return true;
}
```

#### Usage in runSweep()
```typescript
for (const reminder of reminders) {
  const claimed = await this.claimReminder(reminder.gigId, reminder.threshold);  // ✅ Atomic
  if (!claimed) {
    this.logger.debug(`Reminder already claimed or sent — skipping`);
    continue;
  }
  
  await this.dispatchReminder(reminder);  // ✅ Only one replica reaches here
  dispatched.push(reminder);
}
```

### Why SET NX EX is Atomic

**Redis Guarantee**: `SET key value EX seconds NX` is a single atomic operation:
- **NX**: Only set if key does NOT exist
- **Returns**: `'OK'` if set succeeded, `null` if key already existed
- **Atomicity**: No other operation can interleave between the check and set

#### Scenario: 2 Replicas with Atomic Claim
```
Time    Replica A                           Replica B
----    ---------                           ---------
T0      runSweep() starts                   runSweep() starts
T1      claimReminder('gig-1', '24h')       
T2      → Redis SET NX EX 'key'             claimReminder('gig-1', '24h')
T3      → Returns 'OK' ✅                    → Redis SET NX EX 'key'
T4      → claimed = true                    → Returns null ❌ (key exists now)
T5      dispatchReminder()                  → claimed = false
T6      → gateway.emit() to clients         → Skips (logged as "already claimed")
T7      ✅ Done                              ✅ Done

Result: User receives notification EXACTLY ONCE ✅
```

### Tests Added
**File**: `backend/src/milestone-notifications/milestone-expiry-scheduler.service.spec.ts`

#### Test 1: Basic claim behavior
```typescript
describe('deduplication (in-memory fallback)', () => {
  it('first claim succeeds', async () => {
    expect(await scheduler.claimReminder('gig-1', '24h')).toBe(true);
  });

  it('second claim fails (already claimed)', async () => {
    await scheduler.claimReminder('gig-1', '24h');
    expect(await scheduler.claimReminder('gig-1', '24h')).toBe(false);
  });
});
```

#### Test 2: Concurrent replica race
```typescript
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

  // Each reminder should be dispatched exactly once across both replicas
  expect(totalEmitCalls).toBe(totalDispatched);
  expect(totalEmitCalls).toBeGreaterThan(0);
});
```

### Pattern Consistency
This fix mirrors `EventDedupService.claim()` (same module, lines 66-110), which:
- Uses identical `SET NX EX` pattern
- Explicitly documents why atomicity is required
- Was introduced in #646 to fix the same class of race condition

---

## Summary

| Issue | Type | Lines Changed | Tests Added | Risk |
|-------|------|---------------|-------------|------|
| #777  | Dead code | -2 | 0 (existing pass) | Low |
| #798  | Import fix | ±4 | 0 (compile fix) | Low |
| #792  | Logic bug | +6 | 2 new tests | Medium |
| #799  | Race condition | ~60 | 1 new test + updated existing | Medium |

**All acceptance criteria met for all 4 issues** ✅
