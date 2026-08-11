/**
 * NestJS modules for the receiver (Architecture §7.2):
 *   SessionModule   — auth state machine, heartbeat watchdog
 *   PairingModule   — pairing code issuance/verification, enrollment, revocation
 *   DiscoveryModule — mDNS publish/browse, UDP beacon, manual IP listing
 *   InputModule     — dispatches authenticated frames to the InputProvider
 *   ClipboardModule — clipboard up/download + sync
 *   FileTransferModule, NotificationModule, DeviceRegistryModule …
 *
 * TODO (M1–M4): implement modules incrementally per roadmap.
 */

export const MODULES_PLACEHOLDER = true;
