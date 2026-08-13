# Developer Guide — KBM Remote v1.0

This guide covers day-to-day development in the KBM Remote monorepo: the workspace layout,
the build system, how to extend each subsystem, debugging, testing conventions, and how
releases and installers are produced.

## 1. Workspace Layout

The repository is a **pnpm workspace** orchestrated by **Turborepo** with per-workspace
`tsconfig` project references. TypeScript is strict everywhere; ESLint (with
`@typescript-eslint`, `import`, and Prettier integration) and Prettier are enforced on every
commit through Husky and `lint-staged`.

| Path | Workspace | Runtime |
| --- | --- | --- |
| `apps/receiver` | `@kbm-remote/receiver` v1.0.0 | Electron 42 + NestJS 11 (main process), React renderer |
| `apps/sender` | `@kbm-remote/sender` v1.0.0 | Expo 53 / React Native 0.79 |
| `packages/protocol` | `@kbm-remote/protocol` | Pure TS — the shared wire contract |
| `packages/network` | `@kbm-remote/network` | Pure TS — WSS client and server |
| `packages/auth` | `@kbm-remote/auth` | Pure TS — pairing, sessions, RBAC |
| `packages/input-provider` | `@kbm-remote/input-provider` | Pure TS — input controllers + backends |
| `packages/ui-components` | `@kbm-remote/ui-components` | Pure TS — MD3 theme tokens |

Root scripts: `pnpm dev`, `build`, `test`, `lint`, `typecheck`, `format`, `format:check`,
`clean`.

## 2. Build System

Turborepo orders tasks by dependency: building `apps/receiver` first builds all `packages/*`
it consumes. Cache keys are derived from inputs declared in `turbo.json` (`src/**/*.ts`,
`tests/**/*.ts`, lockfile), so unaffected workspaces skip work entirely on CI.

```bash
pnpm install                      # one-time: hoists all workspaces
pnpm dev                          # watch mode for receiver + sender
pnpm build                        # production build of everything
pnpm test                         # all 222 unit tests (vitest in each workspace)
pnpm lint && pnpm typecheck       # CI gates
```

Tests use Vitest with `.ts` sources compiled on the fly; coverage outputs to
`coverage/` in each workspace and is consumed by CI.

## 3. Extending the Protocol

Adding a new frame type (e.g. `FileTransfer` already exists as reserved `0x80`):

1. Register the discriminator in `packages/protocol/src/types/index.ts` (`FrameType`).
   The table is frozen for v1.x — reserve IDs generously when adding categories.
2. Define the payload interface in a sibling module and re-export from the barrel.
3. Add a validation schema in `packages/protocol/src/validation` — **every payload must
   validate before reaching a controller**.
4. Extend the receiver's frame router (`packages/network/src/server/frameRouter.ts`) and
   the sender's dispatcher. Both sides must ship the change together; mismatched versions
   are surfaced as `UnsupportedVersion` and rejected cleanly.

## 4. Extending the Input Layer

Platform backends implement the controller interfaces in
`packages/input-provider/src/{mouse,keyboard,clipboard}.ts` and register with the DI
container (`di.ts`):

1. Implement `MouseController` / `KeyboardController` / `ClipboardController`.
2. Wire the backend through the container so the gateway and controllers stay backend-
   agnostic.
3. Backends that shell out (e.g. the Win32 clipboard path) must validate all numeric inputs
   and quote text per the PowerShell doubling rule — add captured-command tests that assert
   the exact string the backend would execute.

## 5. Adding a Permission

Permission sets live in `packages/auth/src/rbac`. Add the constant, extend the validation
union, and honour the gate at the router level (the gateway refuses frames from sessions
without the required permission). Pending/unapproved devices receive `[]` by default — never
grant default permissions to unapproved devices.

## 6. Debugging

**Receiver:** run `pnpm dev` (renderer rebuilds via esbuild watcher); inspect the NestJS
gateway logs in the receiver's log panel. Use `probe-tls.mjs` at the repo root to probe the
TLS endpoint and certificate. Enable `DEBUG=kbm*` for network-package logging.

**Sender:** `pnpm --filter @kbm-remote/sender run dev` launches Expo; use the Expo DevTools
in the terminal and React Native debugger for state inspection (Zustand stores are thin, so
store dumps are cheap).

**Network tracing:** the client emits `metrics` events with RTT samples; the receiver
dashboard shows live connection status.

## 7. Testing Conventions

Unit tests live alongside each workspace (`tests/` or co-located `*.test.ts`). Rules:

- Every fix to the protocol, gateway, or auth package requires at least one new test.
- Code-injection defences are tested via *captured-command* tests: inject a mock executor
  (the Win32 backend accepts an `ExecFn` dependency) and assert the exact command string.
- Mock `node:child_process`-level behaviour at the class boundary (DI), not by module
  patching — it is more reliable under Vitest transforms.
- `pnpm test` must be green before commit; Husky runs lint-staged, but tests are a manual
  gate until the pre-push hook includes them.

## 8. CI and Releases

- **`ci.yml`** runs on every push/PR to `master`: quality job (format check, lint, typecheck,
  tests, `pnpm audit` summary) and a per-app build matrix. Merges require all checks.
- **`release.yml`** runs on tags `v*.*.*`: builds the receiver on
  `ubuntu-latest` / `macos-latest` / `windows-latest` via `electron-builder`, uploads the
  artifacts, and creates the GitHub release with draft-off. Installers per platform:

| Platform | Artifact |
| --- | --- |
| Windows | NSIS installer (`KBMRRemoteReceiver Setup 1.0.0.exe`), portable ZIP |
| macOS | DMG + ZIP (universal build on `macos-latest`) |
| Linux | AppImage + deb (built on `ubuntu-latest`) |

Local installer builds:

```bash
pnpm --filter @kbm-remote/receiver run build
pnpm --filter @kbm-remote/receiver run dist   # electron-builder, current platform
```

The receiver's `electron-builder.yml` configures the app ID (`com.kbmremote.receiver`),
targets, and output directory (`dist/release/`). The mobile sender has no desktop installer;
Expo/EAS builds are planned for M8.

## 9. Common Tasks

| Task | Command |
| --- | --- |
| Full clean rebuild | `pnpm clean && pnpm install && pnpm build` |
| Run only receiver tests | `pnpm --filter @kbm-remote/receiver test` |
| Run only protocol tests | `pnpm --filter @kbm-remote/protocol test` |
| Bundle analysis (receiver renderer) | `pnpm --filter @kbm-remote/receiver run bench:bundle` |
| Receiver production start | `pnpm --filter @kbm-remote/receiver run start` |
| Check dependencies | `pnpm audit` (CI also runs this on every quality pass) |
