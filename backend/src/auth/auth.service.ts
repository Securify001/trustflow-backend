import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getJwtVerificationSecrets } from '../config/env.config';
import { NonceStoreService } from './nonce-store.service';
import { JWT_ALGORITHM } from '../config/env.config';
import { RefreshTokenStoreService, ACCESS_TOKEN_TTL_SECONDS } from './refresh-token-store.service';

const CHALLENGE_PREFIX = 'Sign this message to authenticate with TrustFlow: ';

@Injectable()
export class AuthService {
  private readonly logger = new SanitizedLogger(AuthService.name);

  constructor(
    private jwtService: JwtService,
    private nonceStore: NonceStoreService,
    private refreshTokenStore: RefreshTokenStoreService,
  ) {}

  async generateChallenge(address: string): Promise<string> {
    const nonce = crypto.randomBytes(32).toString('hex');
    const challenge = `${CHALLENGE_PREFIX}${nonce}`;

    // The store hands back an already-pending challenge rather than replacing it (#369).
    const active = (await this.nonceStore.store(address, challenge, nonce)) ?? challenge;
    this.logger.debug(`Challenge issued for ${this.maskAddress(address)}`);

    return active;
  }

  async verifySignature(address: string, signature: string): Promise<boolean> {
    const challenge = await this.nonceStore.consume(address);
    if (!challenge) {
      throw new UnauthorizedException('Challenge not found, expired, or already consumed');
    }

    const nonce = this.extractNonce(challenge);

    try {
      const signatureBuffer = Buffer.from(signature, 'base64');
      const challengeBuffer = Buffer.from(challenge, 'utf-8');

      const keypair = StellarSdk.Keypair.fromPublicKey(address);
      const isValid = keypair.verify(challengeBuffer, signatureBuffer);

      if (isValid && nonce) {
        const firstUse = await this.nonceStore.markNonceUsed(nonce);
        if (!firstUse) {
          this.logger.warn(`Replay attempt detected for ${this.maskAddress(address)}`);
          throw new UnauthorizedException('Challenge already used — replay blocked');
        }
        this.logger.debug(`Signature verified for ${this.maskAddress(address)}`);
      }

      return isValid;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.warn(
        `Signature verification failed for ${this.maskAddress(address)}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }
  }

  generateToken(address: string, ttlSeconds?: number): string {
    const payload = { address, sub: address };
    const options = ttlSeconds ? { expiresIn: ttlSeconds } : {};
    return this.jwtService.sign(payload, options);
  }

  async generateRefreshToken(address: string): Promise<string> {
    return this.refreshTokenStore.issueRefreshToken(address);
  }

  async refreshAccessToken(
    refreshToken: string,
    address: string,
  ): Promise<{ token: string; refreshToken: string } | null> {
    const result = await this.refreshTokenStore.validateAndRotateRefreshToken(
      refreshToken,
      address,
    );
    if (!result.valid || !result.newToken) {
      return null;
    }

    const newAccessToken = this.generateToken(address, ACCESS_TOKEN_TTL_SECONDS);
    return {
      token: newAccessToken,
      refreshToken: result.newToken,
    };
  }

  async revokeRefreshToken(address: string, token: string): Promise<void> {
    return this.refreshTokenStore.revokeRefreshToken(address, token);
  }

  validateToken(token: string): unknown {
    try {
      return this.jwtService.verify(token, { algorithms: [JWT_ALGORITHM] });
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }
  }

  private extractNonce(challenge: string): string | null {
    if (!challenge.startsWith(CHALLENGE_PREFIX)) return null;
    return challenge.slice(CHALLENGE_PREFIX.length);
  }

  private maskAddress(address: string): string {
    if (address.length <= 12) return '****';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
