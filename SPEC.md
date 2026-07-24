# PeerLink 規格文件（SPEC）

- **專案名稱**：PeerLink — 瀏覽器多人點對點傳輸
- **文件版本**：v1.0（依 `c15b8ca` commit 之現況回溯撰寫）
- **文件狀態**：Draft / 依現有程式碼反推之技術規格
- **語言**：本文件與產品介面皆使用繁體中文（zh-Hant）

---

## 1. 專案簡介

PeerLink 是一個**純瀏覽器端**的多人檔案傳輸網站。使用者開啟頁面即取得一個房間代碼，其他人輸入相同代碼或掃描 QR code 加入後，所有裝置之間會透過 **WebRTC DataChannel** 兩兩直接建立連線（mesh／全網狀拓撲），檔案以二進位串流的方式直接在瀏覽器之間傳輸，**不經任何伺服器儲存**，理論上沒有檔案大小限制。

整個網站只有靜態前端（HTML/CSS/JS），沒有後端應用邏輯；唯一的伺服端角色是一個**外部託管的 WebSocket 訊令（signaling）中繼伺服器**，僅負責在同一房間的裝置之間轉發連線協商訊息，不參與、也看不到檔案內容。

### 1.1 專案目標

| 目標 | 說明 |
|---|---|
| 零伺服器儲存 | 檔案內容全程只存在於傳送端與接收端瀏覽器記憶體中 |
| 免安裝、免帳號 | 開網頁即可用，不需註冊、不需安裝 App |
| 多人同傳 | 一個房間最多 6 台裝置，任何裝置選檔即廣播給所有已連線裝置 |
| 簡單配對 | 6 碼房間代碼 + QR code 兩種配對方式 |
| 行動裝置友善 | RWD 版面，QR code 於窄螢幕收合為按鈕 |

### 1.2 非目標（Out of Scope）

- 不提供帳號系統、雲端儲存、傳輸紀錄雲端同步
- 不支援斷線續傳（resume）／續傳點記錄
- 不保證在無法建立 P2P 連線的網路環境（如嚴格對稱型 NAT 且無 TURN）下可用（目前僅設定 STUN，未設定 TURN）
- 不做病毒掃描、內容審查或檔案格式限制
- 不是通訊軟體，不支援文字聊天、群組管理、歷史訊息保存

---

## 2. 使用者情境（User Flows）

### 2.1 建立房間並邀請他人

1. 使用者開啟網站，前端自動產生 6 碼房間代碼並連上訊令伺服器。
2. 使用者將房間代碼或分享連結（`?room=CODE`）／QR code 提供給其他裝置。
3. 其他裝置加入後，雙方自動完成 WebRTC 連線協商，房間看板即時顯示已連線裝置。

### 2.2 加入既有房間

1. 使用者取得 6 碼代碼或分享連結。
2. 於輸入框輸入代碼（或透過連結中的 `room` 參數自動帶入）並按下「加入房間」。
3. 前端切換訊令連線至該房間代碼，並與房間內既有裝置逐一建立 WebRTC 連線。

### 2.3 傳送檔案

1. 房間內至少有 1 台裝置已連線後，拖曳檔案（或點擊選檔）。
2. 檔案會**廣播**給所有目前已連線（DataChannel `open`）的裝置。
3. 每個目標裝置各自獨立詢問「接受 / 拒絕」；傳送端可看到每個目標的個別進度、整體聚合進度、平均速度與剩餘時間。

### 2.4 接收檔案

1. 收到 `meta` 訊息時，若目前沒有其他待決彈窗，立即彈出「收到檔案傳輸」對話框（多筆依序排隊）。
2. 使用者選擇「接受」：開始接收二進位分塊並即時顯示進度；接收完成後可點擊下載。
3. 使用者選擇「拒絕」：通知傳送端，傳送端該筆目標標記為「已拒絕」。

### 2.5 離開房間

- 使用者按下「離開房間」：關閉所有 P2P 連線、通知房間內其他裝置、產生新的房間代碼並重新連線訊令伺服器（避免舊裝置自動重新加入）。
- 使用者關閉分頁／離開頁面：`beforeunload` 觸發時盡力送出 `bye` 訊息並關閉 WebSocket。

---

## 3. 系統架構

### 3.1 架構總覽

```
┌──────────────┐        WSS 訊令（JSON 控制訊息）        ┌──────────────┐
│  瀏覽器 A     │ ───────────────────────────────────────▶│ 訊令中繼伺服器 │
│ (PeerLink)   │◀─────────────────────────────────────── │ (外部託管，   │
└──────┬───────┘        （offer/answer/ICE 轉發）          │  房間廣播式)  │
       │                                                  └──────┬───────┘
       │  WebRTC DataChannel（點對點、DTLS 加密）                   │ WSS
       │  （檔案分塊直接傳輸，伺服器不經手）                          │
       ▼                                                          ▼
┌──────────────┐                                          ┌──────────────┐
│  瀏覽器 B     │◀════════ mesh：B↔C、A↔C 等各自獨立連線 ════▶│  瀏覽器 C     │
└──────────────┘                                          └──────────────┘
```

- **前端**：純靜態網站（`index.html` + `app.js` + `styles.css` + `qrcode.js`），無建置流程、無框架、無第三方 JS 依賴（QR code 產生器為內嵌的第三方 MIT 授權函式庫）。
- **訊令伺服器**：不在本репо內，為外部託管服務（預設端點見 §9 設定參數）。角色僅為「房間內廣播 / 定向轉發」的 WebSocket relay，不落地儲存訊息、不參與 WebRTC 媒體/資料路徑。
- **P2P 連線層**：每兩台裝置各自建立一條獨立的 `RTCPeerConnection` 與一條 `RTCDataChannel`，房間內 N 台裝置共有 `N × (N-1) / 2` 條連線（mesh 拓撲）。

### 3.2 技術堆疊

| 層級 | 技術 |
|---|---|
| 頁面／樣式 | 原生 HTML5 + CSS3（CSS variables、Flexbox），字型使用 Google Fonts（Space Grotesk / JetBrains Mono / Noto Sans TC） |
| 應用邏輯 | 原生 ES2017+ JavaScript（無框架、無打包工具、`'use strict'` 單一 `app.js`） |
| 點對點傳輸 | WebRTC（`RTCPeerConnection` + `RTCDataChannel`，`ordered: true`） |
| 訊令傳輸 | WebSocket（`wss://`） |
| QR code | 內嵌第三方函式庫 `qrcode.js`（Kazuhiko Arase，MIT） |
| 廣告版位 | Google AdSense（`adsbygoogle.js`，非同步載入） |

### 3.3 部署形態

純靜態檔案，可直接部署於任何靜態託管（如 GitHub Pages、Cloudflare Pages、S3 等），無伺服端渲染、無 API server。唯一外部相依為訊令 WebSocket 服務的可用性。

---

## 4. 訊令協定（Signaling Protocol）

### 4.1 連線建立

前端以下列格式連線：

```
wss://<signaling-host>/?app=p2p-file-transfer&room=<ROOMCODE>
```

- `room`：6 碼房間代碼（見 §6.1 代碼規則）。
- 伺服器需將**同一 `room` 內**的所有連線視為一個廣播群組。

### 4.2 訊息信封（Envelope）

所有訊息皆為單行 JSON，透過 `WebSocket.send()` 傳送：

```jsonc
{
  "v": 1,              // 協定版本，固定為 1
  "from": "<myId>",     // 傳送端 12 碼隨機 ID（每次頁面載入產生）
  "to": "<peerId>",     // 選填：指定目標 peerId；省略則視為對整個房間廣播
  "kind": "hello" | "desc" | "ice" | "bye" | "room-full",
  // ...依 kind 而異的欄位，見下表
}
```

接收端規則：
- 忽略 `from === myId` 的訊息（避免處理自己送出的廣播）。
- 若訊息帶有 `to` 且 `to !== myId`，忽略（伺服器亦可選擇直接不轉發給非目標對象，前端仍會二次過濾）。

### 4.3 訊息種類（`kind`）

| kind | 方向 | 欄位 | 用途 |
|---|---|---|---|
| `hello` | 廣播 | `name`（裝置標籤字串） | 宣告自己在房間中／回應新成員；用於觸發雙方互相 `setupPeer` |
| `desc` | 定向 (`to`) | `description`（`RTCSessionDescriptionInit`） | 轉發 SDP offer / answer |
| `ice` | 定向 (`to`) | `candidate`（`RTCIceCandidateInit`） | 轉發 ICE candidate |
| `bye` | 廣播 | 無 | 通知房間內其他裝置自己已離開，接收端應 teardown 對應連線 |
| `room-full` | 定向 (`to`) | 無 | 已達房間人數上限（見 §6.1）時，回覆給嘗試加入者，前端顯示 toast 提示 |

### 4.4 訊令狀態機（單一房間內視角）

1. WebSocket `onopen` → 送出 `hello`。
2. 收到未知 peer 的 `hello` → 若房間未滿則 `setupPeer()` 並回送 `hello`（讓第三方也學到彼此）；若已滿則回覆 `room-full`。
3. 收到 `desc` / `ice` → 若該 peer 尚未建立則視情況先 `setupPeer()`，再交給 WebRTC 協商層處理（見 §5）。
4. 收到 `bye` → 對應 `peers` 中該筆記錄執行 `teardownPeer()`。
5. WebSocket `onclose` 且仍希望連線（`wantConnected === true`）→ 2 秒後自動重連同一房間代碼。

---

## 5. WebRTC 連線層規格

### 5.1 每對裝置一條 RTCPeerConnection

- 房間內任兩台裝置各自建立獨立的 `RTCPeerConnection`，儲存於 `peers: Map<peerId, PeerState>`。
- ICE Server：僅設定 Google 公開 STUN（`stun.l.google.com:19302`、`stun1.l.google.com:19302`），**未設定 TURN**（見 §10.3 限制）。

### 5.2 Perfect Negotiation 模式

為避免雙方同時互發 offer 造成 glare（碰撞），採用標準 *perfect negotiation* pattern：

- **禮貌方（polite）判定**：`polite = myId < peerId`（以隨機 ID 字串做字典序比較），兩端各自算出的結果剛好相反，因此雙方協商角色明確且無需額外交握。
- **非禮貌方（impolite）**：主動呼叫 `createDataChannel()`，觸發 `onnegotiationneeded` 產生 offer。
- 收到對方 offer 時，若自己也正在 `makingOffer` 或 `signalingState !== 'stable'`：
  - 禮貌方：接受衝突，正常處理對方 offer（覆蓋自己的）。
  - 非禮貌方：忽略對方 offer（`ignoreOffer = true`），等待自己的 offer 被接受。
- ICE candidate 在 remote description 尚未設定前先暫存於 `pendingCandidates`，待 `setRemoteDescription` 完成後統一 `flushCandidates()`。

### 5.3 連線逾時與失敗處理

| 情境 | 處理 |
|---|---|
| 協商超過 `NEGOTIATION_TIMEOUT_MS`（20 秒）仍未 `connected` | 顯示 toast「連線逾時」並 teardown 該 peer |
| `RTCPeerConnection.connectionState === 'failed'` | 顯示 toast「連線失敗」並 teardown |
| DataChannel `onclose` | 顯示 toast「連線已中斷」並 teardown |
| Teardown 時的清理 | 關閉 DataChannel／PeerConnection、清除逾時計時器、將該 peer 進行中的傳輸標記為 `error`、移除待決的「接受/拒絕」彈窗與佇列項目、更新房間看板 UI |

### 5.4 房間人數上限

- `MAX_REMOTE_PEERS = 5`（+ 自己 = 房間總容量 6 台裝置，軟性上限）。
- 當本地 `peers.size >= 5` 時，收到新的 `hello` / `desc` / `ice` 一律回覆或忽略（`hello`/`desc` 回 `room-full`，`ice` 直接忽略），不建立新的 `RTCPeerConnection`。
- 由於上限判斷是**各裝置各自本地判斷**（非中心化仲裁），理論上在極端 race condition（多人同時加入）下可能短暫超過 6 人軟上限，非強保證。

---

## 6. 房間與配對規格

### 6.1 房間代碼

- 長度固定 6 碼，字元集為 `CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`（33 字元，排除易混淆字元 `I O 0 1`）。
- 使用 `crypto.getRandomValues()` 產生，理論組合數 33⁶ ≈ 12.9 億，足以避免隨機碰撞，但**非為抗暴力枚舉設計**（見 §10.2 安全性）。
- 使用者輸入時即時清洗（`sanitizeCode`）：轉大寫、僅保留字母集內字元、截斷至 6 碼。

### 6.2 分享連結

```
<origin><pathname>?room=<ROOMCODE>
```

- 頁面載入時會解析 URL `room` 參數並自動代入、`history.replaceState` 同步網址列（不留歷史紀錄）。
- 「複製連結」按鈕會將上述完整網址寫入剪貼簿（`navigator.clipboard`，並提供 `execCommand('copy')` 後備方案）。

### 6.3 QR code

- 內容即為 §6.2 之分享連結，以內嵌 `qrcode.js`（Error Correction Level `M`）產生 SVG。
- 響應式行為：
  - 寬螢幕（≥720px）：QR 常駐顯示。
  - 窄螢幕（<720px）：預設隱藏，改以「顯示 / 隱藏 QR code」按鈕切換（`data-open` 屬性控制顯示，`p2p-qr-wrap` / `p2p-qr-toggle` CSS class 依 media query 控制）。

### 6.4 裝置標籤（Device Label）

依 `navigator.userAgent` 粗略解析瀏覽器與作業系統，組成如 `Chrome · Windows` 的顯示名稱，用於房間看板、彈窗與傳輸紀錄中辨識對方裝置（非使用者可自訂暱稱）。

---

## 7. 檔案傳輸協定（DataChannel 應用層）

### 7.1 傳輸參數

| 參數 | 值 | 說明 |
|---|---|---|
| `CHUNK_SIZE` | 16 KiB | 單次 `send()` 的二進位分塊大小，跨瀏覽器相容的安全值 |
| `BUFFER_HIGH` | 4 MiB | `dc.bufferedAmount` 超過此值時暫停送出，等待 drain |
| `BUFFER_LOW`（`bufferedAmountLowThreshold`） | 512 KiB | 緩衝降到此值以下時觸發 `bufferedamountlow`，恢復送出 |
| `DECISION_TIMEOUT_MS` | 25 秒 | 等待對方「接受/拒絕」逾時，逾時視為失敗（`error`） |
| DataChannel 設定 | `ordered: true`、`binaryType = 'arraybuffer'` | 保序傳輸；二進位以 ArrayBuffer 處理 |

### 7.2 控制訊息（DataChannel 文字訊息，JSON）

| `t` | 方向 | 欄位 | 說明 |
|---|---|---|---|
| `meta` | 傳送端→接收端 | `id, name, size, mime` | 宣告即將傳送的檔案中繼資料，觸發接收端排入「收到檔案傳輸」彈窗佇列 |
| `accept` | 接收端→傳送端 | `id` | 使用者按下「接受」 |
| `reject` | 接收端→傳送端 | `id` | 使用者按下「拒絕」 |
| `begin` | 傳送端→接收端 | `id` | 開始傳送二進位分塊（設定 `p.currentRecvId = id`） |
| `end` | 傳送端→接收端 | `id` | 全部分塊送畢，接收端據此組裝 `Blob` 並產生下載連結 |

### 7.3 二進位資料訊息

- 於 `begin` 之後、`end` 之前送出的每一則 DataChannel **binary message**（`ArrayBuffer`）皆視為目前 `currentRecvId` 對應檔案的下一個分塊，依到達順序（`ordered: true` 保證）append 進暫存陣列。
- 接收端於 `finalizeReceive()` 時以 `new Blob(chunks, { type: mime })` 組裝完整檔案，並以 `URL.createObjectURL()` 產生下載連結（使用者手動點擊「下載」才觸發實際存檔動作，不會自動下載）。

### 7.4 單一檔案的完整交握流程

```
傳送端                                              接收端
  │── meta{id,name,size,mime} ─────────────────────▶│  （若有其他待決請求則排隊，否則立即彈窗）
  │                                                  │  使用者選擇 接受 / 拒絕
  │◀──────────────────────── accept{id} / reject{id}─│
  │ (若 reject 或逾時 25s：標記該目標 rejected/error，結束) │
  │── begin{id} ────────────────────────────────────▶│
  │── chunk(binary) × N（16KiB／筆，含背壓控制）───────▶│  逐筆 append，即時更新已收位元組數／進度條
  │── end{id} ──────────────────────────────────────▶│  組裝 Blob，狀態轉為 done，出現「下載」按鈕
```

### 7.5 多人廣播傳輸

- 傳送端一次選檔（可多檔）會為**每個目前已連線的裝置**各自建立一筆 `target` 記錄（`{peerId, label, status, sent, speed}`），彼此獨立、並行執行 §7.4 流程（`Promise.allSettled`），互不阻塞——某一台拒絕或斷線不影響其他目標。
- UI 呈現聚合進度（`transferred / (size × 人數)`）與逐目標明細（各自的百分比／狀態文字）。
- 佇列（`sendQueue`）為**檔案層級**依序處理（`pumpSendQueue`：一次處理一筆 `createRecord`，內部才對多目標並行），非多檔並行傳送。

### 7.6 傳輸狀態機（單一 target）

```
waiting → sending → done
   │           │
   │           └────────→ error（逾時／通道關閉／對方離線）
   └────────→ rejected（對方拒絕）
             → error（送出 meta 後對方逾時 25s 未回應）
```

`done | rejected | error` 為終態（`isTerminal`）。一筆傳輸記錄（可能含多個 target）在**所有** target 皆為終態時，該記錄整體才視為結束（`isRecordTerminal`），並允許被「清除已完成」動作移除。

---

## 8. 使用者介面規格

### 8.1 版面結構（單頁）

- **Header**：Logo + 產品名稱 + 全域連線狀態燈號（`status-dot` / `status-text`）。
- **左欄（`.p2p-pair`）**
  - 房間看板卡片：房間代碼、自己＋已連線裝置名片（roster）、統計數字（已傳輸總量／房間人數／我的連線數）、「離開房間」。
  - 配對卡片：QR code、房間代碼（可複製）、加入代碼輸入框、「加入房間」按鈕；房間有連線後文案切換為「邀請更多裝置」。
  - 房間已滿提示卡片（達 6 人時顯示，取代配對卡片）。
  - 「全網狀・零伺服器」說明卡片（靜態文案）。
- **右欄（`.p2p-files`）**
  - 拖放／點擊選檔區（`dropzone`），無連線裝置時點擊會提示「請先邀請裝置加入房間」並聚焦輸入框，而非開啟檔案選擇器。
  - 傳輸佇列標題列 + 「清除已完成」按鈕（有紀錄才顯示）。
  - 空狀態提示卡（尚無傳輸紀錄時顯示）。
  - 傳輸紀錄清單（`file-list`，新記錄插入最上方）。
  - 廣告版位（AdSense 300×250 佔位）。
- **Modal**：收到檔案傳輸的接受／拒絕對話框（同一時間僅顯示一筆，其餘於 `incomingQueue` 依序等待）。
- **Toast**：全域訊息提示（3.2 秒自動消失，滑入動畫）。

### 8.2 狀態呈現規則（連線狀態燈號）

| 狀態 key | 觸發條件 | 顏色 | 文字 |
|---|---|---|---|
| `offline` | `wantConnected === false` | 橘 `#c26a3b` | 離線 |
| `connecting` | WebSocket 尚未開啟 | 藍 `#3b52c4` | 連線中… |
| `waiting` | WebSocket 已開啟但房間內無其他 peer | 橘 | 等待裝置加入 |
| `pairing` | 已有 peer 但尚未有任一 DataChannel `connected` | 藍 | 配對中… |
| `connected` | 至少 1 個 peer 已連線 | 綠 `#2f9e57` | `(N+1) 人已連線` |

### 8.3 響應式設計

- 中斷點：`720px`。
- `<720px`：檔案區塊（`.p2p-files`）以 `order: -1` 移到視覺上方優先呈現；QR code 收合為按鈕觸發顯示。
- `≥720px`：房間/配對區與檔案區並排（flex-wrap 版面），QR code 常駐顯示。
- `prefers-reduced-motion: reduce`：全域關閉動畫（`animation: none !important`）。

### 8.4 進度與節流

- 單一 target 的進度更新採節流：每 120ms 或該 target 傳輸完成時才重新計算速度與重繪該筆記錄（`onTargetProgress`），避免高頻 `renderRow` 造成掉幀。
- 總傳輸量統計（`stat-total`）以 `requestAnimationFrame` 合併多次更新，避免同一畫格內重複渲染。

---

## 9. 設定參數（Config Constants）

| 常數 | 預設值 | 可否覆寫 | 說明 |
|---|---|---|---|
| `SIGNALING_BASE_URL` | `wss://signal.ksdevworks.online/?app=p2p-file-transfer&room=` | 可透過 `localStorage.setItem('p2p_signal_base', '<url前綴>')` 覆寫，供本地測試/自架訊令伺服器使用（不需重新建置） | WebSocket 訊令端點前綴，實際連線會在後面補上 `encodeURIComponent(room)` |
| `ICE_SERVERS` | Google 公開 STUN ×2 | 需改原始碼 | 未內建 TURN |
| `CHUNK_SIZE` | 16384 (16 KiB) | 需改原始碼 | DataChannel 單筆傳送大小 |
| `BUFFER_HIGH` / `BUFFER_LOW` | 4 MiB / 512 KiB | 需改原始碼 | 傳送端背壓（flow control）水位 |
| `CODE_ALPHABET` | 33 字元（排除易混淆字元） | 需改原始碼 | 房間代碼字元集 |
| `MAX_REMOTE_PEERS` | 5 | 需改原始碼 | 房間軟上限（不含自己） |
| `DECISION_TIMEOUT_MS` | 25000 | 需改原始碼 | 等待接受/拒絕逾時 |
| `NEGOTIATION_TIMEOUT_MS` | 20000 | 需改原始碼 | WebRTC 協商逾時 |

---

## 10. 非功能需求

### 10.1 效能

- 傳輸速度受限於：(a) DataChannel SCTP 吞吐量、(b) 16 KiB chunk + 4MiB/512KiB 背壓策略、(c) 瀏覽器分塊讀檔（`File.slice().arrayBuffer()`）與 GC 壓力。
- 目前**無並行送出多個 chunk 的 pipeline 優化**（逐塊 `await` 讀檔→送出→視背壓決定是否等待），單一 target 對單一檔案為序列傳輸；多 target 之間則以 `Promise.allSettled` 平行送出。

### 10.2 安全性

- **傳輸內容加密**：WebRTC DataChannel 底層強制使用 DTLS 加密 SCTP，因此檔案內容在傳送端與接收端之間為端對端加密，訊令伺服器與任何中間網路節點皆無法解密內容。
- **訊令內容不加密於應用層，但走 WSS**：房間代碼、裝置標籤（UA 解析結果）、SDP/ICE 中繼資料會經過訊令伺服器，該伺服器可觀察「誰在跟誰配對」但看不到檔案內容。
- **房間代碼並非強權限憑證**：6 碼、33 字元集，屬於「短碼、易於分享」與「防隨機碰撞」的折衷設計，**未做速率限制或嘗試次數限制**（此限制屬訊令伺服器職責，不在本前端程式碼範圍內），不建議用於高敏感內容的正式安全邊界。
- **無使用者身分驗證**：任何取得房間代碼或連結者皆可加入，且無房主踢人機制（僅能整體「離開房間」讓自己換到新房間）。
- **檔案接收需使用者手動同意**：預設不會自動接受任何傳入檔案，降低誤觸下載惡意檔案風險；但**內容本身未經掃描**。

### 10.3 相容性與環境限制

- 需要支援 `RTCPeerConnection`（含 `setLocalDescription()` 無參數簡寫）、`RTCDataChannel`、`WebSocket`、`crypto.getRandomValues`、`navigator.clipboard`（含降級路徑）之現代瀏覽器（Chrome / Edge / Firefox / Safari 近期版本）。
- **僅設定 STUN、未設定 TURN**：在雙方皆位於對稱型 NAT（Symmetric NAT）或嚴格防火牆環境時，ICE 有可能無法打洞成功，此時連線會在 `NEGOTIATION_TIMEOUT_MS` 後判定逾時失敗，且**無自動降級（如透過 relay）機制**。
- 依賴外部 CDN／服務：Google Fonts、Google AdSense、外部訊令伺服器（`ksdevworks.online`）。若這些服務不可達，訊令與字型／廣告會分別受影響（訊令不可達會直接阻斷配對功能；字型/廣告僅影響外觀與版位）。

### 10.4 可用性與規模限制

- 房間軟上限 6 台裝置；官方文案建議 4～6 人（`app.js` 內部常數為硬性依據，UI 文案為建議值）。
- **接收端於完成前，檔案內容持續累積於記憶體中**（`_chunks` 陣列 + 最終組裝的 `Blob`），並非邊收邊寫入磁碟；因此「無檔案大小限制」實際受限於裝置可用記憶體（尤其行動裝置或大檔案／多筆同時接收時需留意）。
- **不支援斷點續傳**：連線中斷或分頁重整後，進行中的傳輸即失敗，須重新從頭傳送；沒有已傳輸位移量的持久化。
- **重新整理頁面會離開房間**：`myId`／`roomCode`（若無 URL 參數）於每次載入時重新產生，所有 P2P 狀態均為記憶體內、非持久化。

---

## 11. 已知限制與後續可強化方向

| # | 項目 | 現況 | 可能強化方向 |
|---|---|---|---|
| 1 | 無 TURN server | 嚴格 NAT 環境下可能完全無法建立連線 | 加入 TURN／設定可覆寫的 TURN 清單 |
| 2 | 接收端全量記憶體緩衝 | 大檔案／多筆同時接收有記憶體風險 | 改用 File System Access API 或 Streams 邊收邊寫 |
| 3 | 無斷點續傳 | 中斷即需整檔重傳 | 記錄已傳輸位移量，支援續傳協定 |
| 4 | 房間上限為各端本地判斷 | race condition 下可能短暫超額 | 由訊令伺服器統一仲裁房間人數 |
| 5 | 訊令伺服器單點 | 該服務離線則整站配對功能失效 | 提供備援端點或可自架文件 |
| 6 | 無使用者自訂暱稱 | 僅顯示自動解析之瀏覽器/OS 標籤 | 開放暱稱輸入 |
| 7 | 檔案層級佇列非並行 | 多檔依序（逐檔）送出 | 視頻寬情況允許多檔並行 pipeline |

---

## 12. 檔案結構

```
p2p-file/
├── index.html          # 頁面骨架與行內樣式（單頁應用）
├── app.js               # 全部前端邏輯：signaling、WebRTC、傳輸、UI 渲染
├── styles.css            # 設計 tokens、全域樣式、動畫、RWD 規則
├── qrcode.js             # 第三方 QR code 產生器（MIT License, Kazuhiko Arase）
└── peerlink-logo.png     # 產品標誌
```

- 無 `package.json`、無建置流程、無測試框架；為可直接以任一靜態伺服器（或直接開啟檔案）運行的原生 Web 專案。

---

## 13. 詞彙表

| 詞彙 | 說明 |
|---|---|
| 房間（Room） | 由 6 碼代碼識別的邏輯群組，訊令伺服器據此廣播訊息給同房間的所有連線 |
| Mesh／全網狀拓撲 | 房間內每兩台裝置皆各自建立一條獨立 P2P 連線的網路拓撲 |
| 訊令（Signaling） | 用於交換 SDP／ICE candidate 等 WebRTC 連線協商資訊的輔助通道，本身不傳輸媒體/檔案資料 |
| Perfect Negotiation | WebRTC 標準協商模式，透過禮貌方/非禮貌方角色化解雙方同時發起 offer 的碰撞 |
| DataChannel | WebRTC 提供的雙向、可設定保序性的資料通道，本專案用其傳輸控制訊息與檔案二進位分塊 |
| Target | 一筆傳輸記錄中，某一個接收/傳送對象的狀態與進度子紀錄（廣播時一筆記錄可有多個 target） |
