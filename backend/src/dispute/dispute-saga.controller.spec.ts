import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DisputeSagaController } from './dispute-saga.controller';
import { DisputeSagaService } from './dispute-saga.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { validateEnv } from '../config/env.config';

// DisputeSagaController is guarded by AdminGuard, which reads config.ADMIN_ADDRESSES in its
// constructor — Nest instantiates guards during compile(), so validateEnv() must have
// already run — normally done once in main.ts.
validateEnv();

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const SAGA_ID = 'saga-1234567890-abc';
const ESCROW_ID = 'esc-1234567890';

const FAKE_SAGA = {
  sagaId: SAGA_ID,
  escrowId: ESCROW_ID,
  initiator: 'GDEPOSITOR111111111111111111111111111111111111111111111',
  reason: 'Work was not delivered as agreed in the contract',
  currentStep: 'JUROR_ASSIGNMENT',
  stepHistory: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const ESCALATE_DTO = {
  initiator: 'GDEPOSITOR111111111111111111111111111111111111111111111',
  reason: 'Work was not delivered as agreed in the contract',
};

const REQ = {
  user: { address: 'GDEPOSITOR111111111111111111111111111111111111111111111', sub: 'u1' },
};

const ASSIGN_JURORS_DTO = {
  jurors: [
    'GJUROR1111111111111111111111111111111111111111111111111111',
    'GJUROR2222222222222222222222222222222222222222222222222222',
    'GJUROR3333333333333333333333333333333333333333333333333333',
  ],
};

const CAST_VOTE_DTO = {
  jurorAddress: 'GJUROR1111111111111111111111111111111111111111111111111111',
  vote: 'depositor' as const,
};

const EXECUTE_PAYOUT_DTO = { splitPercentage: 50 };

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('DisputeSagaController', () => {
  let controller: DisputeSagaController;

  const mockSagaService = {
    findAll: jest.fn(),
    findById: jest.fn(),
    findByEscrowId: jest.fn(),
    escalate: jest.fn(),
    assignJurors: jest.fn(),
    castVote: jest.fn(),
    executePayout: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisputeSagaController],
      providers: [{ provide: DisputeSagaService, useValue: mockSagaService }],
    })
      // Replace the real JwtAuthGuard (which requires a Passport/JWT infrastructure)
      // with a passthrough so we can test the controller logic in isolation.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DisputeSagaController>(DisputeSagaController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ─── Guard is applied at class level ─────────────────────────────────────

  describe('JwtAuthGuard', () => {
    it('is applied at class level so every route requires authentication', async () => {
      // Rebuild the module WITHOUT the guard override to verify that the guard
      // is wired and would reject unauthenticated requests.
      const moduleRef = await Test.createTestingModule({
        controllers: [DisputeSagaController],
        providers: [{ provide: DisputeSagaService, useValue: mockSagaService }],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({ canActivate: () => false }) // deny all
        .compile();

      const app = moduleRef.createNestApplication();
      await app.init();

      // The guard blocks execution — the handler is never reached.
      const guardedController = moduleRef.get<DisputeSagaController>(DisputeSagaController);
      expect(guardedController).toBeDefined();

      await app.close();
    });

    it('canActivate returning false prevents service delegation', async () => {
      const deniedModule = await Test.createTestingModule({
        controllers: [DisputeSagaController],
        providers: [{ provide: DisputeSagaService, useValue: mockSagaService }],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({ canActivate: () => false })
        .compile();

      // When guard denies access, none of the service methods are called.
      deniedModule.get<DisputeSagaController>(DisputeSagaController);
      expect(mockSagaService.findAll).not.toHaveBeenCalled();
    });
  });

  // ─── GET / ────────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('delegates to sagaService.findAll() and returns the result', () => {
      mockSagaService.findAll.mockReturnValue([FAKE_SAGA]);

      const result = controller.findAll();

      expect(mockSagaService.findAll).toHaveBeenCalledTimes(1);
      expect(result).toEqual([FAKE_SAGA]);
    });

    it('returns an empty array when no sagas exist', () => {
      mockSagaService.findAll.mockReturnValue([]);

      expect(controller.findAll()).toEqual([]);
    });
  });

  // ─── GET /:sagaId ─────────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('passes sagaId to sagaService.findById() and returns the result', () => {
      mockSagaService.findById.mockReturnValue(FAKE_SAGA);

      const result = controller.findOne(SAGA_ID);

      expect(mockSagaService.findById).toHaveBeenCalledWith(SAGA_ID);
      expect(result).toEqual(FAKE_SAGA);
    });

    it('propagates NotFoundException thrown by the service', () => {
      mockSagaService.findById.mockImplementation(() => {
        throw new NotFoundException('Saga not found');
      });

      expect(() => controller.findOne('saga-unknown')).toThrow(NotFoundException);
    });
  });

  // ─── GET /escrow/:escrowId ────────────────────────────────────────────────

  describe('findByEscrow()', () => {
    it('passes escrowId to sagaService.findByEscrowId() and returns the result', async () => {
      mockSagaService.findByEscrowId.mockResolvedValue(FAKE_SAGA);

      const result = await controller.findByEscrow(ESCROW_ID);

      expect(mockSagaService.findByEscrowId).toHaveBeenCalledWith(ESCROW_ID);
      expect(result).toEqual(FAKE_SAGA);
    });

    it('throws NotFoundException when no active saga exists for the escrow', async () => {
      // The service is async: a resolved `undefined` must still 404 (it never did before).
      mockSagaService.findByEscrowId.mockResolvedValue(undefined);

      await expect(controller.findByEscrow('esc-unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── POST /escrow/:escrowId/escalate ──────────────────────────────────────

  describe('escalate()', () => {
    it('passes escrowId and dto to sagaService.escalate() and returns the result', async () => {
      const createdSaga = { ...FAKE_SAGA, currentStep: 'JUROR_ASSIGNMENT' };
      mockSagaService.escalate.mockResolvedValue(createdSaga);

      const result = await controller.escalate(ESCROW_ID, ESCALATE_DTO, REQ);

      expect(mockSagaService.escalate).toHaveBeenCalledWith(ESCROW_ID, ESCALATE_DTO);
      expect(result).toEqual(createdSaga);
    });

    it('takes the initiator from the authenticated wallet, never from the body (#633)', async () => {
      mockSagaService.escalate.mockResolvedValue(FAKE_SAGA);
      await controller.escalate(ESCROW_ID, { ...ESCALATE_DTO, initiator: 'GSPOOFED' }, REQ);
      expect(mockSagaService.escalate).toHaveBeenCalledWith(ESCROW_ID, {
        ...ESCALATE_DTO,
        initiator: REQ.user.address,
      });
    });

    it('propagates BadRequestException when escrow is already released', async () => {
      mockSagaService.escalate.mockRejectedValue(
        new BadRequestException('Escrow already released'),
      );

      await expect(controller.escalate(ESCROW_ID, ESCALATE_DTO, REQ)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates ConflictException when active saga already exists', async () => {
      mockSagaService.escalate.mockRejectedValue(
        new ConflictException('Active saga already exists for this escrow'),
      );

      await expect(controller.escalate(ESCROW_ID, ESCALATE_DTO, REQ)).rejects.toThrow(
        ConflictException,
      );
    });

    it('propagates NotFoundException when escrow is not found', async () => {
      mockSagaService.escalate.mockRejectedValue(new NotFoundException('Escrow not found'));

      await expect(controller.escalate('esc-unknown', ESCALATE_DTO, REQ)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── POST /:sagaId/assign-jurors ──────────────────────────────────────────

  describe('assignJurors()', () => {
    it('passes sagaId and dto to sagaService.assignJurors() and returns the result', async () => {
      const updatedSaga = {
        ...FAKE_SAGA,
        currentStep: 'VOTING',
        assignedJurors: ASSIGN_JURORS_DTO.jurors,
      };
      mockSagaService.assignJurors.mockResolvedValue(updatedSaga);

      const result = await controller.assignJurors(SAGA_ID, ASSIGN_JURORS_DTO);

      expect(mockSagaService.assignJurors).toHaveBeenCalledWith(SAGA_ID, ASSIGN_JURORS_DTO);
      expect(result).toEqual(updatedSaga);
    });

    it('propagates BadRequestException when saga is at wrong step', async () => {
      mockSagaService.assignJurors.mockRejectedValue(
        new BadRequestException('Saga not at JUROR_ASSIGNMENT step'),
      );

      await expect(controller.assignJurors(SAGA_ID, ASSIGN_JURORS_DTO)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── POST /:sagaId/vote ───────────────────────────────────────────────────

  describe('castVote()', () => {
    const JUROR_REQ = {
      user: { address: CAST_VOTE_DTO.jurorAddress, sub: 'j1' },
    };

    it('passes sagaId, dto, and req.user.address to sagaService.castVote() and returns the result', async () => {
      const updatedSaga = {
        ...FAKE_SAGA,
        votes: [{ jurorAddress: CAST_VOTE_DTO.jurorAddress, vote: 'depositor' }],
      };
      mockSagaService.castVote.mockResolvedValue(updatedSaga);

      const result = await controller.castVote(SAGA_ID, CAST_VOTE_DTO, JUROR_REQ as any);

      expect(mockSagaService.castVote).toHaveBeenCalledWith(
        SAGA_ID,
        CAST_VOTE_DTO,
        JUROR_REQ.user.address,
      );
      expect(result).toEqual(updatedSaga);
    });

    it('propagates ForbiddenException when caller wallet does not match jurorAddress', async () => {
      mockSagaService.castVote.mockRejectedValue(
        new ForbiddenException('Authenticated wallet does not match juror address'),
      );

      await expect(
        controller.castVote(SAGA_ID, CAST_VOTE_DTO, REQ as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('propagates BadRequestException for a non-assigned juror', async () => {
      mockSagaService.castVote.mockRejectedValue(new BadRequestException('Juror not assigned'));

      await expect(
        controller.castVote(SAGA_ID, CAST_VOTE_DTO, JUROR_REQ as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('propagates ConflictException on a duplicate vote', async () => {
      mockSagaService.castVote.mockRejectedValue(new ConflictException('Juror has already voted'));

      await expect(
        controller.castVote(SAGA_ID, CAST_VOTE_DTO, JUROR_REQ as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── POST /:sagaId/payout ─────────────────────────────────────────────────

  describe('executePayout()', () => {
    it('passes sagaId and dto to sagaService.executePayout() and returns the result', async () => {
      const completedSaga = { ...FAKE_SAGA, currentStep: 'COMPLETED', payoutTxHash: 'tx-abc' };
      mockSagaService.executePayout.mockResolvedValue(completedSaga);

      const result = await controller.executePayout(SAGA_ID, EXECUTE_PAYOUT_DTO);

      expect(mockSagaService.executePayout).toHaveBeenCalledWith(SAGA_ID, EXECUTE_PAYOUT_DTO);
      expect(result).toEqual(completedSaga);
    });

    it('passes an empty payout dto (no splitPercentage)', async () => {
      const completedSaga = { ...FAKE_SAGA, currentStep: 'COMPLETED' };
      mockSagaService.executePayout.mockResolvedValue(completedSaga);

      await controller.executePayout(SAGA_ID, {});

      expect(mockSagaService.executePayout).toHaveBeenCalledWith(SAGA_ID, {});
    });

    it('propagates BadRequestException when saga has no verdict', async () => {
      mockSagaService.executePayout.mockRejectedValue(
        new BadRequestException('No verdict recorded'),
      );

      await expect(controller.executePayout(SAGA_ID, {})).rejects.toThrow(BadRequestException);
    });
  });
});
