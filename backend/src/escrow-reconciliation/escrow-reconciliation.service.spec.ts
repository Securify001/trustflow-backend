import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { EscrowService, Escrow } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { EscrowChainStateClient } from './escrow-chain-state.client';
import { EscrowReconciliationStateStore } from './escrow-reconciliation-state.store';
import { InvalidChainStateError } from './chain-escrow.validation';
import { ChainEscrowRecord, DriftType, RECONCILIATION_EVENTS } from './escrow-reconciliation.types';
import { resetEnvConfig, setTestEnv, validateEnv } from '../config/env.config';

// reconcile() reads config.ESCROW_RECONCILIATION_SWEEP_CONCURRENCY, which requires
// validateEnv() to have run first — normally done once in main.ts.
validateEnv();

function makeEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: 'esc-1',
    depositor: `G${'A'.repeat(55)}`,
    beneficiary: `G${'B'.repeat(55)}`,
    amountXLM: '100',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    contractEscrowId: 'chain-esc-1',
    ...overrides,
  };
}

function makeChainRecord(overrides: Partial<ChainEscrowRecord> = {}): ChainEscrowRecord {
  return {
    contractEscrowId: 'chain-esc-1',
    depositor: `G${'A'.repeat(55)}`,
    beneficiary: `G${'B'.repeat(55)}`,
    amountXLM: '100',
    status: 'active',
    ...overrides,
  };
}

describe('EscrowReconciliationService', () => {
  const originalConcurrency = process.env.ESCROW_RECONCILIATION_SWEEP_CONCURRENCY;
  let escrowService: jest.Mocked<
    Pick<
      EscrowService,
      'findAll' | 'applyChainState' | 'createFromChainState' | 'findByContractEscrowId'
    >
  >;
  let chainClient: jest.Mocked<EscrowChainStateClient>;
  let webhookService: jest.Mocked<Pick<WebhookService, 'dispatch'>>;
  let store: EscrowReconciliationStateStore;
  let service: EscrowReconciliationService;

  beforeEach(() => {
    escrowService = {
      findAll: jest.fn().mockResolvedValue([]),
      applyChainState: jest.fn(),
      createFromChainState: jest.fn(),
      findByContractEscrowId: jest.fn(),
    };
    chainClient = { getEscrow: jest.fn() };
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    store = new EscrowReconciliationStateStore();

    service = new EscrowReconciliationService(
      escrowService as unknown as EscrowService,
      chainClient,
      webhookService as unknown as WebhookService,
      store,
    );
  });

  afterEach(() => {
    if (originalConcurrency === undefined) {
      delete process.env.ESCROW_RECONCILIATION_SWEEP_CONCURRENCY;
    } else {
      process.env.ESCROW_RECONCILIATION_SWEEP_CONCURRENCY = originalConcurrency;
    }
    // Re-validate so a per-test override (via setTestEnv) doesn't leak into the next test.
    resetEnvConfig();
    validateEnv();
  });

  describe('no drift', () => {
    it('reports zero drift when DB and chain agree, and skips the webhook', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow()]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord());

      const run = await service.reconcile();

      expect(run.checked).toBe(1);
      expect(run.driftCount).toBe(0);
      expect(run.drifts).toEqual([]);
      expect(escrowService.applyChainState).not.toHaveBeenCalled();
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });

    it('ignores DB escrows that are not yet linked to a contract id', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow({ contractEscrowId: undefined })]);

      const run = await service.reconcile();

      expect(run.checked).toBe(0);
      expect(chainClient.getEscrow).not.toHaveBeenCalled();
    });
  });

  describe('status mismatch', () => {
    it('detects and repairs a status drift by trusting chain state', async () => {
      const escrow = makeEscrow({ status: 'active' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord({ status: 'released' }));
      escrowService.applyChainState.mockResolvedValue({ ...escrow, status: 'released' });

      const run = await service.reconcile();

      expect(run.driftCount).toBe(1);
      expect(run.repairedCount).toBe(1);
      expect(run.drifts[0]).toMatchObject({
        driftType: DriftType.STATUS_MISMATCH,
        contractEscrowId: 'chain-esc-1',
        repaired: true,
      });
      expect(escrowService.applyChainState).toHaveBeenCalledWith(
        escrow.id,
        {
          status: 'released',
          amountXLM: '100',
        },
        escrow.version, // expected version for optimistic locking
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        RECONCILIATION_EVENTS.DRIFT_DETECTED,
        expect.objectContaining({ driftCount: 1 }),
      );
    });
  });

  describe('amount mismatch', () => {
    it('detects and repairs an amount drift', async () => {
      const escrow = makeEscrow({ amountXLM: '100' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord({ amountXLM: '250' }));
      escrowService.applyChainState.mockResolvedValue({ ...escrow, amountXLM: '250' });

      const run = await service.reconcile();

      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({ driftType: DriftType.AMOUNT_MISMATCH, repaired: true });
    });
  });

  describe('status and amount both drift', () => {
    it('records both field drifts but repairs them with a single write', async () => {
      const escrow = makeEscrow({ status: 'active', amountXLM: '100' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(
        makeChainRecord({ status: 'disputed', amountXLM: '300' }),
      );
      escrowService.applyChainState.mockResolvedValue({
        ...escrow,
        status: 'disputed',
        amountXLM: '300',
      });

      const run = await service.reconcile();

      expect(run.drifts.map(d => d.driftType).sort()).toEqual(
        [DriftType.STATUS_MISMATCH, DriftType.AMOUNT_MISMATCH].sort(),
      );
      expect(run.drifts.every(d => d.repaired)).toBe(true);
      expect(escrowService.applyChainState).toHaveBeenCalledTimes(1);
    });
  });

  describe('missing on chain', () => {
    it('flags the drift but does not attempt to repair it automatically', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow()]);
      chainClient.getEscrow.mockResolvedValue(undefined);

      const run = await service.reconcile();

      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({
        driftType: DriftType.MISSING_ON_CHAIN,
        repaired: false,
      });
      expect(escrowService.applyChainState).not.toHaveBeenCalled();
    });
  });

  describe('missing in DB', () => {
    it('backfills a DB row for a candidate contract id found on chain but untracked', async () => {
      const chainOnly = makeChainRecord({
        contractEscrowId: 'chain-esc-orphan',
        status: 'pending',
      });
      chainClient.getEscrow.mockResolvedValue(chainOnly);
      escrowService.createFromChainState.mockResolvedValue(
        makeEscrow({ id: 'esc-new', contractEscrowId: 'chain-esc-orphan', status: 'pending' }),
      );

      const run = await service.reconcile(['chain-esc-orphan']);

      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({ driftType: DriftType.MISSING_IN_DB, repaired: true });
      expect(escrowService.createFromChainState).toHaveBeenCalledWith(chainOnly);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        RECONCILIATION_EVENTS.ESCROW_BACKFILLED,
        expect.objectContaining({ contractEscrowId: 'chain-esc-orphan' }),
      );
    });

    it('skips candidate ids already linked to a DB row', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow({ contractEscrowId: 'chain-esc-1' })]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord());

      const run = await service.reconcile(['chain-esc-1']);

      // only the one DB-linked check happens; the candidate id is not re-fetched a second time
      expect(chainClient.getEscrow).toHaveBeenCalledTimes(1);
      expect(run.checked).toBe(1);
    });

    it('does nothing when a candidate id exists on neither side', async () => {
      chainClient.getEscrow.mockResolvedValue(undefined);

      const run = await service.reconcile(['chain-esc-nowhere']);

      expect(run.drifts).toEqual([]);
      expect(escrowService.createFromChainState).not.toHaveBeenCalled();
    });
  });

  describe('repair failure', () => {
    it('records the repair error without throwing, and still returns the run', async () => {
      const escrow = makeEscrow({ status: 'active' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord({ status: 'released' }));
      escrowService.applyChainState.mockRejectedValue(new Error('write conflict'));

      const run = await service.reconcile();

      expect(run.drifts[0]).toMatchObject({ repaired: false, repairError: 'write conflict' });
      expect(run.repairedCount).toBe(0);
    });
  });

  describe('chain read failures', () => {
    it('records a failed read, continues checking other escrows, saves the run, and dispatches the webhook', async () => {
      const secondEscrow = makeEscrow({ id: 'esc-2', contractEscrowId: 'chain-esc-2' });
      escrowService.findAll.mockResolvedValue([makeEscrow(), secondEscrow]);
      chainClient.getEscrow.mockImplementation(async contractEscrowId => {
        if (contractEscrowId === 'chain-esc-1') throw new Error('RPC timeout');
        return makeChainRecord({ contractEscrowId });
      });

      const run = await service.reconcile();

      expect(run.checked).toBe(2);
      expect(run.errorCount).toBe(1);
      expect(run.errors[0]).toMatchObject({
        contractEscrowId: 'chain-esc-1',
        message: 'RPC timeout',
      });
      expect(run.drifts).toEqual([]);
      expect(await service.findById(run.runId)).toEqual(run);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        RECONCILIATION_EVENTS.DRIFT_DETECTED,
        expect.objectContaining({ errorCount: 1 }),
      );
    });

    it('bounds chain reads using the configured concurrency', async () => {
      setTestEnv({ ESCROW_RECONCILIATION_SWEEP_CONCURRENCY: '2' });
      const escrows = Array.from({ length: 6 }, (_, index) =>
        makeEscrow({ id: `esc-${index}`, contractEscrowId: `chain-esc-${index}` }),
      );
      escrowService.findAll.mockResolvedValue(escrows);
      let active = 0;
      let maximumActive = 0;
      chainClient.getEscrow.mockImplementation(async contractEscrowId => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return makeChainRecord({ contractEscrowId });
      });

      const run = await service.reconcile();

      expect(run.errorCount).toBe(0);
      expect(maximumActive).toBeLessThanOrEqual(2);
      expect(chainClient.getEscrow).toHaveBeenCalledTimes(6);
    });
  });

  describe('run history', () => {
    it('persists runs and returns them via findById/findAll', async () => {
      escrowService.findAll.mockResolvedValue([]);

      const run = await service.reconcile();

      expect(await service.findById(run.runId)).toEqual(run);
      expect(await service.findAll()).toEqual([run]);
    });
  });

  describe('invalid chain data', () => {
    it('records an unrepaired error against that escrow and never writes to the DB', async () => {
      escrowService.findAll.mockResolvedValue([
        makeEscrow(),
        makeEscrow({ id: 'esc-2', contractEscrowId: 'chain-esc-2' }),
      ]);
      chainClient.getEscrow
        .mockRejectedValueOnce(new InvalidChainStateError('chain-esc-1', 'unrecognised status'))
        .mockResolvedValueOnce(makeChainRecord({ contractEscrowId: 'chain-esc-2' }));

      const run = await service.reconcile();

      expect(escrowService.applyChainState).not.toHaveBeenCalled();
      expect(run.checked).toBe(2);
      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({
        contractEscrowId: 'chain-esc-1',
        driftType: DriftType.INVALID_CHAIN_DATA,
        repaired: false,
      });
      expect(run.drifts[0].repairError).toContain('unrecognised status');
    });

    it('records an unexpected read error against that escrow instead of aborting the run', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow()]);
      chainClient.getEscrow.mockRejectedValue(new Error('network'));

      const run = await service.reconcile();

      // A single bad read must not discard drift detection for every other escrow, so the
      // failure is captured on the run record instead of thrown out of reconcile().
      expect(run.errorCount).toBe(1);
      expect(run.errors[0]).toMatchObject({
        contractEscrowId: 'chain-esc-1',
        message: 'network',
      });
      expect(run.checked).toBe(1);
    });
  });

  describe('concurrent modification protection', () => {
    it('passes expected version to applyChainState for optimistic locking', async () => {
      const escrow = makeEscrow({ status: 'active', amountXLM: '1000', version: 5 });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(
        makeChainRecord({ status: 'released', amountXLM: '800' }),
      );
      escrowService.applyChainState.mockResolvedValue({ ...escrow, version: 6 });

      const run = await service.reconcile();

      expect(run.driftCount).toBe(2); // status + amount
      expect(escrowService.applyChainState).toHaveBeenCalledWith(
        'esc-1',
        { status: 'released', amountXLM: '800' },
        5, // expected version captured at read time
      );
    });

    it('records repair failure when concurrent update causes version conflict', async () => {
      const escrow = makeEscrow({ status: 'active', amountXLM: '1000', version: 5 });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(
        makeChainRecord({ status: 'released', amountXLM: '800' }),
      );

      // Simulate another process updating the escrow between detection and repair
      const conflictError = new Error(
        'Escrow version mismatch: expected 5, found 6. The escrow was modified concurrently'
      );
      conflictError.name = 'ConflictException';
      escrowService.applyChainState.mockRejectedValue(conflictError);

      const run = await service.reconcile();

      expect(run.driftCount).toBe(2);
      expect(run.repairedCount).toBe(0);
      expect(run.drifts[0].repaired).toBe(false);
      expect(run.drifts[0].repairError).toContain('version mismatch');
      expect(run.drifts[1].repaired).toBe(false);
      expect(run.drifts[1].repairError).toContain('version mismatch');
    });

    it('prevents double-deduction when reconciliation races with milestone release', async () => {
      // Scenario: Reconciler reads escrow (1000 XLM, version 3), then a milestone release
      // deducts 200 XLM and increments version to 4, then reconciler tries to apply
      // stale chain state (800 XLM) with expectedVersion=3 → should fail
      const escrowBeforeRelease = makeEscrow({
        status: 'active',
        amountXLM: '1000',
        version: 3,
      });
      
      escrowService.findAll.mockResolvedValue([escrowBeforeRelease]);
      
      // Chain read happens during release, sees intermediate state
      chainClient.getEscrow.mockResolvedValue(makeChainRecord({ amountXLM: '800' }));
      
      // By the time reconciler tries to write, release has completed and version is 4
      const conflictError = new Error('Escrow version mismatch: expected 3, found 4');
      conflictError.name = 'ConflictException';
      escrowService.applyChainState.mockRejectedValue(conflictError);

      const run = await service.reconcile();

      // Drift was detected but repair failed due to version conflict
      expect(run.driftCount).toBe(1);
      expect(run.repairedCount).toBe(0);
      expect(run.drifts[0]).toMatchObject({
        driftType: DriftType.AMOUNT_MISMATCH,
        repaired: false,
      });
      expect(run.drifts[0].repairError).toContain('version mismatch');
      
      // Critical: The stale 800 XLM was NOT written, preventing double-deduction
      expect(escrowService.applyChainState).toHaveBeenCalledWith(
        escrowBeforeRelease.id,
        expect.objectContaining({ amountXLM: '800' }),
        3, // stale version
      );
    });
  });
});
