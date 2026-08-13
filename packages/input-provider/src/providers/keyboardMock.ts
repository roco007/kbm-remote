/**
 * MockKeyboardProvider — in-memory spy implementing {@link KeyboardProvider}
 * for deterministic tests. Every method records its input; an optional
 * `failOn` map makes any method throw, which is how the controller tests
 * verify that validation happens *before* the OS is touched.
 */
import {
  KeyboardProvider,
  MediaKeyInput,
  PressInput,
  ReleaseInput,
  TypeTextInput,
} from "../keyboard";

export interface KeyboardCall {
  method: keyof KeyboardProvider;
  input: unknown;
}

export class MockKeyboardProvider implements KeyboardProvider {
  readonly name = "mock";
  readonly calls: KeyboardCall[] = [];
  /** When set, the matching method throws the given error instead of recording. */
  failOn: Partial<Record<keyof KeyboardProvider, Error>> = {};

  async press(input: PressInput): Promise<void> {
    this.check("press");
    this.calls.push({ method: "press", input });
  }
  async release(input: ReleaseInput): Promise<void> {
    this.check("release");
    this.calls.push({ method: "release", input });
  }
  async typeText(input: TypeTextInput): Promise<void> {
    this.check("typeText");
    this.calls.push({ method: "typeText", input });
  }
  async mediaKey(input: MediaKeyInput): Promise<void> {
    this.check("mediaKey");
    this.calls.push({ method: "mediaKey", input });
  }
  private check(method: keyof KeyboardProvider): void {
    const err = this.failOn[method];
    if (err) throw err;
  }
}
