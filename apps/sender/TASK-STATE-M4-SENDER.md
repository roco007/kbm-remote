

## Milestone 4 completion state (updated Aug 13)

All 8 screens implemented and wired; App.tsx navigator mounted with hydration.
Verification status: typecheck clean, lint clean (src), full monorepo tests green
(12 tasks, 17 sender tests incl. new tests/inputDispatch.test.ts with 9 frame
emission tests using vi.doMock of connectionStore).

### Files completed this session
- src/screens/KeyboardScreen.tsx (QWERTY grid, hidden TextInput batcher, shift/caps)
- src/screens/MediaControlsScreen.tsx (transport row + volume column)
- src/screens/ClipboardScreen.tsx (remote snapshot, push composer, history)
- src/screens/PresentationModeScreen.tsx (slide arrows + expo-keep-awake)
- src/screens/index.ts (registry, replaced placeholder)
- src/App.tsx (NavigationContainer + Native Stack + store hydration)
- tests/inputDispatch.test.ts (moved from src/__tests__ to tests/; uses
  await import("../src/services/inputDispatch.js") because tsconfig base uses
  NodeNext moduleResolution — dynamic imports need .js extensions)
- src/services/inputDispatch.ts (fixed: connection() now uses mgr.connectionRef.connectionState;
  send uses c.send({t,ts,p}) since mid/v injected by ClientConnection)

### Key type facts (learned during fixes)
- ClientState = "idle"|"connecting"|"connected"|"authenticated"|"reconnecting"|"disconnected"
  (NO "authenticating" or "failed")
- M3Tokens in apps/sender/src/theme.ts uses own field names (bgApp/textPrimary/…/onSurface/…)
  spreading lightTheme/darkTheme values from @kbm-remote/ui-components.
- ui-components package.json main/types point to dist/src/index.{js,d.ts}.
- ThemeState.store: mode/setMode selectors must use hooks, not bare store.
- ConnectionManager: get state() → this.connection.connectionState; get connectionRef().
- FrameEnvelope = {t,mid,v,ts,p,c?}; ClientConnection.send takes Omit<FrameEnvelope,"mid"|"v">.

### Remaining work for delivery
- Run pnpm lint tests (test dir lint) — 1 var-requires error in tests/connectionManager.test.ts
  line 27 (require("ws")) — may need eslint-disable or fix; then final verification.
- Write Milestone 4 documentation (docs/MILESTONE-4.md) + update TASK-STATE file.
- Commit/push to GitHub if requested (repo github.com/roco007/kbm-remote, remote name check needed).
- Deliver summary to user.
