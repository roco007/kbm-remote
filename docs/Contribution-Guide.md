# Contribution Guide — KBM Remote v1.0

KBM Remote is a security-sensitive application: it moves input events across the local
network into a host operating system. Contributions are welcome, but every change passes
through a strict quality and review gate.

## 1. How to Contribute

1. **Fork** the repository and create a feature branch (`feat/`, `fix/`, `docs/` prefix).
2. **Set up** the workspace: `pnpm install` (Node 22+, pnpm 10+).
3. **Develop** with `pnpm dev` and keep `pnpm test && pnpm lint && pnpm typecheck` green.
4. **Commit** following Conventional Commits (enforced by commitlint):

```
<type>(<scope>): <subject>
# type : feat | fix | docs | style | refactor | perf | test | build | ci | chore
# scope: receiver | sender | protocol | network | auth | input | ui | repo | deps | ci
```

5. **Push** and open a **pull request** against `master` with a description of the change,
   the rationale, and any UI/protocol behaviour differences. Reference issues by number.
6. **Review**: two approvals are required for `protocol`, `network`, and `auth` changes,
   because they touch the security boundary. All CI checks (CI workflow) must be green.

Husky runs `lint-staged` (ESLint + Prettier) on staged files and commitlint on every commit
before push — formatting and style problems are caught locally, not in CI.

## 2. What to Contribute

Prioritised needs for v1.x:

- Platform input backends (X11/Wayland keyboard, macOS native `CGEvent` paths)
- iOS sender support (planned M8)
- Token TTL and rolling re-authentication (M8)
- Clipboard history and file transfer features (reserved frame IDs already exist)
- Documentation fixes, translation, and accessibility work on the MD3 UI
- Benchmark additions and performance work (FastCodec lineage)

## 3. Security Contributions

Security changes follow a different path:

- **Do not** open public PRs for vulnerabilities. Report via the project's security contact
  (repository issue tracker with `security` label, or direct message to the maintainer).
- The project's security posture is documented in [`Security-Audit-M7.md`](./Security-Audit-M7.md);
  new changes must not weaken any control listed there (pinning, challenge-response, replay
  guards, rate limiting, token hashing, permission gates, decompression caps).
- Anything touching `protocol`, `network`, `auth`, or input command construction requires
  the two-approval rule and must include regression tests. Captured-command tests are the
  accepted pattern for shell-path changes.
- Secrets (tokens, keys, GitHub tokens used in automation) must never appear in the tree;
  automation holds the GitHub token in environment variables only.

## 4. Code Style

- **TypeScript strict mode everywhere** — no `any` without an explanatory disable comment.
- Prettier (2-space, double quotes) via the repo config; ESLint with import ordering.
- Prefer pure packages (`protocol`, `network`, `auth`) for shared logic; keep Electron- and
  React-Native-specific code inside `apps/`.
- Dependency injection over singletons for anything the tests must double.
- Commit size: one logical change per commit; CI history stays bisectable.

## 5. Pull Request Checklist

- [ ] `pnpm test` green in every affected workspace (add tests for the change)
- [ ] `pnpm lint` and `pnpm typecheck` green repo-wide
- [ ] Conventional commit message
- [ ] Protocol changes update the type table and validation, and note compatibility
- [ ] No new transitive runtime dependencies without maintainer discussion
- [ ] `pnpm audit` does not regress
- [ ] UI changes preserve the MD3 light/dark design system

## 6. Code of Conduct

Treat reviewers and contributors with respect. Disagreements about architecture belong in
the issue tracker with reasoning, not in comment threads. The maintainer's decision is
final on architecture questions; security questions defer to the documented threat model.
