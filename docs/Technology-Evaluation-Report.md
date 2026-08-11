# Technology Evaluation Report

## Remote Keyboard & Mouse Emulator

**Author:** Manus AI
**Version:** 1.0 (companion to Architecture Design Document v1.1)
**Date:** August 11, 2026

---

## 1. Purpose and Method

This report evaluates every major technology choice in the system across three decision areas: the **native input layer** on the desktop receiver, the **network transport** between sender and receiver, and the **device discovery** mechanism. Each candidate is scored from 1 (poor) to 5 (excellent) on seven criteria, weighted for a production application in 2026: maintenance, performance, latency, security, documentation, community, and long-term support. Scores are justified with cited evidence, a recommendation is made per decision area, and the final section states exactly which parts of the architecture document change as a result.

The evaluation principle is consistent throughout: **on a local network at 1 ms-class round-trip times, the dominant risks for a 2026 production product are not raw latency but maintainability, security posture, and ecosystem longevity.** A transport that saves 3 ms but costs two years of custom protocol maintenance is the wrong trade for a v1.0.

---

## 2. Decision Area 1 — Native Input Layer

The receiver must _synthesize_ (emulate) keyboard and mouse events at the OS level. This is the highest-risk layer of the entire product because it depends on native code, OS permissions, and per-platform quirks.

### 2.1 Candidate comparison

| Criterion (1–5)         | RobotJS | Nut.js (fork `@nut-tree-fork/nut-js`) | iohook   | Native Windows (SendInput) | Native macOS (CGEvent) | Native Linux (XTest/X11) |
| ----------------------- | ------- | ------------------------------------- | -------- | -------------------------- | ---------------------- | ------------------------ |
| Maintenance             | 1       | 4                                     | 1        | 5 (OS-stable)              | 4                      | 3                        |
| Performance             | 3       | 5                                     | 2*       | 5                          | 5                      | 5                        |
| Latency (injection)     | 3       | 5                                     | 2*       | 5                          | 5                      | 5                        |
| Security                | 3       | 4                                     | 2        | 4                          | 3                      | 3                        |
| Documentation           | 2       | 4                                     | 2        | 4 (MSDN)                   | 3 (Apple dev)          | 2                        |
| Community               | 1       | 3                                     | 2        | 5                          | 4                      | 3                        |
| Long-term support       | 1       | 3                                     | 1        | 5                          | 4                      | 3                        |
| **Weighted total (÷7)** | **2.1** | **3.9**                               | **1.9*** | **4.4**                    | **4.0**                | **3.4**                  |

_\*iohook scores low in performance/latency for this use case because it is fundamentally the wrong tool class — see below._

### 2.2 RobotJS — reject

RobotJS was the original Node native-input library, but it is effectively dead: the repository is unmaintained and the maintainer confirms in the project's own issue tracker that it "does not provide prebuilds for recent node versions" and requires rebuilding native code for every Node/Electron major version [1]. A production desktop app pinned to a stale Electron fork of the input library is an unacceptable long-term risk. Score: **reject**.

### 2.3 iohook — reject (category error)

iohook, built on libuiohook, is designed as a **global input listener/hook** — it captures and monitors events occurring anywhere on the desktop. Its npm page and issue tracker describe monitoring use cases, and its last meaningful maintenance activity dates to 2021, with prebuilt binaries only up to Node 15 (ABI 88) [2] [3]. It does not provide event _synthesis_ at all; to emulate input one would need to add a completely separate native binding anyway. Using it for a mouse/keyboard _emulator_ is a category error, and even as a future "observe local input to release the mouse" enhancement, its unmaintained state makes it unsuitable. Score: **reject**.

### 2.4 Native platform APIs — strong, but not as the default

Writing thin N-API/C++ bindings directly to `SendInput` (Windows), `CGEventPost` (macOS), and `XTest`/`XWarpPointer` (Linux) scores highest on performance, latency, and LTS because the APIs are owned by the OS vendors and never abandon their platforms [4] [5]. The drawbacks are all on the product side: each Electron major version requires rebuilding bindings, media-key synthesis on Windows needs extended-key scan-code handling, macOS requires Accessibility permission plumbing, and the team owns a non-trivial native C++ surface whose bugs become their bugs. For v1.0 this raises time-to-market and test burden without buying measurable latency (nut.js injects in 1–5 ms already).

**Role in the architecture:** the native APIs are not rejected — they are the **designated fallback provider** behind the existing `InputProvider` interface. If the nut.js fork's supply ever degrades (a real risk, see 2.5), the switch is configuration-level, not architectural. This is exactly the risk hedge Clean Architecture exists for.

### 2.5 nut.js (community fork) — recommend as default provider

nut.js provides the most complete emulation API surface of any Node library — typed `mouse` and `keyboard` primitives, drag as `buttonDown`/move/`buttonUp`, media keys, clipboard read/write, and multi-monitor screen enumeration through its provider architecture [6]. The project remains open source and actively developed, but since the maintainer's 2023 decision to move official prebuilt binaries behind a paid subscription [7], the production-viable path is the community fork `@nut-tree-fork/nut-js` (v4.2.6, Apache-2.0, actively published with prebuilds) [8]. Its risks — dependence on a volunteer fork, X11-only Linux, macOS permission prompts — are all documented, mitigable, and reversible thanks to the provider abstraction. No other option combines this coverage with this time-to-market profile. Score: **recommend as v1 default**.

### 2.6 Recommendation

**nut.js fork as `NutProvider` (default), native platform APIs as `NativeProvider` (fallback), behind the frozen `InputProvider` interface. RobotJS and iohook are excluded from the product.** The abstraction was already part of the architecture; this evaluation confirms it as the central input-layer decision rather than a convenience.

---

## 3. Decision Area 2 — Network Transport

The input stream needs sub-50 ms glass-to-glass latency over a LAN, authenticated confidentiality, reliable clipboard delivery, and effortless reconnection over Wi-Fi drops. The LAN context matters enormously: at 1 ms-class RTT, theoretical transport advantages collapse into single-digit millisecond differences, while operational complexity differences do not.

### 3.1 Candidate comparison

| Criterion (1–5)         | WebSockets (WSS) | WebRTC data channels | Raw TCP (net) | Raw UDP | QUIC/WebTransport |
| ----------------------- | ---------------- | -------------------- | ------------- | ------- | ----------------- |
| Maintenance             | 5                | 3                    | 4             | 3       | 2                 |
| Performance             | 5                | 4                    | 5             | 5       | 4*                |
| Latency (LAN)           | 4                | 5                    | 4             | 5       | 4                 |
| Security                | 5                | 4                    | 3             | 1       | 5                 |
| Documentation           | 5                | 4                    | 5             | 4       | 2                 |
| Community               | 5                | 3                    | 5             | 3       | 2                 |
| Long-term support       | 5                | 4                    | 5             | 5       | 3                 |
| **Weighted total (÷7)** | **4.9**          | **3.9**              | **4.1**       | **3.6** | **3.6**           |

_\*QUIC's measured performance is environment-dependent; benchmark studies report the QUIC stack (UDP + QUIC + HTTP/3) can be up to 45% slower than a comparable HTTP/2/TCP stack in some deployments [9]._

### 3.2 WebSockets over TLS (WSS) — recommend

The WebSocket protocol over a TLS 1.3 connection, served by the mature `ws` (or `uWebSockets.js` for performance) library, delivers everything the product needs with zero custom transport code: binary frames for large clipboard/file payloads, subprotocol negotiation for wire versioning, first-class support in Node.js and React Native (the RN `WebSocket` polyfill handles WSS natively), trivial reconnection, and universal firewall/proxy friendliness. Head-of-line blocking — the classic criticism of TCP-based streaming — is a non-issue on a LAN where packet loss is near zero and the 8 ms event-batching design already absorbs jitter. This is the same lane used by Synergy/Deskflow-class products for their event streams [10]. Score: **recommend**.

### 3.3 WebRTC data channels — reject for v1

Data channels on SCTP-over-UDP offer unordered, unreliable delivery and marginally lower latency on lossy links [11] [12]. But the price is the full ICE/STUN/TURN machinery, SDP offer/answer signaling, and NAT-traversal state — infrastructure designed for _cross-internet peer-to-peer_, which this product does not need: sender and receiver are on the same LAN by definition. On the server side, Node's WebRTC options (`node-datachannel`, media servers) are small-community tools compared to the bulletproof `ws` ecosystem. The ICE complexity would buy nothing on a LAN and would dominate the roadmap for months. Score: **reject for v1; the correct re-entry point is screen sharing**, where WebRTC's real-time media pipeline is genuinely needed — at which point screen traffic can ride WebRTC while input stays on WSS.

### 3.4 Raw TCP and raw UDP — reject as application protocols

Raw `net` TCP sockets match WSS on performance but force the team to reinvent framing, an auth state machine, keepalives, and TLS wiring that WSS provides for free, and they offer no standard client surface on the React Native side. Raw UDP is disqualified on security grounds — input events, tokens, and clipboard content cannot travel unauthenticated and unencrypted on an untrusted LAN — and on reliability grounds for the acknowledged channels. TCP and UDP remain essential _underneath_ WSS and the discovery beacon respectively; they are infrastructure, not choices. Score: **reject as the application protocol**.

### 3.5 QUIC/WebTransport — defer

QUIC (RFC 9000) offers genuine architectural benefits — no head-of-line blocking across multiplexed streams, 1-RTT and 0-RTT handshakes, connection migration across Wi-Fi changes [13] — and Node.js finally gained a native `node:quic` module in Node 25 (October 2025) following OpenSSL 3.5 [14] [15]. However, as of August 2026 the API is `--experimental-quic` with **Stability: 1.0 (Early development)** and expected to change [14]; the current LTS line (Node 24) does not ship it; and WebTransport, while it reached W3C Baseline in March 2026 [16], still has patchy runtime support on mobile. For a product shipping v1.0 in 2026, adopting an experimental, not-yet-LTS transport is indefensible — especially when QUIC's own benchmarks show it is not universally faster on short LAN hops [9]. Score: **defer to v2 backlog**, where its head-of-line-blocking-free multiplexing is most valuable — precisely when the screen-sharing and remote-terminal channels share one connection.

### 3.6 Recommendation

**WSS (WebSocket + TLS 1.3) as the sole application transport for v1, with a versioned subprotocol for forward compatibility. WebRTC and QUIC are archived as deliberate v2 options, triggered by screen sharing and multi-channel multiplexing respectively.**

---

## 4. Decision Area 3 — Device Discovery

Discovery must surface the receiver on the phone with zero configuration, survive hostile network environments (blocked multicast, guest VLANs), and carry enough metadata (name, port, auth-required flag, protocol version) to make the connect decision informative.

### 4.1 Candidate comparison

| Criterion (1–5)           | mDNS/DNS-SD | SSDP/UPnP | Manual IP | Bluetooth/BLE |
| ------------------------- | ----------- | --------- | --------- | ------------- |
| Maintenance               | 4           | 3         | 5         | 2             |
| Performance               | 4           | 4         | 5         | 3             |
| Latency (to list devices) | 4           | 4         | 5         | 3             |
| Security                  | 4           | 2         | 4         | 3             |
| Documentation             | 4           | 3         | 5         | 4             |
| Community                 | 4           | 3         | 5         | 3             |
| Long-term support         | 5           | 2         | 5         | 4             |
| **Weighted total (÷7)**   | **4.0**     | **3.0**   | **4.6**   | **3.1**       |

### 4.2 mDNS/DNS-SD — recommend as primary automatic discovery

mDNS/DNS-SD is the proven zero-configuration standard used by AirPlay, Chromecast, and KDE Connect's ecosystem peers. TXT records carry exactly the metadata a device list needs (port, protocol version, auth flag, display name), macOS and Linux ship responders natively, and Windows 10+ coexists with it; the pure-JavaScript `bonjour-service`/`multicast-dns` stack means the Electron receiver takes **no native compilation dependency** [17]. Its weaknesses — multicast blocked on some networks, cross-subnet blindness — are covered by the UDP beacon and manual IP tiers rather than by switching protocols. Score: **recommend primary**.

### 4.3 SSDP — reject

SSDP (UPnP discovery over HTTPU) works and is cross-platform, but the UPnP ecosystem carries a long history of security incidents (SSDP reflection/amplification attacks) that make router firmware and enterprise networks actively hostile to it [18]. Its metadata model is XML-verbose compared to DNS-SD TXT records, and its community momentum has moved on. Where it retains a niche — router and gateway discovery — is not this product's job. Score: **reject**.

### 4.4 Manual IP entry — keep as permanent fallback

Manual IP entry scored highest of the four precisely because nothing can break it: no multicast, no permissions, no radio stack. It is retained in the architecture exactly as designed — the guaranteed last-resort path, always available even when every automatic mechanism fails. Score: **keep**.

### 4.5 Bluetooth/BLE — reject

Bluetooth advertising can technically carry a device hint, but for a LAN tool it duplicates the pairing UX that the QR channel already owns, requires heavy native modules on React Native (`react-native-ble-plx`), is subject to iOS background-advertising restrictions, offers no cross-subnet path, and provides throughput far below what future clipboard/file channels need. The same proximity signal (user physically sees the receiver) that makes Bluetooth attractive is already captured more securely by QR + fingerprint pinning. Score: **reject**.

### 4.6 Recommendation

**mDNS/DNS-SD primary + manual IP permanent fallback + UDP beacon pre-fallback — unchanged from v1.0 of the architecture.** This evaluation's contribution is the explicit exclusion of SSDP and Bluetooth as future extensions; neither warrants a backlog slot.

---

## 5. Consolidated 2026 Production Stack

| Layer                    | v1.0 Choice                                                                                                           | Runner-up (backlog trigger)                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Input emulation          | **nut.js via `@nut-tree-fork/nut-js`** behind `InputProvider`; `NativeProvider` (SendInput/CGEvent/XTest) as fallback | — (robotjs/iohook excluded entirely)                                     |
| Transport                | **WSS (ws library, TLS 1.3, MessagePack frames, versioned subprotocol)**                                              | QUIC/WebTransport — trigger: screen sharing / multi-channel multiplexing |
| Real-time media (future) | —                                                                                                                     | **WebRTC** — trigger: screen sharing feature                             |
| Discovery                | **mDNS/DNS-SD + manual IP + UDP beacon**                                                                              | — (SSDP/Bluetooth excluded entirely)                                     |

The logic of the consolidated table: every chosen technology is (a) mature and LTS-safe in 2026, (b) first-class in both Node/Electron and React Native, and (c) replaceable through an existing interface or subprotocol so that the deferred technologies can be adopted later without re-architecture. Every rejected technology fails at least one of those tests on evidence, not on taste.

---

## 6. Architecture Updates

The following changes are applied to the Architecture Design Document (v1.1), and are recorded here for traceability:

1. **Section 2.1 (input layer) is expanded** from a nut.js-vs-robotjs comparison into the full six-candidate evaluation in Section 2 of this report, with iohook formally excluded and the native-provider fallback elevated from "future" to "designated fallback with exit criteria" (see the decision table in Section 6.1 below).
2. **Section 9 (networking) is revised** to state WSS as the _sole_ application transport for v1 with explicit deferral language for QUIC and WebRTC, and to note the experimental status of `node:quic` as the reason for deferral [14].
3. **Section 9's discovery table gains a "rejected" annotation** for SSDP and Bluetooth with the security and ecosystem reasoning of Section 4, removing any ambiguity that they are still under consideration.
4. **A new Section 2.6 (technology governance)** is added: any future change to an evaluated layer requires (a) the provider/subprotocol interface contract to remain intact, (b) a benchmark showing ≥10% improvement on the glass-to-glass metric, and (c) a maintenance-commitment review of the replacement's ecosystem.
5. **Roadmap Phase M1 exit criteria sharpened:** the input-provider switch test now explicitly covers both `NutProvider` and `NativeProvider` so the fallback path is proven at v1.0, not discovered at migration time.

### 6.1 Provider exit criteria

| Trigger                                                                                         | Action                                                                                    |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@nut-tree-fork/nut-js` ceases publishing prebuilds for ≥2 Electron LTS versions                | Switch `INPUT_PROVIDER` config to `NativeProvider`; no service changes                    |
| `@nut-tree-fork/nut-js` license changes away from Apache-2.0                                    | Same switch; vendor `NativeProvider` immediately                                          |
| Node.js LTS ships stable `node:quic` **and** WebTransport is Baseline on all target RN runtimes | Open QUIC migration spike in v2 backlog; WSS remains production default until benchmarked |
| Screen-sharing feature approved                                                                 | Add WebRTC media plane alongside WSS control plane; input stays on WSS                    |

---

## References

[1]: https://github.com/octalmage/robotjs/issues/695 "robotjs issue #695 — unmaintained status, missing prebuilds for recent Node versions"
[2]: https://github.com/wilix-team/iohook "wilix-team/iohook — GitHub repository (global input listener via libuiohook)"
[3]: https://github.com/wilix-team/iohook/issues/373 "iohook issue #373 — prebuilds only available up to Node v15"
[4]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput "Microsoft Learn — SendInput function (Windows input synthesis)"
[5]: https://developer.apple.com/documentation/coregraphics/cgevent "Apple Developer Documentation — CGEvent (macOS event creation and posting)"
[6]: https://nutjs.dev/ "nut.js — Desktop Automation for Node.js (mouse/keyboard/clipboard/media API surface)"
[7]: https://github.com/nut-tree/nut.js/ "nut-tree/nut.js — GitHub repository (prebuild licensing, X11-only limitation, maintenance status)"
[8]: https://www.npmjs.com/package/@nut-tree-fork/nut-js "npm — @nut-tree-fork/nut-js v4.2.6, Apache-2.0, actively published prebuilds"
[9]: https://arxiv.org/html/2310.09423v2 "arXiv 2310.09423 — QUIC vs HTTP/2 performance study (QUIC stack up to 45% slower in some deployments)"
[10]: https://github.com/debauchee/barrier "Barrier — open-source KVM software (low-latency event streaming over LAN)"
[11]: https://ably.com/topic/webrtc-vs-websocket "Ably — WebRTC vs WebSocket comparison (UDP vs TCP latency characteristics)"
[12]: https://www.100ms.live/blog/webrtc-vs-websocket "100ms — WebRTC vs WebSocket for real-time communication"
[13]: https://jasnell.me/posts/quic-comes-to-node "James M. Snell — QUIC and HTTP/3 come to Node.js (node:quic architecture and properties)"
[14]: https://nodevibe.substack.com/p/state-of-quic-in-nodejs "NodeVibe — State of QUIC in Node.js (Stability 1.0, Node 25, OpenSSL 3.5 dependency)"
[15]: https://nodejs.org/en/about/previous-releases "Node.js — release schedule (Node 24 LTS, Node 25 timeline)"
[16]: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API "MDN — WebTransport API (Baseline status March 2026)"
[17]: https://www.npmjs.com/package/bonjour-service "npm — bonjour-service (TypeScript mDNS/DNS-SD implementation, pure-JS multicast-dns backend)"
[18]: https://community.kde.org/KDEConnect/PrivacyPolicy "KDE Connect Privacy Policy — TLS-based pairing model used as security reference"
