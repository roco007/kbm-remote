/**
 * @kbm-remote/input-provider
 *
 * Receiver-side input abstraction. Providers:
 *   providers/nutjs.ts    — default, built on @nut-tree-fork/nut-js
 *   providers/native.ts   — platform native APIs (SendInput / CGEvent / XTest)
 *
 * TODO (M3): implement providers + factory selection.
 */

export * from "./types";

export const INPUT_PROVIDER_PLACEHOLDER = true;
