/* ===================================================================
   PeerLink — browser multi-peer file transfer
   Real WebRTC DataChannel mesh: each device opens a direct connection
   to every other device in the room (up to 6 total) through a
   room-relay signaling server. No server storage, no file-size limit.
   =================================================================== */
'use strict';

/* ------------------------------------------------------------------ *
 *  Config
 * ------------------------------------------------------------------ */
// Signaling endpoint. Overridable via localStorage('p2p_signal_base') for
// local testing / repointing without a rebuild.
const SIGNALING_BASE_URL =
  (typeof localStorage !== 'undefined' && localStorage.getItem('p2p_signal_base')) ||
  'wss://signal.ksdevworks.online/?app=p2p-file-transfer&room=';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const CHUNK_SIZE   = 16 * 1024;        // 16 KiB — safe across browsers
const BUFFER_HIGH  = 4 * 1024 * 1024;  // pause sending above 4 MiB buffered
const BUFFER_LOW   = 512 * 1024;       // resume once drained below 512 KiB
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_REMOTE_PEERS = 5;            // + self = 6 total room size (soft cap)
const DECISION_TIMEOUT_MS = 25000;     // give up waiting on an accept/reject
const NEGOTIATION_TIMEOUT_MS = 20000;  // give up on a peer stuck negotiating
const CHAT_MAX_LEN = 8000;             // clamp a single chat/clipboard message

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const myId      = randomId(12);
const myLabel   = deviceLabel();
let   roomCode  = '----';
let   ws        = null;
let   wsReconnectTimer = null;
let   wantConnected = false;          // should the ws be open?

const peers     = new Map();          // peerId -> PeerState
let   peerPalCounter = 0;

const files     = [];                 // all transfer records (in + out)
const sendQueue = [];                 // outgoing records awaiting broadcast
let   sending   = false;

const recvMap   = Object.create(null);// transfer id -> incoming record (ids are globally unique)
const incomingQueue = [];             // pending {peerId,peerLabel,id,name,size,mime} awaiting modal
let   activeIncoming = null;

const roomFullNoticeSeen = new Set(); // dedupe 'room-full' toasts per sender

const messages  = [];                 // chat/clipboard log {id,mine,from,text,time,mono,node}
let   activeTab = 'files';            // 'files' | 'chat' | 'screen'
let   unread    = 0;                  // chat msgs arrived while not on the chat tab
let   fileUnread = 0;                 // incoming files accepted while not on the files tab

let   localScreenStream = null;       // our own getDisplayMedia() stream, or null when not sharing
let   screenUnread = 0;               // live share tiles that appeared while not on the screen tab

/* ------------------------------------------------------------------ *
 *  DOM refs
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const el = {
  statusDot: $('status-dot'), statusText: $('status-text'),
  cardConnected: $('card-connected'), cardPairing: $('card-pairing'),
  peerRoster: $('peer-roster'), noPeers: $('no-peers'),
  roomCodeEyebrow: $('room-code-eyebrow'),
  statTotal: $('stat-total'), statRoomCount: $('stat-room-count'), statMyLinks: $('stat-my-links'),
  pairEyebrowText: $('pair-eyebrow-text'), pairDesc: $('pair-desc'),
  qr: $('qr'), qrWrap: $('qr-wrap'), roomCode: $('room-code'), btnCopy: $('btn-copy'), copyLabel: $('copy-label'),
  btnQrToggle: $('btn-qr-toggle'), qrToggleLabel: $('qr-toggle-label'),
  joinWrap: $('join-wrap'), joinInput: $('join-input'), btnConnect: $('btn-connect'), connectLabel: $('connect-label'),
  btnDisconnect: $('btn-disconnect'), roomFullNote: $('room-full-note'),
  peerNameModal: $('peer-name-modal'),
  dropzone: $('dropzone'), dropTitle: $('drop-title'), dropSub: $('drop-sub'), fileInput: $('file-input'),
  btnClear: $('btn-clear'), emptyState: $('empty-state'), fileList: $('file-list'),
  tabFiles: $('tab-files'), tabChat: $('tab-chat'), tabScreen: $('tab-screen'),
  badgeFiles: $('badge-files'), badgeChat: $('badge-chat'), badgeScreen: $('badge-screen'),
  panelFiles: $('panel-files'), panelChat: $('panel-chat'), panelScreen: $('panel-screen'),
  chatList: $('chat-list'), chatEmpty: $('chat-empty'), msgCount: $('msg-count'),
  chatInputRow: $('chat-input-row'), chatOffline: $('chat-offline'), chatDraft: $('chat-draft'), btnSend: $('btn-send'),
  btnScreenShare: $('btn-screen-share'), screenShareLabel: $('screen-share-label'),
  screenGrid: $('screen-grid'), screenEmpty: $('screen-empty'),
  modal: $('modal-incoming'), incIcon: $('inc-icon'), incExt: $('inc-ext'),
  incName: $('inc-name'), incSize: $('inc-size'), btnAccept: $('btn-accept'), btnReject: $('btn-reject'),
  toast: $('toast'),
};

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */
function randomId(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, x => (x % 36).toString(36)).join('');
}
function genCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function sanitizeCode(v) {
  return (v || '').toUpperCase().split('').filter(c => CODE_ALPHABET.indexOf(c) >= 0).join('').slice(0, 6);
}
function fmt(b) {
  b = b || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function ext(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].slice(0, 4).toUpperCase() : 'FILE';
}
const GRADS = ['var(--gradient-1)', 'var(--gradient-2)', 'var(--gradient-3)', 'var(--gradient-4)'];
function palette(i) { return GRADS[i % GRADS.length]; }
function nextPeerPal() { return peerPalCounter++; }

function deviceLabel() {
  const ua = navigator.userAgent;
  let os = '裝置';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Macintosh|Mac OS/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\//.test(ua)) br = 'Opera';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return br ? br + ' · ' + os : os;
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  el.toast.style.animation = 'none';
  void el.toast.offsetWidth;
  el.toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function nowHM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
// heuristic: render as monospace when the text looks like a link / code / long paste
function looksMono(t) {
  const s = t.trim();
  return /\n/.test(t) || t.length > 56 || /^https?:\/\//i.test(s) || /^[\w.+-]+@[\w.-]+$/.test(s) || /[{};=<>]/.test(t);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  ta.remove();
  return ok;
}

function isTerminal(status) { return status === 'done' || status === 'rejected' || status === 'error'; }
function countConnected() {
  let n = 0;
  for (const p of peers.values()) if (p.connState === 'connected') n++;
  return n;
}

/* ------------------------------------------------------------------ *
 *  Status pill + room dashboard chrome
 * ------------------------------------------------------------------ */
let statusKey = 'connecting';
function setStatus(key, label) {
  statusKey = key;
  const MAP = {
    offline:    ['#a45a32', '離線'],
    connecting: ['#3b52c4', '連線中…'],
    waiting:    ['#a45a32', '等待裝置加入'],
    pairing:    ['#3b52c4', '配對中…'],
    connected:  ['#257e45', label],
  };
  const [color, text] = MAP[key] || MAP.offline;
  el.statusDot.style.background = color;
  el.statusText.style.color = color;
  el.statusText.textContent = text;
}
function updateStatusFromRoster() {
  if (!wantConnected) { setStatus('offline'); return; }
  const connected = countConnected();
  if (connected > 0) { setStatus('connected', (connected + 1) + ' 人已連線'); return; }
  if (peers.size > 0) { setStatus('pairing'); return; }
  if (ws && ws.readyState === WebSocket.OPEN) { setStatus('waiting'); return; }
  setStatus('connecting');
}
function updatePairingVisibility() {
  const connected = countConnected();
  const full = connected >= MAX_REMOTE_PEERS;
  el.cardPairing.classList.toggle('hidden', full);
  el.roomFullNote.classList.toggle('hidden', !full);
  el.joinWrap.classList.toggle('hidden', connected > 0);
  el.btnConnect.classList.toggle('hidden', connected > 0);
  el.pairEyebrowText.textContent = connected > 0 ? '邀請更多裝置' : '建立 / 加入房間';
  el.pairDesc.textContent = connected > 0
    ? '房間還沒滿，把代碼或 QR code 分享給下一台裝置，最多可到 6 人。'
    : '把房間代碼或 QR code 分享給大家，最多 6 台裝置可同時在房間內互傳。連上後每台裝置會與其他每台各開一條 WebRTC 連線。';
}
function updateDropCopy() {
  const n = countConnected();
  if (n > 0) {
    el.dropTitle.textContent = '選擇要傳送的檔案';
    el.dropSub.textContent = '檔案將同時傳送給所有已連線裝置（' + n + ' 台）· 點擊選擇或拖入 · 無大小限制';
  } else {
    el.dropTitle.textContent = '等待裝置加入房間';
    el.dropSub.textContent = '邀請其他裝置加入房間後，選擇檔案即會廣播給所有已連線裝置';
  }
}
function updateRoomStats() {
  const n = countConnected();
  el.statRoomCount.textContent = (n + 1) + ' / 6';
  el.statMyLinks.textContent = n + ' 條';
}
function refreshRoomUI() {
  updateStatusFromRoster();
  updatePairingVisibility();
  updateDropCopy();
  updateRoomStats();
  updateChatChrome();
}

/* ------------------------------------------------------------------ *
 *  Room / link / QR
 * ------------------------------------------------------------------ */
function shareLink() {
  return location.origin + location.pathname + '?room=' + roomCode;
}
function renderQR(text) {
  el.qr.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    const svg = el.qr.querySelector('svg');
    if (svg) {
      svg.style.width = '100%';
      svg.style.height = '100%';
      const path = svg.querySelector('path');
      if (path) path.setAttribute('fill', '#0e3d64');
      const bg = svg.querySelector('rect');
      if (bg) bg.setAttribute('fill', '#ffffff');
    }
  } catch (e) {
    console.warn('[p2p] QR render failed', e);
    el.qr.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font:600 11px/1.4 var(--font-mono);color:var(--muted);text-align:center;">QR<br>' + roomCode + '</div>';
  }
}
function updateRoomUI() {
  el.roomCode.textContent = roomCode;
  el.roomCodeEyebrow.textContent = roomCode;
  renderQR(shareLink());
  try {
    const url = new URL(location.href);
    url.searchParams.set('room', roomCode);
    history.replaceState(null, '', url);
  } catch (e) {}
}
let qrOpen = false;
function setQrOpen(open) {
  qrOpen = open;
  el.qrWrap.dataset.open = open ? 'true' : 'false';
  el.qrToggleLabel.textContent = open ? '隱藏 QR code' : '顯示 QR code';
}

/* ------------------------------------------------------------------ *
 *  Signaling (WebSocket room relay) — broadcasts to everyone in the
 *  room; `to` targets one peer, omitting it reaches the whole room.
 * ------------------------------------------------------------------ */
function sig(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    obj.v = 1; obj.from = myId;
    ws.send(JSON.stringify(obj));
  }
}
function connectSignaling(room) {
  wantConnected = true;
  closeWs();
  clearTimeout(wsReconnectTimer);
  setStatus('connecting');
  try {
    ws = new WebSocket(SIGNALING_BASE_URL + encodeURIComponent(room));
  } catch (e) {
    console.error('[p2p] ws construct failed', e);
    scheduleReconnect(room);
    return;
  }
  ws.onopen = () => {
    console.log('[p2p] signaling open, room=' + room);
    updateStatusFromRoster();
    sig({ kind: 'hello', name: myLabel });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || msg.from === myId) return;                 // ignore self / non-JSON
    if (msg.to && msg.to !== myId) return;                 // targeted at someone else
    onSignal(msg);
  };
  ws.onclose = () => {
    console.log('[p2p] signaling closed');
    if (wantConnected) scheduleReconnect(room);
  };
  ws.onerror = (e) => { console.warn('[p2p] signaling error', e); };
}
function closeWs() {
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
}
function scheduleReconnect(room) {
  if (countConnected() === 0) setStatus('offline');
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    if (wantConnected && room === roomCode) connectSignaling(room);
  }, 2000);
}

function isRoomFull() { return peers.size >= MAX_REMOTE_PEERS; }

function onSignal(msg) {
  switch (msg.kind) {
    case 'hello':     return handleHello(msg);
    case 'desc':      return handleDesc(msg);
    case 'ice':       return handleIce(msg);
    case 'bye':       return handleBye(msg);
    case 'room-full': return handleRoomFull(msg);
  }
}
function handleHello(msg) {
  const existing = peers.get(msg.from);
  if (existing) { if (msg.name) { existing.label = msg.name; updatePeerChip(existing); } return; }
  if (isRoomFull()) { sig({ kind: 'room-full', to: msg.from }); return; }
  setupPeer(msg.from, msg.name || '裝置');
  sig({ kind: 'hello', name: myLabel });   // re-announce so the new peer (and anyone else) learns us too
}
function handleDesc(msg) {
  let p = peers.get(msg.from);
  if (!p) {
    if (isRoomFull()) { sig({ kind: 'room-full', to: msg.from }); return; }
    p = setupPeer(msg.from, '裝置');
  }
  handleDescription(p, msg.description).catch(e => console.warn('[p2p] desc error', e));
}
function handleIce(msg) {
  let p = peers.get(msg.from);
  if (!p) {
    if (isRoomFull()) return;
    p = setupPeer(msg.from, '裝置');
  }
  handleCandidate(p, msg.candidate).catch(() => {});
}
function handleBye(msg) {
  const p = peers.get(msg.from);
  if (p) teardownPeer(p, '對方已離開房間');
}
function handleRoomFull(msg) {
  if (roomFullNoticeSeen.has(msg.from)) return;
  roomFullNoticeSeen.add(msg.from);
  toast('房間可能已滿（上限 6 人），部分裝置或許無法加入');
}

/* ------------------------------------------------------------------ *
 *  WebRTC — perfect negotiation, one RTCPeerConnection per peer
 * ------------------------------------------------------------------ */
function setupPeer(id, label) {
  const existing = peers.get(id);
  if (existing) return existing;

  const p = {
    id, label,
    pc: null, dc: null,
    polite: myId < id, makingOffer: false, ignoreOffer: false, pendingCandidates: [],
    connState: 'connecting', pal: nextPeerPal(), chipEl: null,
    pendingDecision: null, currentRecvId: null, negTimer: null,
    screenSender: null, screenTileEl: null,   // our screen-share track sent to this peer + their incoming tile
  };
  peers.set(id, p);

  p.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  p.pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await p.pc.setLocalDescription();
      sig({ kind: 'desc', to: p.id, description: p.pc.localDescription });
    } catch (e) {
      console.warn('[p2p] negotiation error', e);
    } finally {
      p.makingOffer = false;
    }
  };
  p.pc.onicecandidate = ({ candidate }) => {
    if (candidate) sig({ kind: 'ice', to: p.id, candidate });
  };
  p.pc.onconnectionstatechange = () => {
    const st = p.pc && p.pc.connectionState;
    console.log('[p2p] pc state (' + p.label + '):', st);
    if (st === 'failed') { toast(p.label + ' 連線失敗'); teardownPeer(p, p.label + ' 連線失敗'); }
  };
  p.pc.ondatachannel = (e) => setupDataChannel(p, e.channel);
  p.pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    renderRemoteScreenTile(p, stream);
    e.track.addEventListener('ended', () => removeRemoteScreenTile(p));
  };

  if (!p.polite) {                           // impolite peer initiates
    setupDataChannel(p, p.pc.createDataChannel('p2p-file', { ordered: true }));
  }

  p.negTimer = setTimeout(() => {
    if (p.connState !== 'connected') { toast(p.label + ' 連線逾時'); teardownPeer(p, null); }
  }, NEGOTIATION_TIMEOUT_MS);

  renderPeerChip(p);
  refreshRoomUI();
  return p;
}

async function handleDescription(p, desc) {
  if (!desc || !p.pc) return;
  const offerCollision = desc.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
  p.ignoreOffer = !p.polite && offerCollision;
  if (p.ignoreOffer) return;
  await p.pc.setRemoteDescription(desc);
  await flushCandidates(p);
  if (desc.type === 'offer') {
    await p.pc.setLocalDescription();
    sig({ kind: 'desc', to: p.id, description: p.pc.localDescription });
  }
}
async function handleCandidate(p, candidate) {
  if (!candidate || !p.pc) return;
  if (p.pc.remoteDescription && p.pc.remoteDescription.type) {
    try { await p.pc.addIceCandidate(candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
  } else {
    p.pendingCandidates.push(candidate);
  }
}
async function flushCandidates(p) {
  const list = p.pendingCandidates;
  p.pendingCandidates = [];
  for (const c of list) {
    try { await p.pc.addIceCandidate(c); } catch (e) {}
  }
}

/* ------------------------------------------------------------------ *
 *  Data channel + per-peer lifecycle
 * ------------------------------------------------------------------ */
function setupDataChannel(p, ch) {
  p.dc = ch;
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = BUFFER_LOW;
  ch.onopen = () => onPeerConnected(p);
  ch.onclose = () => teardownPeer(p, p.label + ' 連線已中斷');
  ch.onerror = (e) => console.warn('[p2p] dc error', e);
  ch.onmessage = (e) => onDcMessage(p, e.data);
}
function onPeerConnected(p) {
  clearTimeout(p.negTimer);
  p.connState = 'connected';
  updatePeerChip(p);
  toast('已與 ' + p.label + ' 建立連線');
  refreshRoomUI();
  if (localScreenStream) attachScreenTrackToPeer(p);
}
function teardownPeer(p, reason) {
  if (!peers.has(p.id)) return;
  clearTimeout(p.negTimer);
  if (p.dc) { p.dc.onopen = p.dc.onclose = p.dc.onerror = p.dc.onmessage = null; try { p.dc.close(); } catch (e) {} p.dc = null; }
  if (p.pc) { p.pc.onnegotiationneeded = p.pc.onicecandidate = p.pc.onconnectionstatechange = p.pc.ondatachannel = null; try { p.pc.close(); } catch (e) {} p.pc = null; }

  if (p.pendingDecision) { const pd = p.pendingDecision; p.pendingDecision = null; clearTimeout(pd.timer); pd.resolve('error'); }

  p.screenSender = null;
  removeRemoteScreenTile(p);

  failPeerTargets(p.id);
  for (const id in recvMap) {
    if (recvMap[id].peerId === p.id && !isTerminal(recvMap[id].status)) {
      recvMap[id].status = 'error';
      renderRow(recvMap[id]);
    }
  }
  removeIncomingFromPeer(p.id);

  peers.delete(p.id);
  removePeerChip(p);

  if (wantConnected && reason) toast(reason);
  updateStats();
  refreshRoomUI();
}
function teardownAllPeers() {
  for (const p of Array.from(peers.values())) teardownPeer(p, null);
}

/* ------------------------------------------------------------------ *
 *  Peer roster UI
 * ------------------------------------------------------------------ */
function peerChipHtml(p) {
  return (
    '<span style="width:30px;height:30px;flex:none;border-radius:9px;background:' + palette(p.pal) + ';display:flex;align-items:center;justify-content:center;">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2.4" stroke="#fff" stroke-width="1.9"/><path d="M10 18h4" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/></svg>' +
    '</span>' +
    '<span data-name style="flex:1;min-width:0;font:600 12.5px/1.2 var(--font-display);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>' +
    '<span data-dot style="position:absolute;top:8px;right:9px;width:9px;height:9px;border-radius:50%;"></span>'
  );
}
function renderPeerChip(p) {
  const node = document.createElement('div');
  node.setAttribute('data-peer-chip', p.id);
  node.style.cssText = 'position:relative;flex:1 1 132px;min-width:132px;display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:12px;background:var(--bg);border:1px solid var(--border);box-shadow:var(--shadow-card);animation:p2p-pop 0.3s ease both;';
  node.innerHTML = peerChipHtml(p);
  p.chipEl = node;
  el.peerRoster.appendChild(node);
  updatePeerChip(p);
}
function updatePeerChip(p) {
  if (!p.chipEl) return;
  el.noPeers.classList.toggle('hidden', peers.size > 0);
  p.chipEl.querySelector('[data-name]').textContent = p.label;
  const dot = p.chipEl.querySelector('[data-dot]');
  if (p.connState === 'connected') {
    dot.style.background = '#257e45';
    dot.style.boxShadow = '0 0 0 2px rgba(37,126,69,0.18)';
    dot.style.animation = 'none';
  } else {
    dot.style.background = '#a45a32';
    dot.style.boxShadow = 'none';
    dot.style.animation = 'ring 2s ease-out infinite';
  }
}
function removePeerChip(p) {
  if (p.chipEl && p.chipEl.parentNode) p.chipEl.parentNode.removeChild(p.chipEl);
  p.chipEl = null;
  el.noPeers.classList.toggle('hidden', peers.size > 0);
}

/* ------------------------------------------------------------------ *
 *  Transfer records + rendering
 *  `targets` = the other parties in this transfer: every connected
 *  peer for an outbound broadcast, or the single sender for an inbound
 *  receive — both directions share the same shape and render path.
 * ------------------------------------------------------------------ */
function createRecord(o) {
  const rec = {
    id: o.id || (myId + '-' + Date.now().toString(36) + '-' + files.length),
    name: o.name, size: o.size || 0, mime: o.mime || '',
    dir: o.dir, file: o.file || null, pal: files.length,
    targets: o.targets,             // [{peerId,label,status,sent,speed,_lastTs,_lastBytes}]
    transferred: 0, speed: 0,
    blobUrl: null, node: null, els: null,
  };
  files.push(rec);
  buildRow(rec);
  updateChrome();
  updateStats();
  return rec;
}
function syncAggregate(rec) {
  let sent = 0, speed = 0;
  for (const t of rec.targets) { sent += t.sent; speed += (t.speed || 0); }
  rec.transferred = sent;
  rec.speed = speed;
}
function isRecordTerminal(rec) { return rec.targets.every(t => isTerminal(t.status)); }

function buildRow(rec) {
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);box-shadow:var(--shadow-card);padding:15px 16px;animation:p2p-pop 0.35s ease both;';
  const dirColor = rec.dir === 'in' ? 'var(--purple)' : 'var(--navy)';
  const dirLabel = rec.dir === 'in' ? '接收' : '傳送';
  card.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;">' +
      '<div style="width:40px;height:40px;flex:none;border-radius:11px;background:' + palette(rec.pal) + ';display:flex;align-items:center;justify-content:center;">' +
        '<span style="font:700 10px/1 var(--font-mono);color:#fff;letter-spacing:0.02em;">' + escapeHtml(ext(rec.name)) + '</span>' +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="display:flex;align-items:center;gap:7px;">' +
          '<span style="font-weight:600;font-size:13.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(rec.name) + '</span>' +
          '<span style="flex:none;font:600 9px/1 var(--font-mono);color:' + dirColor + ';border:1px solid ' + dirColor + ';border-radius:5px;padding:2px 5px;">' + dirLabel + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:3px;">' +
          '<span data-meta style="font:500 11px/1 var(--font-mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>' +
          '<span data-status style="flex:none;font:600 11px/1 var(--font-mono);color:var(--muted);"></span>' +
        '</div>' +
      '</div>' +
      '<button data-dl class="hidden" style="flex:none;width:36px;height:36px;border-radius:10px;border:1px solid var(--border-strong);background:#fff;display:flex;align-items:center;justify-content:center;color:var(--navy);cursor:pointer;transition:all var(--transition);">' +
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 4v11M12 15l-4-4M12 15l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      '</button>' +
    '</div>' +
    '<div data-barwrap style="margin-top:11px;display:flex;align-items:center;gap:10px;">' +
      '<div style="flex:1;height:7px;border-radius:9999px;background:var(--bg);overflow:hidden;">' +
        '<div data-bar style="height:100%;border-radius:9999px;background:' + (rec.dir === 'in' ? 'var(--gradient-3)' : 'var(--gradient-1)') + ';width:0%;transition:width 0.15s linear;"></div>' +
      '</div>' +
      '<span data-pcttext style="flex:none;font:700 11px/1 var(--font-mono);min-width:34px;text-align:right;"></span>' +
    '</div>' +
    '<div data-peerdetail style="margin-top:9px;font:500 10.5px/1.6 var(--font-mono);color:var(--muted);word-break:break-word;display:none;"></div>';
  rec.node = card;
  rec.els = {
    meta: card.querySelector('[data-meta]'),
    status: card.querySelector('[data-status]'),
    bar: card.querySelector('[data-bar]'),
    barwrap: card.querySelector('[data-barwrap]'),
    pctText: card.querySelector('[data-pcttext]'),
    peerDetail: card.querySelector('[data-peerdetail]'),
    dl: card.querySelector('[data-dl]'),
  };
  rec.els.dl.addEventListener('click', (e) => { e.stopPropagation(); downloadReceived(rec); });
  el.fileList.insertBefore(card, el.fileList.firstChild);
  renderRow(rec);
}
function targetStatusText(t) {
  if (t.status === 'done') return '✓ 完成';
  if (t.status === 'rejected') return '已拒絕';
  if (t.status === 'error') return '中斷';
  if (t.status === 'sending') return Math.floor((t.sent / (t.size || 1)) * 100) + '%';
  return '等待中';
}
function renderRow(rec) {
  const e = rec.els; if (!e) return;
  syncAggregate(rec);
  const multi = rec.targets.length > 1;
  const totalSize = rec.size * rec.targets.length;
  const pct = totalSize ? Math.min(100, (rec.transferred / totalSize) * 100) : 0;
  const allDone = rec.targets.every(t => t.status === 'done');
  const anySending = rec.targets.some(t => t.status === 'sending');
  const allTerminal = isRecordTerminal(rec);
  const arrow = rec.dir === 'in' ? '← ' : '→ ';

  if (multi) {
    e.meta.textContent = arrow + '廣播 · ' + rec.targets.length + ' 人 · ' + fmt(rec.transferred) + ' / ' + fmt(totalSize);
  } else {
    const t = rec.targets[0];
    e.meta.textContent = arrow + t.label + ' · ' + fmt(t.sent) + ' / ' + fmt(rec.size);
  }

  let label, color;
  if (allDone) { label = '✓ 完成'; color = '#257e45'; }
  else if (allTerminal) {
    const done = rec.targets.filter(t => t.status === 'done').length;
    label = done + '/' + rec.targets.length + ' 完成'; color = '#a45a32';
  } else if (anySending) {
    const spd = rec.speed > 0 ? fmt(rec.speed) + '/s' : '';
    const remain = rec.speed > 0 ? Math.max(0, (totalSize - rec.transferred) / rec.speed) : 0;
    const eta = remain >= 1 ? ' · ' + (remain >= 60 ? Math.round(remain / 60) + '分' : Math.ceil(remain) + '秒') : '';
    label = (spd + eta).trim() || '傳輸中'; color = 'var(--blue)';
  } else { label = '等待中'; color = 'var(--muted)'; }
  e.status.textContent = label;
  e.status.style.color = color;

  e.barwrap.style.display = allTerminal ? 'none' : '';
  e.bar.style.width = pct.toFixed(1) + '%';
  e.pctText.textContent = anySending ? Math.floor(pct) + '%' : '';
  e.pctText.style.color = color;

  if (multi) {
    e.peerDetail.style.display = '';
    e.peerDetail.textContent = rec.targets.map(t => t.label + ' ' + targetStatusText(t)).join('  ·  ');
  } else {
    e.peerDetail.style.display = 'none';
  }

  e.dl.classList.toggle('hidden', !(rec.dir === 'in' && allDone));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let statsRaf = 0;
function updateStats() {
  if (statsRaf) return;
  statsRaf = requestAnimationFrame(() => {
    statsRaf = 0;
    let total = 0;
    for (const r of files) total += r.transferred;
    el.statTotal.textContent = fmt(total);
  });
}
function updateChrome() {
  const has = files.length > 0;
  el.emptyState.classList.toggle('hidden', has);
  el.btnClear.classList.toggle('hidden', !has);
}

/* progress throttling — per target, coalesced into a single row render */
function onTargetProgress(rec, target) {
  const now = performance.now();
  if (target._lastTs == null) { target._lastTs = now; target._lastBytes = 0; }
  const dt = now - target._lastTs;
  const done = target.sent >= rec.size;
  if (dt >= 120 || done) {
    target.speed = dt > 0 ? ((target.sent - target._lastBytes) / (dt / 1000)) : target.speed;
    target._lastTs = now; target._lastBytes = target.sent;
    renderRow(rec);
    updateStats();
  }
}

/* ------------------------------------------------------------------ *
 *  Sending (broadcast to every connected peer)
 * ------------------------------------------------------------------ */
function enqueueFiles(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;
  const recipients = Array.from(peers.values()).filter(p => p.dc && p.dc.readyState === 'open');
  if (!recipients.length) { toast('目前房間裡沒有已連線的裝置'); return; }
  for (const file of arr) {
    const rec = createRecord({
      dir: 'out', name: file.name, size: file.size, mime: file.type, file,
      targets: recipients.map(p => ({ peerId: p.id, label: p.label, status: 'waiting', sent: 0, speed: 0, _lastTs: null, _lastBytes: null, size: file.size })),
    });
    sendQueue.push(rec);
  }
  pumpSendQueue();
}
async function pumpSendQueue() {
  if (sending) return;
  sending = true;
  try {
    while (sendQueue.length) {
      const rec = sendQueue.shift();
      await sendBroadcast(rec);
    }
  } finally {
    sending = false;
  }
}
async function sendBroadcast(rec) {
  await Promise.allSettled(rec.targets.map(t => sendToTarget(rec, t)));
  renderRow(rec);
  updateStats();
}
async function sendToTarget(rec, target) {
  const p = peers.get(target.peerId);
  if (!p || !p.dc || p.dc.readyState !== 'open') { target.status = 'error'; renderRow(rec); return; }
  try {
    dcSendTo(p, JSON.stringify({ t: 'meta', id: rec.id, name: rec.name, size: rec.size, mime: rec.mime }));
    const decision = await waitDecision(p);
    if (decision !== 'accept') {
      target.status = decision === 'reject' ? 'rejected' : 'error';
      renderRow(rec);
      if (decision === 'reject') toast(p.label + ' 拒絕了 ' + rec.name);
      return;
    }
    target.status = 'sending'; renderRow(rec);
    dcSendTo(p, JSON.stringify({ t: 'begin', id: rec.id }));
    await streamFileToTarget(rec, target, p);
    dcSendTo(p, JSON.stringify({ t: 'end', id: rec.id }));
    target.sent = rec.size; target.status = 'done';
    renderRow(rec); updateStats();
  } catch (e) {
    console.warn('[p2p] send to ' + p.label + ' aborted', e);
    if (!isTerminal(target.status)) { target.status = 'error'; renderRow(rec); }
  }
}
function waitDecision(p) {
  return new Promise((resolve) => {
    const entry = {
      resolve: (v) => { clearTimeout(entry.timer); if (p.pendingDecision === entry) p.pendingDecision = null; resolve(v); },
      timer: null,
    };
    entry.timer = setTimeout(() => entry.resolve('error'), DECISION_TIMEOUT_MS);
    p.pendingDecision = entry;
  });
}
async function streamFileToTarget(rec, target, p) {
  const file = rec.file;
  let offset = 0;
  while (offset < file.size) {
    if (!p.dc || p.dc.readyState !== 'open') throw new Error('channel closed');
    if (p.dc.bufferedAmount > BUFFER_HIGH) { await drain(p.dc); continue; }
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const buf = await file.slice(offset, end).arrayBuffer();
    if (!p.dc || p.dc.readyState !== 'open') throw new Error('channel closed');
    p.dc.send(buf);
    offset = end;
    target.sent = offset;
    onTargetProgress(rec, target);
  }
}
function drain(dc) {
  return new Promise((resolve) => {
    if (!dc || dc.readyState !== 'open') return resolve();
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', done);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);  // buffer drained
    dc.addEventListener('close', done);              // ...or channel died — don't hang
  });
}
function dcSendTo(p, data) {
  if (p && p.dc && p.dc.readyState === 'open') p.dc.send(data);
}
function failPeerTargets(peerId) {
  for (const rec of files) {
    if (rec.dir !== 'out') continue;
    let touched = false;
    for (const t of rec.targets) {
      if (t.peerId === peerId && !isTerminal(t.status)) { t.status = 'error'; touched = true; }
    }
    if (touched) renderRow(rec);
  }
  updateStats();
}

/* ------------------------------------------------------------------ *
 *  Receiving
 * ------------------------------------------------------------------ */
function onDcMessage(p, data) {
  if (typeof data === 'string') {
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    onControl(p, msg);
  } else {
    const rec = p.currentRecvId ? recvMap[p.currentRecvId] : null;
    if (!rec) return;
    const buf = data instanceof ArrayBuffer ? data : null;
    if (!buf) return;
    const target = rec.targets[0];
    rec._chunks.push(buf);
    target.sent += buf.byteLength;
    onTargetProgress(rec, target);
  }
}
function onControl(p, msg) {
  switch (msg.t) {
    case 'meta':
      incomingQueue.push({ peerId: p.id, peerLabel: p.label, id: msg.id, name: msg.name, size: msg.size, mime: msg.mime });
      maybeShowIncoming();
      break;
    case 'accept':
    case 'reject':
      if (p.pendingDecision) { const pd = p.pendingDecision; p.pendingDecision = null; clearTimeout(pd.timer); pd.resolve(msg.t); }
      break;
    case 'begin':
      p.currentRecvId = msg.id;
      break;
    case 'end':
      finalizeReceive(p, msg.id);
      break;
    case 'chat':
      receiveChat(p, msg.text);
      break;
    case 'screen-start':
      toast(p.label + ' 開始分享畫面');
      break;
    case 'screen-stop':
      toast(p.label + ' 已停止分享畫面');
      removeRemoteScreenTile(p);
      break;
  }
}
function maybeShowIncoming() {
  if (activeIncoming || !incomingQueue.length) return;
  activeIncoming = incomingQueue.shift();
  el.incName.textContent = activeIncoming.name;
  el.incSize.textContent = fmt(activeIncoming.size);
  el.incExt.textContent = ext(activeIncoming.name);
  el.incIcon.style.background = palette(files.length);
  el.peerNameModal.textContent = activeIncoming.peerLabel;
  el.modal.classList.remove('hidden');
}
function acceptIncoming() {
  const inc = activeIncoming; if (!inc) return;
  const p = peers.get(inc.peerId);
  activeIncoming = null;
  el.modal.classList.add('hidden');
  if (!p) { maybeShowIncoming(); return; }
  dcSendTo(p, JSON.stringify({ t: 'accept', id: inc.id }));
  const rec = createRecord({
    dir: 'in', id: inc.id, name: inc.name, size: inc.size, mime: inc.mime,
    targets: [{ peerId: p.id, label: p.label, status: 'sending', sent: 0, speed: 0, _lastTs: null, _lastBytes: null, size: inc.size }],
  });
  rec._chunks = [];
  recvMap[inc.id] = rec;
  p.currentRecvId = inc.id;
  renderRow(rec);
  if (activeTab !== 'files') { fileUnread++; renderTabBadges(); }
  maybeShowIncoming();
}
function rejectIncoming() {
  const inc = activeIncoming; if (!inc) return;
  const p = peers.get(inc.peerId);
  activeIncoming = null;
  el.modal.classList.add('hidden');
  if (p) dcSendTo(p, JSON.stringify({ t: 'reject', id: inc.id }));
  maybeShowIncoming();
}
function removeIncomingFromPeer(peerId) {
  for (let i = incomingQueue.length - 1; i >= 0; i--) {
    if (incomingQueue[i].peerId === peerId) incomingQueue.splice(i, 1);
  }
  if (activeIncoming && activeIncoming.peerId === peerId) {
    activeIncoming = null;
    el.modal.classList.add('hidden');
    maybeShowIncoming();
  }
}
function finalizeReceive(p, id) {
  const rec = recvMap[id]; if (!rec) return;
  const blob = new Blob(rec._chunks, { type: rec.mime || 'application/octet-stream' });
  rec.blobUrl = URL.createObjectURL(blob);
  rec._chunks = [];
  const target = rec.targets[0];
  target.sent = rec.size || blob.size;
  target.status = 'done';
  renderRow(rec); updateStats();
  if (p.currentRecvId === id) p.currentRecvId = null;
  delete recvMap[id];
  toast('已收到 ' + rec.name);
}
function downloadReceived(rec) {
  if (!rec.blobUrl) return;
  const a = document.createElement('a');
  a.href = rec.blobUrl; a.download = rec.name;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ------------------------------------------------------------------ *
 *  Clear done
 * ------------------------------------------------------------------ */
function clearDone() {
  for (let i = files.length - 1; i >= 0; i--) {
    const r = files[i];
    if (isRecordTerminal(r)) {
      if (r.blobUrl) { try { URL.revokeObjectURL(r.blobUrl); } catch (e) {} }
      if (r.node && r.node.parentNode) r.node.parentNode.removeChild(r.node);
      files.splice(i, 1);
    }
  }
  updateChrome();
  updateStats();
}

/* ------------------------------------------------------------------ *
 *  Tabs (file transfer / messages) + unread badges
 * ------------------------------------------------------------------ */
function styleTab(btn, active) {
  btn.style.background = active ? 'var(--gradient-1)' : 'transparent';
  btn.style.color = active ? '#fff' : 'var(--muted)';
  btn.style.boxShadow = active ? '0 6px 14px -8px rgba(14,61,100,0.55)' : 'none';
}
function renderTabBadges() {
  const showChat = unread > 0 && activeTab !== 'chat';
  el.badgeChat.classList.toggle('hidden', !showChat);
  el.badgeChat.textContent = unread > 9 ? '9+' : String(unread);
  const showFiles = fileUnread > 0 && activeTab !== 'files';
  el.badgeFiles.classList.toggle('hidden', !showFiles);
  el.badgeFiles.textContent = fileUnread > 9 ? '9+' : String(fileUnread);
  const showScreen = screenUnread > 0 && activeTab !== 'screen';
  el.badgeScreen.classList.toggle('hidden', !showScreen);
  el.badgeScreen.textContent = screenUnread > 9 ? '9+' : String(screenUnread);
}
function setActiveTab(tab) {
  activeTab = tab;
  const filesActive = tab === 'files';
  const chatActive = tab === 'chat';
  const screenActive = tab === 'screen';
  styleTab(el.tabFiles, filesActive);
  styleTab(el.tabChat, chatActive);
  styleTab(el.tabScreen, screenActive);
  el.panelFiles.classList.toggle('hidden', !filesActive);
  el.panelChat.classList.toggle('hidden', !chatActive);
  el.panelScreen.classList.toggle('hidden', !screenActive);
  if (filesActive) fileUnread = 0;
  else if (chatActive) { unread = 0; scrollChatToBottom(); }
  else if (screenActive) { screenUnread = 0; }
  renderTabBadges();
}

/* ------------------------------------------------------------------ *
 *  Chat / clipboard — plain-text messages broadcast over the same
 *  DataChannel mesh as files (JSON control message `t:'chat'`). No
 *  history is persisted; the log lives only in memory for this room.
 * ------------------------------------------------------------------ */
function updateChatChrome() {
  const connected = countConnected() > 0;
  el.chatInputRow.classList.toggle('hidden', !connected);
  el.chatOffline.classList.toggle('hidden', connected);
  const emptyInner = el.chatEmpty.firstElementChild;
  if (emptyInner) emptyInner.textContent = connected
    ? '還沒有訊息 · 貼上文字即可跨裝置共用'
    : '加入房間後即可開始傳訊息';
  el.chatEmpty.classList.toggle('hidden', messages.length > 0);
  el.msgCount.textContent = messages.length ? messages.length + ' 則訊息' : '尚無訊息';
}
function scrollChatToBottom() {
  requestAnimationFrame(() => { el.chatList.scrollTop = el.chatList.scrollHeight; });
}
function renderMessage(m) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:' + (m.mine ? 'flex-end' : 'flex-start') + ';gap:3px;animation:p2p-pop 0.25s ease both;';
  const head = document.createElement('span');
  head.style.cssText = 'font:600 10px/1 var(--font-mono);color:var(--muted);letter-spacing:0.02em;padding:0 4px;';
  head.textContent = (m.mine ? '我' : m.from) + ' · ' + m.time;
  const bubble = document.createElement('div');
  bubble.style.cssText = 'max-width:82%;position:relative;padding:10px 13px;border-radius:14px;background:' +
    (m.mine ? 'var(--gradient-1)' : 'var(--bg)') + ';border:1px solid ' + (m.mine ? 'transparent' : 'var(--border)') + ';';
  const body = document.createElement('div');
  body.style.cssText = 'font:500 13px/1.5 ' + (m.mono ? 'var(--font-mono)' : 'var(--font-display)') +
    ';color:' + (m.mine ? '#ffffff' : 'var(--ink)') + ';white-space:pre-wrap;word-break:break-word;';
  body.textContent = m.text;               // textContent — never inject chat text as HTML
  const copyBtn = document.createElement('button');
  copyBtn.style.cssText = 'margin-top:7px;display:inline-flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0;font:600 10px/1 var(--font-mono);color:' + (m.mine ? 'rgba(255,255,255,0.82)' : 'var(--muted)') + ';';
  copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.9"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg><span>複製</span>';
  const lbl = copyBtn.querySelector('span');
  copyBtn.addEventListener('click', async () => {
    await copyText(m.text);
    lbl.textContent = '已複製';
    clearTimeout(m._ct);
    m._ct = setTimeout(() => { lbl.textContent = '複製'; }, 1500);
  });
  bubble.appendChild(body);
  bubble.appendChild(copyBtn);
  wrap.appendChild(head);
  wrap.appendChild(bubble);
  m.node = wrap;
  el.chatList.appendChild(wrap);
}
function addMessage(m) {
  messages.push(m);
  renderMessage(m);
  updateChatChrome();
  scrollChatToBottom();
}
function sendChat() {
  const text = el.chatDraft.value.trim();
  if (!text) return;
  const recipients = Array.from(peers.values()).filter(p => p.dc && p.dc.readyState === 'open');
  if (!recipients.length) { toast('目前房間裡沒有已連線的裝置'); return; }
  const clipped = text.slice(0, CHAT_MAX_LEN);
  for (const p of recipients) dcSendTo(p, JSON.stringify({ t: 'chat', text: clipped }));
  el.chatDraft.value = '';
  autoResizeDraft();
  addMessage({ id: 'm' + Date.now(), mine: true, from: '我', text: clipped, time: nowHM(), mono: looksMono(clipped) });
}
function receiveChat(p, text) {
  if (typeof text !== 'string') return;
  text = text.slice(0, CHAT_MAX_LEN);
  if (!text) return;
  addMessage({ id: 'm' + Date.now() + '-' + p.id, mine: false, from: p.label, text, time: nowHM(), mono: looksMono(text) });
  if (activeTab !== 'chat') { unread++; renderTabBadges(); }
}
function autoResizeDraft() {
  el.chatDraft.style.height = 'auto';
  el.chatDraft.style.height = Math.min(120, el.chatDraft.scrollHeight) + 'px';
}
function clearChat() {
  for (const m of messages) {
    clearTimeout(m._ct);
    if (m.node && m.node.parentNode) m.node.parentNode.removeChild(m.node);
  }
  messages.length = 0;
  unread = 0;
  fileUnread = 0;
  updateChatChrome();
  setActiveTab('files');
}

/* ------------------------------------------------------------------ *
 *  Screen share — one local getDisplayMedia() stream, its video track
 *  added as a sender to every connected peer's RTCPeerConnection (this
 *  reuses the perfect-negotiation renegotiation path in setupPeer's
 *  onnegotiationneeded — no protocol changes needed there). Incoming
 *  shares arrive via pc.ontrack and render as tiles keyed by peer.
 * ------------------------------------------------------------------ */
function updateScreenChrome() {
  const sharing = !!localScreenStream;
  el.screenShareLabel.textContent = sharing ? '停止分享畫面' : '分享我的螢幕畫面';
  el.btnScreenShare.classList.toggle('btn-outline', sharing);
  el.btnScreenShare.classList.toggle('btn-primary', !sharing);
  const hasTiles = el.screenGrid.children.length > 0;
  el.screenEmpty.classList.toggle('hidden', hasTiles);
  renderTabBadges();
}
function screenTileHtml(label, muted) {
  return (
    '<div style="position:relative;border-radius:12px;overflow:hidden;background:#0e1622;aspect-ratio:16/9;">' +
      '<video autoplay playsinline' + (muted ? ' muted' : '') + ' style="width:100%;height:100%;object-fit:contain;display:block;background:#0e1622;"></video>' +
      '<span style="position:absolute;left:8px;bottom:8px;padding:3px 9px;border-radius:9999px;background:rgba(14,22,34,0.72);color:#fff;font:600 10.5px/1.4 var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:calc(100% - 16px);"></span>' +
    '</div>'
  );
}
let localScreenTileEl = null;
function renderLocalScreenTile() {
  if (localScreenTileEl) return;
  const node = document.createElement('div');
  node.innerHTML = screenTileHtml('我（分享中）', true);
  const wrap = node.firstElementChild;
  wrap.querySelector('video').srcObject = localScreenStream;
  wrap.querySelector('span').textContent = '我（分享中）';
  localScreenTileEl = wrap;
  el.screenGrid.appendChild(wrap);
  updateScreenChrome();
}
function removeLocalScreenTile() {
  if (localScreenTileEl && localScreenTileEl.parentNode) localScreenTileEl.parentNode.removeChild(localScreenTileEl);
  localScreenTileEl = null;
  updateScreenChrome();
}
function renderRemoteScreenTile(p, stream) {
  if (!p.screenTileEl) {
    const node = document.createElement('div');
    node.innerHTML = screenTileHtml(p.label, true);
    p.screenTileEl = node.firstElementChild;
    el.screenGrid.appendChild(p.screenTileEl);
    if (activeTab !== 'screen') { screenUnread++; }
  }
  p.screenTileEl.querySelector('span').textContent = p.label;
  p.screenTileEl.querySelector('video').srcObject = stream;
  updateScreenChrome();
}
function removeRemoteScreenTile(p) {
  if (!p.screenTileEl) return;
  if (p.screenTileEl.parentNode) p.screenTileEl.parentNode.removeChild(p.screenTileEl);
  p.screenTileEl = null;
  updateScreenChrome();
}
function attachScreenTrackToPeer(p) {
  if (!localScreenStream || !p.pc || p.screenSender) return;
  const track = localScreenStream.getVideoTracks()[0];
  if (!track) return;
  try {
    p.screenSender = p.pc.addTrack(track, localScreenStream);
    dcSendTo(p, JSON.stringify({ t: 'screen-start' }));
  } catch (e) {
    console.warn('[p2p] addTrack failed for ' + p.label, e);
  }
}
function detachScreenTrackFromPeer(p) {
  if (!p.screenSender) return;
  if (p.pc) { try { p.pc.removeTrack(p.screenSender); } catch (e) {} }
  p.screenSender = null;
  dcSendTo(p, JSON.stringify({ t: 'screen-stop' }));
}
async function startScreenShare() {
  if (localScreenStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('此瀏覽器不支援畫面分享');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    return; // user cancelled the picker — not an error
  }
  localScreenStream = stream;
  const track = stream.getVideoTracks()[0];
  if (track) track.addEventListener('ended', stopScreenShare); // native "Stop sharing" UI
  renderLocalScreenTile();
  for (const p of peers.values()) {
    if (p.dc && p.dc.readyState === 'open') attachScreenTrackToPeer(p);
  }
  toast('已開始分享螢幕畫面');
}
function stopScreenShare() {
  if (!localScreenStream) return;
  for (const p of peers.values()) detachScreenTrackFromPeer(p);
  localScreenStream.getTracks().forEach(t => t.stop());
  localScreenStream = null;
  removeLocalScreenTile();
  toast('已停止分享螢幕畫面');
}
function toggleScreenShare() {
  if (localScreenStream) stopScreenShare();
  else startScreenShare();
}

/* ------------------------------------------------------------------ *
 *  Room actions
 * ------------------------------------------------------------------ */
function joinRoom(code) {
  code = sanitizeCode(code);
  if (!code) return;
  stopScreenShare();
  teardownAllPeers();
  clearChat();
  roomCode = code;
  updateRoomUI();
  el.joinInput.value = '';
  refreshConnectBtn();
  connectSignaling(roomCode);
  toast('正在加入房間 ' + roomCode);
}
function disconnect() {
  sig({ kind: 'bye' });
  stopScreenShare();
  teardownAllPeers();
  clearChat();
  roomCode = genCode();          // fresh room so old peers can't rejoin
  roomFullNoticeSeen.clear();
  updateRoomUI();
  connectSignaling(roomCode);
}
function refreshConnectBtn() {
  const code = sanitizeCode(el.joinInput.value);
  if (code) {
    el.btnConnect.disabled = false;
    el.connectLabel.textContent = '加入房間 ' + code;
  } else {
    el.btnConnect.disabled = true;
    el.connectLabel.textContent = '輸入代碼以加入房間';
  }
}

/* ------------------------------------------------------------------ *
 *  Event wiring
 * ------------------------------------------------------------------ */
el.btnCopy.addEventListener('click', async () => {
  await copyText(shareLink());
  el.copyLabel.textContent = '已複製連結';
  el.copyLabel.style.color = '#257e45';
  setTimeout(() => { el.copyLabel.textContent = '複製連結'; el.copyLabel.style.color = 'var(--muted)'; }, 1600);
});

el.tabFiles.addEventListener('click', () => setActiveTab('files'));
el.tabChat.addEventListener('click', () => setActiveTab('chat'));
el.tabScreen.addEventListener('click', () => setActiveTab('screen'));
el.btnScreenShare.addEventListener('click', toggleScreenShare);
el.btnSend.addEventListener('click', sendChat);
el.chatDraft.addEventListener('input', autoResizeDraft);
el.chatDraft.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

el.btnQrToggle.addEventListener('click', () => setQrOpen(!qrOpen));

el.joinInput.addEventListener('input', () => {
  const s = sanitizeCode(el.joinInput.value);
  if (el.joinInput.value !== s) el.joinInput.value = s;
  refreshConnectBtn();
});
el.joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.btnConnect.click(); });
el.btnConnect.addEventListener('click', () => {
  const code = sanitizeCode(el.joinInput.value);
  if (code) joinRoom(code);
});
el.btnDisconnect.addEventListener('click', disconnect);
el.btnClear.addEventListener('click', clearDone);
el.btnAccept.addEventListener('click', acceptIncoming);
el.btnReject.addEventListener('click', rejectIncoming);

el.dropzone.addEventListener('click', () => {
  if (countConnected() > 0) el.fileInput.click();
  else { toast('請先邀請裝置加入房間'); el.joinInput.focus(); }
});
el.fileInput.addEventListener('change', (e) => { enqueueFiles(e.target.files); e.target.value = ''; });
el.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropzone.style.borderColor = 'var(--blue)';
  el.dropzone.style.background = 'rgba(59,82,196,0.06)';
});
el.dropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  el.dropzone.style.borderColor = 'var(--border-strong)';
  el.dropzone.style.background = 'var(--surface)';
});
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.style.borderColor = 'var(--border-strong)';
  el.dropzone.style.background = 'var(--surface)';
  enqueueFiles(e.dataTransfer.files);
});
// prevent the browser from opening files dropped outside the zone
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('beforeunload', () => { wantConnected = false; sig({ kind: 'bye' }); closeWs(); });

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */
(function init() {
  const params = new URLSearchParams(location.search);
  const fromUrl = sanitizeCode(params.get('room') || '');
  roomCode = fromUrl || genCode();
  updateRoomUI();
  refreshConnectBtn();
  connectSignaling(roomCode);
  refreshRoomUI();
})();
