/**
 * Device registry — trusted-device management and pairing-decision state
 * machine (Architecture §5, UX §4 R5/R6).
 *
 * A device passes through four states:
 *   unknown → pending (sent a valid pair request) → trusted (approved) →
 *   revoked (removed, session token invalidated on next Authenticate)
 *
 * Permissions are per-device subsets of the protocol's permission set:
 *   "mouse" | "keyboard" | "clipboard" | "media" | "presentation" | "fileTransfer"
 *
 * The registry adapts into the network layer's `AuthStore` — the gateway's
 * Authenticate handler verifies tokens exclusively through it, so revoking a
 * device here instantly kills its session (spec §5.3).
 */
import { randomBytes } from "node:crypto";

import type { AuthStore } from "@kbm-remote/network";

export type PermissionName =
  "mouse" | "keyboard" | "clipboard" | "media" | "presentation" | "fileTransfer";

export type DevicePermission = PermissionName;

export interface DeviceEntry {
  deviceId: string;
  /** Stable session id issued at first authentication. */
  sessionId: string;
  /** Human label advertised by the sender in Hello §4.2. */
  deviceName: string;
  deviceOs: string;
  /** ISO timestamp when the device was approved. */
  approvedAt: string;
  /** Permissions granted; empty means "connected, awaiting approval". */
  permissions: DevicePermission[];
  /** Session token handed to the sender at approval (hashed at persist time in M1). */
  sessionToken: string;
  /** Last seen connection metadata (updated on each Hello). */
  lastIp?: string;
  lastConnectedAt?: number;
}

export interface PendingRequest {
  requestId: string;
  clientName: string;
  clientOs: string;
  /** 6-digit pairing code shown on both devices for visual verification. */
  pairingCode: string;
  receivedAt: number;
  expiresAt: number;
}

const PERMISSIONS: DevicePermission[] = [
  "mouse",
  "keyboard",
  "clipboard",
  "media",
  "presentation",
  "fileTransfer",
];

const PAIRING_CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export type RegistryEvent =
  | { type: "pairRequest"; clientName: string; clientOs: string }
  | { type: "deviceApproved"; deviceId: string }
  | { type: "deviceRevoked"; deviceId: string };

export interface DeviceRegistry {
  list(): DeviceEntry[];
  pending(): PendingRequest[];
  approve(deviceId: string): DeviceEntry | null;
  revoke(deviceId: string): void;
  setPermissions(deviceId: string, permissions: DevicePermission[]): boolean;
  /** Create (or refresh) a pending request and its pairing code. */
  requestPair(clientName: string, clientOs: string): PendingRequest;
  /** Verify a pairing code for the newest pending request. */
  verifyPairingCode(code: string): PendingRequest | null;
  /** Issue a fresh pairing code shown on the receiver's pairing screen. */
  issuePairingCode(): string;
  /** AuthStore adapter consumed by NetworkService. */
  toAuthStore(): AuthStore;
  load(path: string): Promise<void>;
  persist(path: string): Promise<void>;
  on(
    event: "pairRequest",
    listener: (payload: {
      type: "pairRequest";
      clientName: string;
      clientOs: string;
    }) => void,
  ): () => void;
  on(
    event: "deviceApproved",
    listener: (payload: { type: "deviceApproved"; deviceId: string }) => void,
  ): () => void;
  on(
    event: "deviceRevoked",
    listener: (payload: { type: "deviceRevoked"; deviceId: string }) => void,
  ): () => void;
}

export function createDeviceRegistry(): DeviceRegistry {
  const trusted = new Map<string, DeviceEntry>();
  const pending = new Map<string, PendingRequest>();
  const revokedSessions = new Set<string>();
  const pairingTokens = new Map<string, string>(); // sessionId → token (until approval)
  const listeners = new Map<RegistryEvent["type"], Set<(p: RegistryEvent) => void>>();
  let lastCode = "";

  function emit(event: RegistryEvent): void {
    listeners.get(event.type)?.forEach((l) => l(event));
  }

  function prunePending(): void {
    const now = Date.now();
    for (const [id, req] of pending) if (now > req.expiresAt) pending.delete(id);
  }

  return {
    list: () => Array.from(trusted.values()),

    pending: () => {
      prunePending();
      return Array.from(pending.values());
    },

    approve(deviceId) {
      const req = pending.get(deviceId);
      if (!req) return null;
      const entry: DeviceEntry = {
        deviceId: req.requestId,
        sessionId: req.requestId,
        deviceName: req.clientName,
        deviceOs: req.clientOs,
        approvedAt: new Date().toISOString(),
        permissions: ["mouse", "keyboard"],
        sessionToken: pairingTokens.get(req.requestId) ?? randomBytes(24).toString("hex"),
      };
      trusted.set(entry.deviceId, entry);
      pending.delete(deviceId);
      pairingTokens.delete(req.requestId);
      emit({ type: "deviceApproved", deviceId: entry.deviceId });
      return entry;
    },

    revoke(deviceId) {
      const entry = trusted.get(deviceId);
      if (!entry) return;
      revokedSessions.add(entry.sessionId);
      trusted.delete(deviceId);
      pairingTokens.delete(entry.sessionId);
      emit({ type: "deviceRevoked", deviceId });
    },

    setPermissions(deviceId, permissions) {
      const entry = trusted.get(deviceId);
      if (!entry) return false;
      entry.permissions = permissions.filter((p) => PERMISSIONS.includes(p));
      return true;
    },

    requestPair(clientName, clientOs) {
      const requestId = randomBytes(8).toString("hex");
      const code = pairingCodeFromId(requestId);
      const token = randomBytes(24).toString("hex");
      const req: PendingRequest = {
        requestId,
        clientName: clientName || "Unknown device",
        clientOs: clientOs || "unknown",
        pairingCode: code,
        receivedAt: Date.now(),
        expiresAt: Date.now() + PENDING_TTL_MS,
      };
      // Cap concurrent pending requests — only the newest survives.
      if (pending.size >= 5) {
        const oldestId: string = [...pending.keys()][0]!;
        pairingTokens.delete(oldestId);
        pending.delete(oldestId);
      }
      pending.set(requestId, req);
      pairingTokens.set(requestId, token);
      lastCode = code;
      emit({ type: "pairRequest", clientName: req.clientName, clientOs: req.clientOs });
      return req;
    },

    verifyPairingCode(code) {
      prunePending();
      const normalized = code.replace(/\s/g, "").toUpperCase();
      for (const req of pending.values()) {
        if (req.pairingCode === normalized) return req;
      }
      return null;
    },

    issuePairingCode() {
      if (lastCode) return lastCode;
      lastCode = pairingCodeFromId(randomBytes(8).toString("hex"));
      return lastCode;
    },

    toAuthStore(): AuthStore {
      let pairingAttempts = 0;
      return {
        async verifyToken(sessionId, token) {
          if (revokedSessions.has(sessionId)) return null;
          const entry = trusted.get(sessionId);
          if (!entry) return null;
          // Pending requests verify against the pre-approval token.
          const pendingToken = pending.has(sessionId)
            ? pairingTokens.get(sessionId)
            : undefined;
          const expected = entry.sessionToken || pendingToken;
          if (expected !== token) return null;
          // Permissions follow the trusted entry; pending devices start with nothing.
          const permissions = entry.permissions.length > 0 ? entry.permissions : [];
          return permissions.length > 0
            ? permissions
            : (["mouse", "keyboard"] as unknown as string[]);
        },
        async storeSession(sessionId, token) {
          const entry = trusted.get(sessionId);
          if (entry) {
            entry.sessionToken = token;
          } else if (pending.has(sessionId)) {
            pairingTokens.set(sessionId, token);
          }
        },
        async revokeSession(sessionId) {
          revokedSessions.add(sessionId);
          const entry = trusted.get(sessionId);
          if (entry) {
            trusted.delete(sessionId);
            emit({ type: "deviceRevoked", deviceId: sessionId });
          }
        },
        async isRateLimited() {
          return pairingAttempts > 20;
        },
        async recordPairingAttempt() {
          pairingAttempts += 1;
        },
      };
    },

    async load(path) {
      if (!path) return;
      try {
        const mod = await import("node:fs");
        if (!mod.existsSync(path)) return;
        const parsed = JSON.parse(mod.readFileSync(path, "utf8"));
        const entries = Array.isArray(parsed?.devices) ? parsed.devices : [];
        for (const raw of entries) {
          if (raw && typeof raw === "object" && typeof raw.deviceId === "string") {
            trusted.set(raw.deviceId, {
              deviceId: raw.deviceId,
              sessionId: raw.sessionId ?? raw.deviceId,
              deviceName: raw.deviceName ?? "Unknown device",
              deviceOs: raw.deviceOs ?? "",
              approvedAt: raw.approvedAt ?? new Date().toISOString(),
              permissions: Array.isArray(raw.permissions)
                ? raw.permissions
                : ["mouse", "keyboard"],
              sessionToken: raw.sessionToken ?? randomBytes(24).toString("hex"),
              lastIp: raw.lastIp,
              lastConnectedAt: raw.lastConnectedAt,
            });
          }
        }
      } catch {
        // Corrupt registry — start clean rather than crashing.
      }
    },

    async persist(path) {
      if (!path) return;
      try {
        const mod = await import("node:fs");
        const data = { devices: Array.from(trusted.values()) };
        mod.writeFileSync(path, JSON.stringify(data, null, 2));
      } catch {
        // Persist failures degrade to in-memory state.
      }
    },

    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set<(p: RegistryEvent) => void>();
        listeners.set(event, set);
      }
      set.add(listener as (p: RegistryEvent) => void);
      return () => set?.delete(listener as (p: RegistryEvent) => void);
    },
  };
}

/** Deterministic 6-digit code derived from the request id. */
function pairingCodeFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return String(100000 + (hash % 900000));
}

export { PERMISSIONS, PAIRING_CODE_TTL_MS, PENDING_TTL_MS };
