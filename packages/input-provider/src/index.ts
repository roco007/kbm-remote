/**
 * @kbm-remote/input-provider
 *
 * Receiver-side input abstraction. The subsystems are split per device class
 * so the receiver can grant fine-grained permissions (e.g. "mouse" without
 * "keyboard") and swap providers independently:
 *
 *   mouse.ts            — MouseProvider interface + display/geometry types
 *   controllers/        — MouseController: normalization, rate limiting,
 *                         drag state machine (depends only on the interfaces)
 *   providers/          — platform implementations:
 *       nutjs.ts        — default provider, built on @nut-tree-fork/nut-js
 *       native.ts       — OS-native implementations (SendInput / CGEvent / XTest)
 *                         selected by process.platform at factory time
 *       mock.ts         — spy provider for tests
 *   di.ts               — tiny composition root: register + resolve
 */

export * from "./mouse";
export * from "./controllers/MouseController";
export * from "./providers/mock";
export * from "./providers/nutjs";
export * from "./providers/native";
export * from "./providers/factory";
export * from "./di";
export * from "./types";
