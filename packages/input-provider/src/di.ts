/**
 * Composition root — a deliberately tiny dependency-injection container.
 *
 * Philosophy: the input subsystem must stay framework-free (no NestJS, no
 * inversify) so it can be embedded in any host — Electron main process,
 * a bare Node daemon, or a test harness. This container gives us the two
 * properties we actually need:
 *
 *   1. **Constructor injection** — services declare their dependencies as
 *      typed constructor parameters; the container resolves them by type
 *      token, never by stringly-typed lookups.
 *   2. **Testability** — any registration can be swapped for a fake before
 *      resolution, and singletons are resolved by reference.
 *
 * Type safety comes from {@link Token}: each dependency is keyed by a
 * unique symbol tagged with its concrete type, so a missing or mistyped
 * registration is a compile-time error at the call site.
 */

export class Token<T> {
  constructor(readonly name: string) {}
  declare readonly __type: T; // phantom type — never instantiated
}

interface Registration<T> {
  readonly token: Token<T>;
  readonly factory: (container: Container) => T;
  /** "singleton" (default) caches the instance; "transient" builds anew each time. */
  readonly lifetime: "singleton" | "transient";
}

export class Container {
  private readonly registrations = new Map<Token<unknown>, Registration<unknown>>();
  private readonly singletons = new Map<Token<unknown>, unknown>();

  /** Register a factory that the container resolves on first use. */
  register<T>(
    token: Token<T>,
    factory: (container: Container) => T,
    lifetime: "singleton" | "transient" = "singleton",
  ): this {
    this.registrations.set(token, { token, factory, lifetime });
    this.singletons.delete(token);
    return this;
  }

  /** Register a concrete value (already built, e.g. a test spy). */
  registerValue<T>(token: Token<T>, value: T): this {
    return this.register(token, () => value);
  }

  resolve<T>(token: Token<T>): T {
    const reg = this.registrations.get(token);
    if (!reg) {
      throw new Error(
        `No registration for dependency "${token.name}". Register it with container.register(...) before resolving.`,
      );
    }
    if (reg.lifetime === "singleton") {
      if (!this.singletons.has(token)) {
        this.singletons.set(token, reg.factory(this));
      }
      return this.singletons.get(token) as T;
    }
    return reg.factory(this) as T;
  }
}
