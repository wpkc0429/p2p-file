/* ===================================================================
   空投 P2P Drop — browser peer-to-peer file transfer
   Real WebRTC DataChannel transfers, paired through a room-relay
   signaling server. No server storage, no file-size limit.
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

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const myId      = randomId(12);
const myLabel   = deviceLabel();
let   roomCode  = '----';
let   ws        = null;
let   wsReconnectTimer = null;
let   wantConnected = false;          // should the ws be open?

let   pc        = null;
let   dc        = null;
let   peerId    = null;
let   peerLabel = '對方裝置';
let   polite    = false;
let   makingOffer = false;
let   ignoreOffer = false;
let   pendingCandidates = [];

const files     = [];                 // all transfer records (in + out)
const sendQueue = [];                 // outgoing records awaiting send
let   sending   = false;
let   pendingDecision = null;         // { id, resolve, reject } for current outgoing offer

const recvMap   = Object.create(null);// id -> incoming record
let   currentRecvId = null;
const incomingQueue = [];             // pending {id,name,size,mime} awaiting modal
let   activeIncoming = null;

/* ------------------------------------------------------------------ *
 *  DOM refs
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const el = {
  statusDot: $('status-dot'), statusText: $('status-text'),
  cardPairing: $('card-pairing'), cardConnected: $('card-connected'),
  qr: $('qr'), qrWrap: $('qr-wrap'), roomCode: $('room-code'), btnCopy: $('btn-copy'), copyLabel: $('copy-label'),
  btnQrToggle: $('btn-qr-toggle'), qrToggleLabel: $('qr-toggle-label'),
  joinInput: $('join-input'), btnConnect: $('btn-connect'), connectLabel: $('connect-label'),
  btnDisconnect: $('btn-disconnect'), peerName: $('peer-name'), peerNameModal: $('peer-name-modal'),
  statTotal: $('stat-total'), statCount: $('stat-count'),
  dropzone: $('dropzone'), dropTitle: $('drop-title'), fileInput: $('file-input'),
  btnClear: $('btn-clear'), emptyState: $('empty-state'), fileList: $('file-list'),
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

/* ------------------------------------------------------------------ *
 *  Status + card UI
 * ------------------------------------------------------------------ */
const STATUS = {
  offline:    ['#c26a3b', '離線'],
  connecting: ['#3b52c4', '連線中…'],
  waiting:    ['#c26a3b', '等待對方'],
  paired:     ['#3b52c4', '配對中…'],
  connected:  ['#2f9e57', '已連線'],
};
let statusKey = 'connecting';
function setStatus(key) {
  statusKey = key;
  const [color, text] = STATUS[key] || STATUS.offline;
  el.statusDot.style.background = color;
  el.statusText.style.color = color;
  el.statusText.textContent = text;
  const connected = key === 'connected';
  el.cardConnected.classList.toggle('hidden', !connected);
  el.cardPairing.classList.toggle('hidden', connected);
  el.dropTitle.textContent = connected ? '選擇要傳送的檔案' : '完成配對後即可傳檔';
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
let qrOpen = false;
function setQrOpen(open) {
  qrOpen = open;
  el.qrWrap.dataset.open = open ? 'true' : 'false';
  el.qrToggleLabel.textContent = open ? '隱藏 QR code' : '顯示 QR code';
}
function updateRoomUI() {
  el.roomCode.textContent = roomCode;
  renderQR(shareLink());
  try {
    const url = new URL(location.href);
    url.searchParams.set('room', roomCode);
    history.replaceState(null, '', url);
  } catch (e) {}
}

/* ------------------------------------------------------------------ *
 *  Signaling (WebSocket room relay)
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
    if (!peerId) setStatus('waiting');
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
  if (statusKey !== 'connected') setStatus('offline');
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    if (wantConnected && room === roomCode) connectSignaling(room);
  }, 2000);
}

function onSignal(msg) {
  if (msg.kind === 'hello') {
    if (msg.name) peerLabel = msg.name;
    if (!peerId) {
      peerId = msg.from;
      setupPeer();
      sig({ kind: 'hello', name: myLabel });   // re-announce so an earlier peer learns us
    }
  } else if (msg.kind === 'desc') {
    if (!peerId) { peerId = msg.from; setupPeer(); }
    handleDescription(msg.description).catch(e => console.warn('[p2p] desc error', e));
  } else if (msg.kind === 'ice') {
    if (!peerId) { peerId = msg.from; setupPeer(); }
    handleCandidate(msg.candidate).catch(() => {});
  } else if (msg.kind === 'bye') {
    if (msg.from === peerId) handlePeerGone('對方已離開房間');
  }
}

/* ------------------------------------------------------------------ *
 *  WebRTC — perfect negotiation
 * ------------------------------------------------------------------ */
function setupPeer() {
  if (pc) return;
  polite = myId < peerId;                    // deterministic, opposite on each side
  setStatus('paired');
  if (el.peerName) el.peerName.textContent = peerLabel;
  if (el.peerNameModal) el.peerNameModal.textContent = peerLabel;

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pendingCandidates = [];

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      sig({ kind: 'desc', to: peerId, description: pc.localDescription });
    } catch (e) {
      console.warn('[p2p] negotiation error', e);
    } finally {
      makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sig({ kind: 'ice', to: peerId, candidate });
  };
  pc.onconnectionstatechange = () => {
    const st = pc && pc.connectionState;
    console.log('[p2p] pc state:', st);
    if (st === 'failed') { toast('連線失敗，請重新配對'); handlePeerGone(); }
  };
  pc.ondatachannel = (e) => setupDataChannel(e.channel);

  if (!polite) {                             // impolite peer initiates
    setupDataChannel(pc.createDataChannel('p2p-file', { ordered: true }));
  }
}

async function handleDescription(desc) {
  if (!desc || !pc) return;
  const offerCollision = desc.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
  ignoreOffer = !polite && offerCollision;
  if (ignoreOffer) return;
  await pc.setRemoteDescription(desc);
  await flushCandidates();
  if (desc.type === 'offer') {
    await pc.setLocalDescription();
    sig({ kind: 'desc', to: peerId, description: pc.localDescription });
  }
}
async function handleCandidate(candidate) {
  if (!candidate || !pc) return;
  if (pc.remoteDescription && pc.remoteDescription.type) {
    try { await pc.addIceCandidate(candidate); } catch (e) { if (!ignoreOffer) throw e; }
  } else {
    pendingCandidates.push(candidate);
  }
}
async function flushCandidates() {
  const list = pendingCandidates;
  pendingCandidates = [];
  for (const c of list) {
    try { await pc.addIceCandidate(c); } catch (e) {}
  }
}

/* ------------------------------------------------------------------ *
 *  Data channel + connection lifecycle
 * ------------------------------------------------------------------ */
function setupDataChannel(ch) {
  dc = ch;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUFFER_LOW;
  dc.onopen = onConnected;
  dc.onclose = () => handlePeerGone('連線已中斷');
  dc.onerror = (e) => console.warn('[p2p] dc error', e);
  dc.onmessage = (e) => onDcMessage(e.data);
}
function onConnected() {
  setStatus('connected');
  el.peerName.textContent = peerLabel;
  el.peerNameModal.textContent = peerLabel;
  toast('已與 ' + peerLabel + ' 建立連線');
  pumpSendQueue();
}
function handlePeerGone(message) {
  const wasConnected = statusKey === 'connected' || statusKey === 'paired';
  teardownPeer();
  if (wantConnected) {
    setStatus('waiting');
    if (wasConnected && message) toast(message);
  }
}
function teardownPeer() {
  if (dc) { dc.onopen = dc.onclose = dc.onerror = dc.onmessage = null; try { dc.close(); } catch (e) {} dc = null; }
  if (pc) { pc.onnegotiationneeded = pc.onicecandidate = pc.onconnectionstatechange = pc.ondatachannel = null; try { pc.close(); } catch (e) {} pc = null; }
  peerId = null; makingOffer = false; ignoreOffer = false; pendingCandidates = [];

  if (pendingDecision) { const p = pendingDecision; pendingDecision = null; p.reject(new Error('disconnected')); }
  sendQueue.length = 0;
  currentRecvId = null;
  for (const k in recvMap) delete recvMap[k];
  incomingQueue.length = 0; activeIncoming = null; el.modal.classList.add('hidden');

  for (const rec of files) {
    if (rec.status === 'sending' || rec.status === 'receiving' || rec.status === 'waiting') {
      rec.status = 'error';
      renderRow(rec);
    }
  }
  updateStats();
}

/* ------------------------------------------------------------------ *
 *  Transfer records + rendering
 * ------------------------------------------------------------------ */
function createRecord(o) {
  const rec = {
    id: o.id || (myId + '-' + Date.now().toString(36) + '-' + files.length),
    name: o.name, size: o.size || 0, mime: o.mime || '',
    dir: o.dir, status: o.dir === 'out' ? 'waiting' : 'receiving',
    transferred: 0, file: o.file || null, pal: files.length,
    chunks: o.dir === 'in' ? [] : null, blobUrl: null,
    speed: 0, node: null, els: null,
  };
  files.push(rec);
  buildRow(rec);
  updateChrome();
  updateStats();
  return rec;
}
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
          '<span data-meta style="font:500 11px/1 var(--font-mono);color:var(--muted);"></span>' +
          '<span data-status style="font:600 11px/1 var(--font-mono);color:var(--muted);"></span>' +
        '</div>' +
      '</div>' +
      '<button data-dl class="hidden" style="flex:none;width:36px;height:36px;border-radius:10px;border:1px solid var(--border-strong);background:#fff;display:flex;align-items:center;justify-content:center;color:var(--navy);cursor:pointer;transition:all var(--transition);">' +
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 4v11M12 15l-4-4M12 15l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      '</button>' +
    '</div>' +
    '<div data-barwrap style="margin-top:11px;height:7px;border-radius:9999px;background:var(--bg);overflow:hidden;">' +
      '<div data-bar style="height:100%;border-radius:9999px;background:' + (rec.dir === 'in' ? 'var(--gradient-3)' : 'var(--gradient-1)') + ';width:0%;transition:width 0.15s linear;"></div>' +
    '</div>';
  rec.node = card;
  rec.els = {
    meta: card.querySelector('[data-meta]'),
    status: card.querySelector('[data-status]'),
    bar: card.querySelector('[data-bar]'),
    barwrap: card.querySelector('[data-barwrap]'),
    dl: card.querySelector('[data-dl]'),
  };
  rec.els.dl.addEventListener('click', (e) => { e.stopPropagation(); downloadReceived(rec); });
  el.fileList.insertBefore(card, el.fileList.firstChild);
  renderRow(rec);
}
function renderRow(rec) {
  const e = rec.els; if (!e) return;
  const pct = rec.size ? Math.min(100, (rec.transferred / rec.size) * 100) : 0;
  e.meta.textContent = fmt(rec.transferred) + ' / ' + fmt(rec.size);

  let label = '等待中', color = 'var(--muted)';
  if (rec.status === 'done') { label = '✓ 完成'; color = '#2f9e57'; }
  else if (rec.status === 'rejected') { label = '已拒絕'; color = '#c26a3b'; }
  else if (rec.status === 'error') { label = '中斷'; color = '#c26a3b'; }
  else if (rec.status === 'sending' || rec.status === 'receiving') {
    label = Math.floor(pct) + '%';
    if (rec.speed > 0) {
      label += ' · ' + fmt(rec.speed) + '/s';
      const remain = (rec.size - rec.transferred) / rec.speed;
      if (remain >= 1) label += ' · ' + (remain >= 60 ? Math.round(remain / 60) + '分' : Math.ceil(remain) + '秒');
    }
    color = 'var(--blue)';
  }
  e.status.textContent = label;
  e.status.style.color = color;

  const terminal = rec.status === 'done' || rec.status === 'rejected' || rec.status === 'error';
  e.barwrap.style.display = terminal ? 'none' : '';
  e.bar.style.width = pct.toFixed(1) + '%';
  e.dl.classList.toggle('hidden', !(rec.dir === 'in' && rec.status === 'done'));
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
    el.statCount.textContent = String(files.length);
  });
}
function updateChrome() {
  const has = files.length > 0;
  el.emptyState.classList.toggle('hidden', has);
  el.btnClear.classList.toggle('hidden', !has);
}

/* progress throttling */
function onProgress(rec) {
  const now = performance.now();
  if (rec._lastTs == null) { rec._lastTs = now; rec._lastBytes = 0; }
  const dt = now - rec._lastTs;
  const done = rec.transferred >= rec.size;
  if (dt >= 120 || done) {
    rec.speed = dt > 0 ? ((rec.transferred - rec._lastBytes) / (dt / 1000)) : rec.speed;
    rec._lastTs = now; rec._lastBytes = rec.transferred;
    renderRow(rec);
    updateStats();
  }
}

/* ------------------------------------------------------------------ *
 *  Sending
 * ------------------------------------------------------------------ */
function enqueueFiles(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;
  if (!dc || dc.readyState !== 'open') { toast('請先與對方建立連線'); return; }
  for (const file of arr) {
    const rec = createRecord({ dir: 'out', name: file.name, size: file.size, mime: file.type, file });
    sendQueue.push(rec);
  }
  pumpSendQueue();
}
async function pumpSendQueue() {
  if (sending) return;
  sending = true;
  try {
    while (sendQueue.length && dc && dc.readyState === 'open') {
      const rec = sendQueue.shift();
      try { await sendOne(rec); }
      catch (e) {
        console.warn('[p2p] send aborted', e);
        if (rec.status !== 'done' && rec.status !== 'rejected') { rec.status = 'error'; renderRow(rec); }
      }
    }
  } finally {
    sending = false;
  }
}
function sendOne(rec) {
  return new Promise(async (resolve, reject) => {
    try {
      dcSend(JSON.stringify({ t: 'meta', id: rec.id, name: rec.name, size: rec.size, mime: rec.mime }));
      const decision = await waitDecision(rec.id);
      if (decision === 'reject') {
        rec.status = 'rejected'; renderRow(rec);
        toast('對方拒絕了 ' + rec.name);
        return resolve();
      }
      rec.status = 'sending'; renderRow(rec);
      dcSend(JSON.stringify({ t: 'begin', id: rec.id }));
      await streamFile(rec);
      dcSend(JSON.stringify({ t: 'end', id: rec.id }));
      rec.transferred = rec.size; rec.status = 'done';
      renderRow(rec); updateStats();
      resolve();
    } catch (e) { reject(e); }
  });
}
function waitDecision(id) {
  return new Promise((resolve, reject) => { pendingDecision = { id, resolve, reject }; });
}
async function streamFile(rec) {
  const file = rec.file;
  let offset = 0;
  while (offset < file.size) {
    if (!dc || dc.readyState !== 'open') throw new Error('channel closed');
    if (dc.bufferedAmount > BUFFER_HIGH) { await drain(); continue; }
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const buf = await file.slice(offset, end).arrayBuffer();
    if (!dc || dc.readyState !== 'open') throw new Error('channel closed');
    dc.send(buf);
    offset = end;
    rec.transferred = offset;
    onProgress(rec);
  }
}
function drain() {
  return new Promise((resolve) => {
    const ch = dc;
    if (!ch || ch.readyState !== 'open') return resolve();
    const done = () => {
      ch.removeEventListener('bufferedamountlow', done);
      ch.removeEventListener('close', done);
      resolve();
    };
    ch.addEventListener('bufferedamountlow', done);  // buffer drained
    ch.addEventListener('close', done);              // ...or channel died — don't hang
  });
}
function dcSend(data) {
  if (dc && dc.readyState === 'open') dc.send(data);
}

/* ------------------------------------------------------------------ *
 *  Receiving
 * ------------------------------------------------------------------ */
function onDcMessage(data) {
  if (typeof data === 'string') {
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    onControl(msg);
  } else {
    const rec = currentRecvId ? recvMap[currentRecvId] : null;
    if (!rec) return;
    const buf = data instanceof ArrayBuffer ? data : null;
    if (!buf) return;
    rec.chunks.push(buf);
    rec.transferred += buf.byteLength;
    onProgress(rec);
  }
}
function onControl(msg) {
  switch (msg.t) {
    case 'meta':
      incomingQueue.push({ id: msg.id, name: msg.name, size: msg.size, mime: msg.mime });
      maybeShowIncoming();
      break;
    case 'accept':
      if (pendingDecision && pendingDecision.id === msg.id) { const p = pendingDecision; pendingDecision = null; p.resolve('accept'); }
      break;
    case 'reject':
      if (pendingDecision && pendingDecision.id === msg.id) { const p = pendingDecision; pendingDecision = null; p.resolve('reject'); }
      break;
    case 'begin':
      currentRecvId = msg.id;
      break;
    case 'end':
      finalizeReceive(msg.id);
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
  el.peerNameModal.textContent = peerLabel;
  el.modal.classList.remove('hidden');
}
function acceptIncoming() {
  const inc = activeIncoming; if (!inc) return;
  activeIncoming = null;
  el.modal.classList.add('hidden');
  dcSend(JSON.stringify({ t: 'accept', id: inc.id }));
  const rec = createRecord({ dir: 'in', id: inc.id, name: inc.name, size: inc.size, mime: inc.mime });
  recvMap[inc.id] = rec;
  currentRecvId = inc.id;
  renderRow(rec);
  maybeShowIncoming();
}
function rejectIncoming() {
  const inc = activeIncoming; if (!inc) return;
  activeIncoming = null;
  el.modal.classList.add('hidden');
  dcSend(JSON.stringify({ t: 'reject', id: inc.id }));
  maybeShowIncoming();
}
function finalizeReceive(id) {
  const rec = recvMap[id]; if (!rec) return;
  const blob = new Blob(rec.chunks, { type: rec.mime || 'application/octet-stream' });
  rec.blobUrl = URL.createObjectURL(blob);
  rec.chunks = [];
  rec.transferred = rec.size || blob.size;
  rec.status = 'done';
  renderRow(rec); updateStats();
  if (currentRecvId === id) currentRecvId = null;
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
    if (r.status === 'done' || r.status === 'rejected' || r.status === 'error') {
      if (r.blobUrl) { try { URL.revokeObjectURL(r.blobUrl); } catch (e) {} }
      if (r.node && r.node.parentNode) r.node.parentNode.removeChild(r.node);
      files.splice(i, 1);
    }
  }
  updateChrome();
  updateStats();
}

/* ------------------------------------------------------------------ *
 *  Room actions
 * ------------------------------------------------------------------ */
function joinRoom(code) {
  code = sanitizeCode(code);
  if (!code) return;
  teardownPeer();
  roomCode = code;
  updateRoomUI();
  el.joinInput.value = '';
  refreshConnectBtn();
  connectSignaling(roomCode);
  toast('正在加入房間 ' + roomCode);
}
function disconnect() {
  teardownPeer();
  roomCode = genCode();          // fresh room so the old peer can't rejoin
  updateRoomUI();
  connectSignaling(roomCode);
  setStatus('waiting');
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
  const link = shareLink();
  try { await navigator.clipboard.writeText(link); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = link; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }
  el.copyLabel.textContent = '已複製連結';
  el.copyLabel.style.color = '#2f9e57';
  setTimeout(() => { el.copyLabel.textContent = '複製連結'; el.copyLabel.style.color = 'var(--muted)'; }, 1600);
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
  if (dc && dc.readyState === 'open') el.fileInput.click();
  else { toast('請先與對方建立連線'); el.joinInput.focus(); }
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
})();
