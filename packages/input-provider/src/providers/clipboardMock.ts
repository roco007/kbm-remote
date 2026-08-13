/**
 * MockClipboardProvider — records calls for tests and acts as the
 * degrade-to-safe fallback so the receiver never fails to start.
 */
import { ClipboardContent, ClipboardProvider } from "../clipboard";

export interface ClipboardCall {
  readonly method: "read" | "write" | "clear";
  readonly input?: ClipboardContent;
}

export class MockClipboardProvider implements ClipboardProvider {
  readonly name = "mock";
  readonly calls: ClipboardCall[] = [];
  /** Preloaded clipboard content returned by `read` until overwritten. */
  private stored: ClipboardContent | null = null;
  /** When set, the matching method throws instead of recording. */
  failOn: Partial<Record<"read" | "write" | "clear", Error>> = {};

  /** Test helper — seed the clipboard before an assertion. */
  seed(content: ClipboardContent | null): void {
    this.stored = content;
  }

  async read(): Promise<ClipboardContent | null> {
    this.check("read");
    this.calls.push({ method: "read" });
    return this.stored;
  }

  async write(content: ClipboardContent): Promise<void> {
    this.check("write");
    this.calls.push({ method: "write", input: content });
    this.stored = content;
  }

  async clear(): Promise<void> {
    this.check("clear");
    this.calls.push({ method: "clear" });
    this.stored = null;
  }

  private check(method: "read" | "write" | "clear"): void {
    const err = this.failOn[method];
    if (err) throw err;
  }
}
