# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PeerLink — a static, framework-free, browser-only multi-peer (mesh) file-transfer site. There is no backend app, no build step, and no package manager (no `package.json`). The only server-side component is an *external* WebSocket signaling relay (not part of this repo) that the frontend connects to for WebRTC offer/answer/ICE exchange; it never sees file content.

See `SPEC.md` for the full protocol/architecture spec — read it before making non-trivial changes to signaling, WebRTC negotiation, or the transfer protocol, since those are easy to get subtly wrong.

## Commands

There is no build, lint, or test tooling in this repo — it's plain HTML/CSS/JS served as-is.

- **Run locally**: serve the directory with any static file server, e.g. `python3 -m http.server 8000` or `npx serve .`, then open `http://localhost:8000/`. Opening `index.html` directly via `file://` will *not* work for signaling (WebSocket + clipboard APIs need a proper origin).
- **Point at a different/local signaling server** without editing code: in the browser devtools console, run `localStorage.setItem('p2p_signal_base', 'wss://your-host/?app=p2p-file-transfer&room=')` then reload. Falls back to the production endpoint hardcoded in `app.js`.
- **Testing changes**: manually, in-browser. Open the same URL in two+ browser tabs/profiles (or two devices) to exercise pairing and transfer, since two peers are needed to see anything happen. There is no automated test suite.

## Architecture

Four files, no modules/bundler: `index.html` (markup + inline styles for structural layout), `styles.css` (design tokens + shared component classes + animations + RWD), `app.js` (all logic, single `'use strict'` IIFE-free script), `qrcode.js` (vendored third-party QR generator — don't modify, it's an unmodified MIT-licensed library).

### Mental model

One `RTCPeerConnection` + one `RTCDataChannel` per *pair* of devices in the room (mesh, not star). There is no central server relaying file bytes — only signaling (SDP/ICE) goes through the WebSocket relay. Read `app.js` top-to-bottom in this order to build a mental model:

1. **Config constants** (top of file) — `SIGNALING_BASE_URL`, `ICE_SERVERS`, `CHUNK_SIZE`/`BUFFER_HIGH`/`BUFFER_LOW`, `MAX_REMOTE_PEERS`, timeouts. Almost all tuning happens here.
2. **State** — `peers: Map<peerId, PeerState>` (one entry per remote device), `files[]` (all transfer records, both directions), `recvMap` (transfer id → in-progress incoming record), `sendQueue`/`incomingQueue`.
3. **Signaling** (`connectSignaling`, `sig`, `onSignal` + `handleHello`/`handleDesc`/`handleIce`/`handleBye`/`handleRoomFull`) — thin JSON-over-WebSocket layer. Auto-reconnects with a 2s timer while `wantConnected` is true.
4. **WebRTC negotiation** (`setupPeer`, `handleDescription`, `handleCandidate`) — implements the standard *perfect negotiation* pattern. Politeness is derived deterministically per-pair as `polite = myId < peerId` (no extra handshake needed). Don't touch this without understanding glare/offer-collision handling — it's the trickiest part of the codebase.
5. **Data channel + transfer protocol** (`setupDataChannel`, `onDcMessage`, `onControl`, `sendToTarget`/`streamFileToTarget`, `finalizeReceive`) — JSON control messages (`meta`/`accept`/`reject`/`begin`/`end`) interleaved with raw binary chunk messages on the *same* channel, correlated via `p.currentRecvId`. Sending uses manual backpressure (`bufferedAmount` vs `BUFFER_HIGH`/`BUFFER_LOW` + `drain()`) — don't remove this or large files will blow up buffered memory. A `chat` control message (`{t:'chat',text}`, `sendChat`/`receiveChat`) rides the same channel for the messages/clipboard tab — it's broadcast (one copy per open peer), needs no accept handshake, and is *not* correlated via `currentRecvId`.
6. **Tabs + chat/clipboard UI** — the right column is two tab panels (`#panel-files` / `#panel-chat`) toggled by `setActiveTab`, with per-tab unread badges (`unread`/`fileUnread`). Chat messages live only in memory (`messages[]`, cleared on `joinRoom`/`disconnect`); render via `renderMessage` (text set with `textContent`, never HTML) and `looksMono` picks display vs mono font.
7. **UI rendering** — imperative, no virtual DOM/framework. `el` is a flat map of `document.getElementById` refs populated once at the top; render functions (`renderPeerChip`, `renderRow`, `refreshRoomUI`, etc.) are called explicitly after every state mutation. Row-level progress updates are throttled to ~120ms via `onTargetProgress`/`requestAnimationFrame` — follow that pattern if adding new high-frequency UI updates rather than rendering on every chunk.

### Key invariants worth knowing before editing

- A broadcast to N connected peers creates one transfer *record* with N *targets* (`rec.targets[]`), each with independent status/progress; a record is only terminal once every target reaches a terminal state (`done`/`rejected`/`error`).
- Received file bytes are buffered fully in memory (`rec._chunks`) until the `end` control message, then assembled into a `Blob` — there is no streaming-to-disk. Keep this in mind if asked to support very large files.
- Room membership cap (`MAX_REMOTE_PEERS = 5`, i.e. 6 devices total) is enforced independently by each peer locally, not arbitrated by the signaling server — it's a soft cap.
- `index.html` uses inline `style="..."` attributes for structural/layout CSS (matches the existing pattern); `styles.css` holds only design tokens, shared component classes (`.btn`, `.eyebrow`, `#toast`, etc.), keyframes, and the one RWD breakpoint (720px). Follow whichever pattern the surrounding code already uses when editing a given block.
- All user-facing strings are Traditional Chinese (zh-Hant) — match this when adding UI copy.
