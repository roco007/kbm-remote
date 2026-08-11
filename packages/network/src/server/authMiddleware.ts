/**
 * Authentication middleware — verifies presented session tokens against the
 * receiver's stored hashes before any operational frame is accepted
 * (Protocol Spec §5.3).
 *
 * The middleware is deliberately storage-agnostic: the app layer supplies an
 * `AuthStore` that knows how to hash, compare and revoke tokens. The network
 * layer never touches plaintext tokens or pairing secrets.
 */

import type { HandlerResult } from "./gatewayTypes";

export interface AuthStore {
  /**
   * Verify a presented token for a session. Returns the granted permissions
   * when the hash matches, or null when the token is unknown/expired/revoked.
   */
  verifyToken(sessionId: string, token: string): Promise<string[] | null>;

  /**
   * Record a freshly issued session (post pairing approval). The caller
   * passes the raw token exactly once; the store MUST store only its hash
   * and discard the plaintext.
   */
  storeSession(sessionId: string, token: string, permissions: string[]): Promise<void>;

  /** Revoke a session — next Authenticate for it must fail. */
  revokeSession(sessionId: string): Promise<void>;

  /** True when pairing attempts are currently rate-limited for this sender. */
  isRateLimited(senderKey: string): Promise<boolean>;

  /** Record a pairing attempt for rate limiting (5/hour per Spec §5.3). */
  recordPairingAttempt(senderKey: string): Promise<void>;
}

export interface AuthDependencies {
  store: AuthStore;
  /** Milliseconds after `Hello` within which auth must complete (§3.5). */
  authWindowMs?: number;
}

export interface AuthDecision {
  /** True once AuthOk/PairApproved completed for this connection. */
  authenticated: boolean;
  /** Permissions granted for the session (empty until authenticated). */
  permissions: string[];
  /** Stable session identity echoed from HelloAck (§4.2). */
  sessionId: string;
}

export class AuthMiddleware {
  private readonly store: AuthStore;
  private readonly authWindowMs: number;

  constructor(deps: AuthDependencies) {
    this.store = deps.store;
    this.authWindowMs = deps.authWindowMs ?? 30_000;
  }

  /** True if the authentication window has elapsed without completing auth. */
  isAuthWindowExpired(openedAt: number): boolean {
    return Date.now() - openedAt > this.authWindowMs;
  }

  /**
   * Verify an `Authenticate` payload. Returns grant details on success or a
   * rejection reason the gateway maps to AuthFailed + close 4001/4003.
   */
  async verifyAuthenticate(
    sessionId: string,
    token: string,
  ): Promise<
    { ok: true; permissions: string[] } | { ok: false; reason: "invalid" | "revoked" }
  > {
    const permissions = await this.store.verifyToken(sessionId, token);
    if (permissions === null) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, permissions };
  }

  /** Handler-level refusal: invalid credentials close with 4001. */
  static authFailed(): HandlerResult {
    return { ok: false, reason: "notAuthenticated" };
  }
}
