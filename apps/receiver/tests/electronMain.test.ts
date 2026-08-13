/**
 * Unit tests for the Electron receiver's main-process modules:
 * settings persistence, the device registry and the log buffer.
 *
 * These are deliberately synchronous/pure tests — the real Electron APIs
 * (app, BrowserWindow, ipcMain) are exercised only through the modules' own
 * exported helpers so the suite stays hermetic.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDeviceRegistry } from "../src/main/deviceRegistry";
import { createLogBuffer } from "../src/main/logBuffer";
import { createSettingsStore, DEFAULT_SETTINGS } from "../src/main/settingsStore";

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `kbm-${name}-`)), "state.json");
}

describe("settingsStore", () => {
  it("persists and reloads settings with merge semantics", () => {
    const path = tempPath("settings");
    const store1 = createSettingsStore(path, DEFAULT_SETTINGS);
    store1.apply((cur) => ({ ...cur, theme: "dark", port: 27002 }));

    const store2 = createSettingsStore(path, DEFAULT_SETTINGS);
    const next = store2.get();
    expect(next.theme).toBe("dark");
    expect(next.port).toBe(27002);
    expect(next.deviceId).toBe(DEFAULT_SETTINGS.deviceId);
    rmSync(path, { recursive: true, force: true });
  });

  it("applies is atomic — returns the same snapshot tsc typechecks", () => {
    const store = createSettingsStore("", DEFAULT_SETTINGS);
    const snapshot = store.get();
    expect(store.apply((cur) => ({ ...cur, autoStart: !cur.autoStart }))).not.toBe(
      snapshot,
    );
  });
});

describe("deviceRegistry", () => {
  it("issues and verifies pairing codes, caps pending queue", () => {
    const registry = createDeviceRegistry();

    for (let i = 0; i < 7; i++) {
      registry.requestPair(`sender-${i}`, i % 2 === 0 ? "android" : "ios");
    }
    // Queue capped at 5 — the oldest requests are dropped.
    expect(registry.pending().length).toBe(5);

    const code = registry.issuePairingCode();
    expect(code).toMatch(/^\d{6}$/);
    const verified = registry.verifyPairingCode(code);
    expect(verified).not.toBeNull();
    expect(registry.verifyPairingCode("000000")).toBeNull();
  });

  it("approves a pending request into the trusted list and emits events", () => {
    const registry = createDeviceRegistry();
    const events: string[] = [];
    registry.on("pairRequest", () => events.push("pairRequest"));
    registry.on("deviceApproved", (d) => events.push(`approved:${d.deviceId}`));

    registry.requestPair("my-phone", "android");
    const pending = registry.pending();
    const requestId = pending[0]!.requestId;
    const approved = registry.approve(requestId);
    expect(approved).not.toBeNull();
    expect(registry.list().length).toBe(1);
    expect(events).toEqual(["pairRequest", `approved:${requestId}`]);

    registry.setPermissions(requestId, ["mouse"]);
    expect(registry.list()[0]!.permissions).toEqual(["mouse"]);
    registry.revoke(requestId);
    expect(registry.list().length).toBe(0);
  });

  it("toAuthStore() verifies tokens for trusted devices", async () => {
    const registry = createDeviceRegistry();
    registry.requestPair("sender", "android");
    const pending = registry.pending();
    const requestId = pending[0]!.requestId;
    const approved = registry.approve(requestId)!;

    const authStore = registry.toAuthStore();
    expect(await authStore.verifyToken(approved.sessionId, "garbage")).toBeNull();
    expect(
      await authStore.verifyToken(approved.sessionId, approved.sessionToken),
    ).not.toBeNull();
  });
});

describe("logBuffer", () => {
  it("rings at capacity and tails newest-first", () => {
    const buffer = createLogBuffer(3);
    buffer.info("net", "one");
    buffer.warn("net", "two");
    buffer.error("auth", "three");
    buffer.info("auth", "four");

    const tail = buffer.tail(10);
    expect(tail.map((e) => e.message)).toEqual(["four", "three", "two"]);
    expect(buffer.all().length).toBe(3);
    buffer.clear();
    expect(buffer.all().length).toBe(0);
  });
});
