"use strict";

// Apps Script ウェブアプリの URL（家事API v2）
const API_URL = "https://script.google.com/macros/s/AKfycbx91iMFxq6gxpFuIsZR9Ok93ZZrH4DRrCWrRYhKuRk9QWLlpyX8YUDJKBdGaBXC-mi7ZA/exec";
const APP_VERSION = "1.1";
const STATE_CACHE_KEY = "kaji_state_cache_v1";
const WRITE_QUEUE_KEY = "kaji_write_queue_v1";

// localStorage はプライベートモード等で例外になることがあるため、必ずラッパー経由にする
function storageGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; } }
function storageRemove(key) { try { window.localStorage.removeItem(key); } catch (e) { /* noop */ } }

const WHO_LIST = ["卓也", "あや", "ふたりで"];
const WHO_CLASS = { "卓也": "takuya", "あや": "aya", "ふたりで": "both" };
const FREQ_LABEL = { daily: "毎日", weekly: "週1回", monthly: "月1回くらい" };
// 対象リストは「今日の対象」1つだけ（仕様訂正 2026-11-07）。週1回・月1回の家事も今日の対象に入る
const TARGET_LABEL = "今日の対象";
const DAILY_GROUPS = [
  ["everyday", "ほぼ毎日"],
  ["cook", "自炊の日"],
  ["eatout", "外食の日"],
  ["laundry", "洗濯の日"],
  ["stock", "溜まったら"],
  ["", "その他"]
];
const TIME_BANDS = [
  [0, 5, "〜5分（サクッと）"],
  [6, 10, "6〜10分"],
  [11, 20, "11〜20分"],
  [21, Infinity, "21分〜（しっかり）"]
];

const state = {
  pin: storageGet("kaji_pin") || "",
  connected: false,
  chores: [],
  records: [], // {date, choreId, who}
  targets: [], // {scope, key, choreId}
  tab: "daily",
  groupMode: { daily: "freq", weekly: "freq", monthly: "freq" },
  openSteps: new Set(),
  editingId: null,
  addOpen: { daily: false, weekly: false, monthly: false },
  presets: { meal: null, laundry: false }, // meal: "cook"|"eatout"|null
  calCursor: null, // {y, m}
  selectedDay: null, // yyyy-MM-dd
  lastDeleted: null,
  currentDate: null,
  rolloverPending: false,
  rolloverFrom: null,
  hasCachedState: false
};

function pad(n) { return ("0" + n).slice(-2); }
function fmtDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function todayStr() { return fmtDate(new Date()); }
function parseDate(s) { const p = s.split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
function mondayOf(s) { const d = parseDate(s); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return fmtDate(d); }
function monthKeyOf(s) { return s.slice(0, 7); }
function isValidDateText(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  return fmtDate(parseDate(s)) === s;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 対象キーの正規化：シート上で日付型に変換されて返る場合（"Sat Nov 07 2026 ..."等）を元の形式に戻す
function normalizeTargetKey(scope, key) {
  const k = String(key || "");
  if (scope === "month") {
    if (/^\d{4}-\d{2}$/.test(k)) return k;
    const d = new Date(k);
    if (!isNaN(d)) return d.getFullYear() + "-" + pad(d.getMonth() + 1);
    return k;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return k;
  const d = new Date(k);
  if (!isNaN(d)) return fmtDate(d);
  return k;
}
function choreById(id) { return state.chores.find((c) => c.id === id) || null; }
function activeChores(freq) { return state.chores.filter((c) => !c.deleted && (!freq || c.freq === freq)); }
function recordMap() {
  const map = new Map();
  for (const r of state.records) map.set(r.date + "|" + r.choreId, r.who);
  return map;
}
// 対象は scope=day・key=今日 のみ使う（週・月スコープは使わない）
function targetKey() {
  return { scope: "day", key: todayStr() };
}
function targetSet() {
  const { scope, key } = targetKey();
  const set = new Set();
  for (const t of state.targets) if (t.scope === scope && t.key === key) set.add(t.choreId);
  return set;
}
function periodRange(freq) {
  const t = todayStr();
  if (freq === "daily") return [t, t];
  if (freq === "weekly") { const m = mondayOf(t); return [m, addDays(m, 6)]; }
  const first = t.slice(0, 8) + "01";
  const d = parseDate(first); d.setMonth(d.getMonth() + 1); d.setDate(0);
  return [first, fmtDate(d)];
}
// 期間内にその家事の記録があるか（あれば最新の {date, who}）
function periodRecord(choreId, freq) {
  const [from, to] = periodRange(freq);
  let best = null;
  for (const r of state.records) {
    if (r.choreId === choreId && r.date >= from && r.date <= to) {
      if (!best || r.date > best.date) best = r;
    }
  }
  return best;
}
// 按分集計：ふたりで は 0.5 ずつ。戻り値 {counts:{卓也,あや（按分後）}, raw:{...}, total}
function shareOf(records) {
  let takuya = 0, aya = 0;
  const raw = { "卓也": 0, "あや": 0, "ふたりで": 0 };
  for (const r of records) {
    if (r.who === "卓也") { takuya += 1; raw["卓也"] += 1; }
    else if (r.who === "あや") { aya += 1; raw["あや"] += 1; }
    else if (r.who === "ふたりで") { takuya += 0.5; aya += 0.5; raw["ふたりで"] += 1; }
  }
  const total = takuya + aya;
  let pT = 0, pA = 0;
  if (total > 0) {
    // 最大剰余法で合計100%にする
    const rawT = (takuya / total) * 100, rawA = (aya / total) * 100;
    pT = Math.floor(rawT); pA = Math.floor(rawA);
    let rest = 100 - pT - pA;
    const fracs = [[rawT - pT, "t"], [rawA - pA, "a"]].sort((a, b) => b[0] - a[0]);
    for (const [ , who] of fracs) { if (rest <= 0) break; if (who === "t") pT += 1; else pA += 1; rest -= 1; }
  }
  return { takuya, aya, raw, total, pT, pA };
}

/* ---------- 日付またぎ ---------- */
function updateTodayLabel() {
  const el = document.getElementById("todayLabel");
  if (!el) return;
  const t = new Date();
  el.textContent = `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日（${"日月火水木金土"[t.getDay()]}）`;
}
function finishDateRollover(previous) {
  const current = todayStr();
  const wasSelectedToday = state.selectedDay === previous;
  state.presets = { meal: null, laundry: false };
  if (wasSelectedToday) {
    state.selectedDay = current;
    const now = new Date();
    state.calCursor = { y: now.getFullYear(), m: now.getMonth() };
  }
  render();
}
function checkDateRollover() {
  const current = todayStr();
  if (!state.currentDate) { state.currentDate = current; return false; }
  if (current === state.currentDate) return false;
  const previous = state.currentDate;
  state.currentDate = current;
  updateTodayLabel();
  if (state.editingId) {
    state.rolloverPending = true;
    state.rolloverFrom = previous;
    return true;
  }
  finishDateRollover(previous);
  return true;
}
function consumeDateRollover() {
  if (!state.rolloverPending || state.editingId) return false;
  const previous = state.rolloverFrom;
  state.rolloverPending = false;
  state.rolloverFrom = null;
  if (previous) finishDateRollover(previous);
  return true;
}

/* ---------- 状態データの検証・キャッシュ ---------- */
function cleanText(value, max) { return String(value == null ? "" : value).slice(0, max); }
function sanitizeChore(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanText(raw.id, 100).trim();
  const name = cleanText(raw.name, 60).trim();
  if (!id || !name) return null;
  const minutesNum = Number(raw.minutes);
  const orderNum = Number(raw.order);
  return {
    id: id,
    name: name,
    freq: Object.prototype.hasOwnProperty.call(FREQ_LABEL, raw.freq) ? raw.freq : "daily",
    group: cleanText(raw.group, 50),
    steps: cleanText(raw.steps, 2000),
    minutes: Number.isFinite(minutesNum) ? Math.min(600, Math.max(0, Math.round(minutesNum))) : 0,
    custom: raw.custom === true || String(raw.custom || "") === "1",
    deleted: raw.deleted === true || String(raw.deleted || "") === "1",
    order: Number.isFinite(orderNum) ? orderNum : 0
  };
}
function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.chores) || !Array.isArray(raw.records) || !Array.isArray(raw.targets)) return null;
  const chores = raw.chores.map(sanitizeChore).filter(Boolean);
  if (raw.chores.length && !chores.length) return null;
  const records = [];
  for (const r of raw.records) {
    if (!r || typeof r !== "object") continue;
    const date = cleanText(r.date, 10);
    const choreId = cleanText(r.choreId, 100).trim();
    if (!isValidDateText(date) || !choreId || WHO_LIST.indexOf(r.who) < 0) continue;
    records.push({ date: date, choreId: choreId, who: r.who });
  }
  const targets = [];
  for (const t of raw.targets) {
    if (!t || typeof t !== "object") continue;
    const scope = cleanText(t.scope, 10);
    const choreId = cleanText(t.choreId, 100).trim();
    const key = normalizeTargetKey(scope, t.key);
    if (["day", "week", "month"].indexOf(scope) < 0 || !key || !choreId) continue;
    targets.push({ scope: scope, key: key, choreId: choreId });
  }
  return { chores: chores, records: records, targets: targets };
}
function persistStateCache() {
  storageSet(STATE_CACHE_KEY, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    snapshot: { chores: state.chores, records: state.records, targets: state.targets }
  }));
}
function loadStateCache() {
  try {
    const raw = storageGet(STATE_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) throw new Error("bad_cache");
    const snap = sanitizeSnapshot(parsed.snapshot);
    if (!snap || !snap.chores.length) throw new Error("empty_cache");
    applySnap(snap);
    state.hasCachedState = true;
    return true;
  } catch (e) {
    storageRemove(STATE_CACHE_KEY);
    state.hasCachedState = false;
    return false;
  }
}

/* ---------- API ---------- */
function setSync(text) { const el = document.getElementById("syncStatus"); if (el) el.textContent = text; }
function setLoadingState(mode) {
  const el = document.getElementById("loadingState");
  if (!el) return;
  if (mode === "hidden") { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const text = document.getElementById("loadingText");
  const btn = document.getElementById("retryLoadButton");
  if (mode === "error") {
    if (text) text.textContent = "読み込みできませんでした。通信状態を確認して、もう一度お試しください。";
    if (btn) btn.classList.remove("hidden");
  } else {
    if (text) text.textContent = "読み込み中…";
    if (btn) btn.classList.add("hidden");
  }
}
function markSynced() {
  setSync("同期済み " + new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }));
}
function pendingWriteCount() { return writeQueue.length + (activeWriteOp ? 1 : 0); }
function refreshSyncLabel() {
  if (!API_URL) { setSync("未設定"); return; }
  const n = pendingWriteCount();
  if (!navigator.onLine) { setSync("オフライン（未送信" + n + "件）"); return; }
  if (n > 0) { setSync("保存中…"); return; }
  if (state.connected) markSynced();
  else setSync("未接続");
}
function showError(msg) {
  const bar = document.getElementById("errorBar");
  bar.textContent = msg;
  bar.classList.remove("hidden");
  clearTimeout(showError._t);
  showError._t = setTimeout(() => bar.classList.add("hidden"), 6000);
}

// サーバー状態の取得だけを行い、正規化したスナップショットを返す（ローカル状態は触らない）
async function fetchServerState() {
  if (!API_URL) { state.connected = false; return null; }
  try {
    const res = await fetch(API_URL + "?action=state&pin=" + encodeURIComponent(state.pin) + "&ts=" + Date.now());
    const j = await res.json();
    if (!j || !j.ok) {
      if (j && j.error === "unauthorized") {
        const pin = window.prompt("合言葉を入力してください");
        if (pin) { state.pin = pin; storageSet("kaji_pin", pin); return fetchServerState(); }
      }
      return null;
    }
    return sanitizeSnapshot(j);
  } catch (e) {
    return null;
  }
}
function applySnap(snap) {
  state.chores = snap.chores;
  state.records = snap.records;
  state.targets = snap.targets;
}
// 比較用ハッシュ：表示に影響する項目だけを抜き出し、順序に依存しない形にする
function stateHash(s) {
  const proj = {
    c: s.chores.map((c) => JSON.stringify([c.id, c.name, c.freq, c.group || "", c.steps || "", c.minutes || 0, c.custom ? 1 : 0, c.deleted ? 1 : 0, c.order || 0])).sort(),
    r: s.records.map((r) => JSON.stringify([r.date, r.choreId, r.who])).sort(),
    t: s.targets.map((t) => JSON.stringify([t.scope, t.key, t.choreId])).sort()
  };
  return JSON.stringify(proj);
}

// ポーリング／フォーカス時の再取得。未送信の操作がある間は取得自体を延期し、
// 前回と同一内容なら描画しない。実際に取り込んだ場合のみ true を返す
async function refreshFromServer(opts) {
  const force = Boolean(opts && opts.force);
  if (!API_URL) { state.connected = false; setSync("未設定"); return false; }
  if (hasPendingOps()) return false;
  const snap = await fetchServerState();
  if (!snap) {
    state.connected = false;
    refreshSyncLabel();
    return false;
  }
  state.connected = true;
  if (!force && stateHash(snap) === stateHash(state)) { refreshSyncLabel(); return false; }
  applySnap(snap);
  persistStateCache();
  refreshSyncLabel();
  return true;
}

/* ---------- 書き込みキュー ----------
 * 操作はローカルへ即反映して即描画し、送信はキューで1件ずつ順番に行う。
 * POST が ok を返したらそれを信頼し、全件再取得はしない。
 * 応答が読めなかった／明示エラーだった操作がある時だけ、キューの最後に
 * 1回だけ状態を読み戻して反映を確認する（盲目的な再送はしない）。 */
const writeQueue = [];
let queueRunning = false;
let activeWriteOp = null;
function hasPendingOps() { return queueRunning || activeWriteOp !== null || writeQueue.length > 0; }

const WRITE_ACTIONS = ["setRecord", "clearRecord", "setTarget", "addChore", "updateChore", "deleteChore", "restoreChore"];
function sanitizeQueueChore(raw) {
  if (!raw || typeof raw !== "object") return null;
  const c = sanitizeChore({ id: "queue", name: raw.name, freq: raw.freq, steps: raw.steps, minutes: raw.minutes, custom: true });
  if (!c) return null;
  return { name: c.name, freq: c.freq, steps: c.steps, minutes: c.minutes };
}
function sanitizeQueueOp(raw, wasActive) {
  if (!raw || typeof raw !== "object" || !raw.body || typeof raw.body !== "object") return null;
  const body = Object.assign({}, raw.body);
  if (WRITE_ACTIONS.indexOf(body.action) < 0) return null;
  if (body.date != null) { body.date = cleanText(body.date, 10); if (!isValidDateText(body.date)) return null; }
  if (body.choreId != null) { body.choreId = cleanText(body.choreId, 100).trim(); if (!body.choreId) return null; }
  if (body.id != null) { body.id = cleanText(body.id, 100).trim(); if (!body.id) return null; }
  if (body.scope != null) {
    body.scope = cleanText(body.scope, 10);
    body.key = normalizeTargetKey(body.scope, body.key);
    body.on = body.on === true || body.on === "true";
    if (["day", "week", "month"].indexOf(body.scope) < 0 || !body.key) return null;
  }
  if (body.who != null && WHO_LIST.indexOf(body.who) < 0) return null;
  if (body.chore != null) { body.chore = sanitizeQueueChore(body.chore); if (!body.chore) return null; }
  if (body.expect != null) body.expect = { name: cleanText(body.expect && body.expect.name, 60) };
  const localChore = raw.localChore ? sanitizeChore(raw.localChore) : null;
  let undoOnFail = null;
  if (raw.undoOnFail && typeof raw.undoOnFail === "object") {
    const id = cleanText(raw.undoOnFail.id, 100).trim();
    const name = cleanText(raw.undoOnFail.name, 60).trim();
    if (id && name) undoOnFail = { id: id, name: name };
  }
  return {
    key: typeof raw.key === "string" ? raw.key.slice(0, 220) : null,
    body: body,
    tempId: typeof raw.tempId === "string" ? raw.tempId.slice(0, 100) : null,
    localChore: localChore,
    undoOnFail: undoOnFail,
    needsVerify: Boolean(raw.needsVerify || wasActive)
  };
}
function serializeWriteOp(op, inflight) {
  return {
    key: op.key || null,
    body: op.body,
    tempId: op.tempId || null,
    localChore: op.localChore || null,
    undoOnFail: op.undoOnFail || null,
    needsVerify: Boolean(op.needsVerify || inflight)
  };
}
function persistWriteQueue() {
  const all = [];
  if (activeWriteOp) all.push(serializeWriteOp(activeWriteOp, true));
  for (const op of writeQueue) all.push(serializeWriteOp(op, false));
  storageSet(WRITE_QUEUE_KEY, JSON.stringify(all));
}
function restoreWriteQueue() {
  try {
    const raw = storageGet(WRITE_QUEUE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("bad_queue");
    for (const item of parsed) {
      const op = sanitizeQueueOp(item, false);
      if (op) writeQueue.push(op);
    }
  } catch (e) {
    storageRemove(WRITE_QUEUE_KEY);
    writeQueue.length = 0;
  }
}

function enqueueWrite(op) {
  if (!API_URL) { showError("API未設定のため保存できません"); return; }
  if (op.key) {
    // 同じキーへの未送信操作は新しい操作で置き換える（連打しても最終状態だけ送る）
    const idx = writeQueue.findIndex((q) => q.key === op.key);
    if (idx >= 0) { writeQueue[idx] = op; persistWriteQueue(); refreshSyncLabel(); kickQueue(); return; }
  }
  writeQueue.push(op);
  persistWriteQueue();
  refreshSyncLabel();
  kickQueue();
}
function kickQueue() {
  if (queueRunning) return;
  if (!navigator.onLine) { refreshSyncLabel(); return; }
  queueRunning = true;
  processQueue();
}

// POST を1回だけ送る。ok / 明示エラー / 応答未読 を区別して返す
async function postWrite(body) {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(Object.assign({}, body, { pin: state.pin }))
    });
    const j = await res.json();
    if (j && j.ok) return { status: "ok", json: j };
    return { status: "error", error: j && j.error ? j.error : "unknown" };
  } catch (e) {
    return { status: "unknown" }; // 応答未読：成功しているかもしれない
  }
}
// 読み戻したスナップショットに、その操作の結果が反映されているか
function verifyLanded(op, snap) {
  const b = op.body;
  switch (b.action) {
    case "setRecord":
      return snap.records.some((r) => r.date === b.date && r.choreId === b.choreId && r.who === b.who);
    case "clearRecord":
      return !snap.records.some((r) => r.date === b.date && r.choreId === b.choreId);
    case "setTarget": {
      const has = snap.targets.some((t) => t.scope === b.scope && t.key === normalizeTargetKey(b.scope, b.key) && t.choreId === b.choreId);
      return has === Boolean(b.on);
    }
    case "addChore":
      return snap.chores.some((c) => c.name === b.chore.name && !c.deleted);
    case "updateChore": {
      const c = snap.chores.find((x) => x.id === b.id);
      return Boolean(c && c.name === b.chore.name && (c.minutes || 0) === (b.chore.minutes || 0));
    }
    case "deleteChore": {
      const c = snap.chores.find((x) => x.id === b.id);
      return Boolean(c && c.deleted);
    }
    case "restoreChore": {
      const c = snap.chores.find((x) => x.id === b.id);
      return Boolean(c && !c.deleted);
    }
  }
  return true;
}
function messageFor(op) {
  if (op._result && op._result.status === "error") {
    const err = op._result.error;
    if (err === "duplicate_name") return "同じ名前の家事が既にあります";
    if (err === "conflict") return "他の人が先に編集していました。最新の内容で開き直しました";
    return "保存できませんでした（" + (err || "unknown") + "）";
  }
  return "保存できたか確認できませんでした。最新の状態を表示しています";
}
// 検証でサーバー状態を取り込んだ直後、まだ未送信の操作の楽観状態を再適用する
function reapplyQueuedOps() {
  for (const op of writeQueue) {
    const b = op.body;
    if (b.action === "setRecord") applyLocalRecord(b.date, b.choreId, b.who);
    else if (b.action === "clearRecord") applyLocalRecord(b.date, b.choreId, null);
    else if (b.action === "setTarget") applyLocalTargetRaw(b.scope, b.key, b.choreId, b.on);
    else if (b.action === "addChore") { if (op.localChore && !choreById(op.localChore.id)) state.chores.push(op.localChore); }
    else if (b.action === "updateChore") { const c = choreById(b.id); if (c) Object.assign(c, b.chore); }
    else if (b.action === "deleteChore") { const c = choreById(b.id); if (c) c.deleted = true; }
    else if (b.action === "restoreChore") { const c = choreById(b.id); if (c) c.deleted = false; }
  }
}
function handleWriteSuccess(op, json) {
  if (op.body.action === "addChore" && op.tempId && json && json.id) {
    try { replaceTempId(op.tempId, json.id); render(); } catch (e) { /* 付け替え失敗は次の同期で回復 */ }
  }
}
function reconcileVerifiedOp(op, snap) {
  if (op.body.action === "addChore" && op.tempId) {
    const real = snap.chores.find((c) => c.name === op.body.chore.name && !c.deleted);
    if (real && real.id !== op.tempId) replaceTempId(op.tempId, real.id);
  }
}
function handleWriteFailure(op) {
  const b = op.body;
  if (b.action === "deleteChore" && state.lastDeleted && state.lastDeleted.id === b.id) {
    state.lastDeleted = null;
    document.getElementById("undoBar").classList.add("hidden");
  }
  if (b.action === "restoreChore" && op.undoOnFail) {
    state.lastDeleted = op.undoOnFail;
    document.getElementById("undoText").textContent = `「${op.undoOnFail.name}」を削除しました`;
    document.getElementById("undoBar").classList.remove("hidden");
  }
}
async function processQueue() {
  const outcomes = [];
  let verifyFailed = false;
  let stoppedOffline = false;
  try {
    while (writeQueue.length) {
      if (!navigator.onLine) { stoppedOffline = true; break; }
      const head = writeQueue[0];
      if (head.needsVerify) {
        const snap = await fetchServerState();
        if (!snap) { stoppedOffline = !navigator.onLine; verifyFailed = true; break; }
        if (verifyLanded(head, snap)) {
          writeQueue.shift();
          reconcileVerifiedOp(head, snap);
          applySnap(snap);
          reapplyQueuedOps();
          persistStateCache();
          persistWriteQueue();
          render();
          continue;
        }
        head.needsVerify = false;
        persistWriteQueue();
      }
      const op = writeQueue.shift();
      activeWriteOp = op;
      persistWriteQueue();
      refreshSyncLabel();
      op._result = await postWrite(op.body);
      activeWriteOp = null;
      persistWriteQueue();
      outcomes.push(op);
      if (op._result.status === "ok") handleWriteSuccess(op, op._result.json);
    }
    const needVerify = outcomes.some((o) => o._result.status !== "ok");
    if (needVerify) {
      const snap = await fetchServerState();
      if (snap) {
        const msgs = [];
        for (const o of outcomes) {
          if (o._result.status === "ok") continue;
          if (o._result.status === "error") {
            handleWriteFailure(o);
            msgs.push(messageFor(o));
          } else if (!verifyLanded(o, snap)) {
            handleWriteFailure(o);
            msgs.push(messageFor(o));
          } else {
            reconcileVerifiedOp(o, snap);
          }
        }
        applySnap(snap);
        reapplyQueuedOps();
        state.connected = true;
        persistStateCache();
        render();
        if (msgs.length) showError(msgs[0]);
      } else {
        verifyFailed = true;
        const retained = [];
        for (const o of outcomes) {
          if (o._result.status === "unknown") { o.needsVerify = true; retained.push(o); }
          else if (o._result.status === "error") showError(messageFor(o));
        }
        if (retained.length) {
          writeQueue.unshift(...retained);
          persistWriteQueue();
          if (navigator.onLine) showError("保存できたか確認できませんでした。接続が回復したら自動で確認します");
        }
      }
    }
  } finally {
    activeWriteOp = null;
    queueRunning = false;
    persistWriteQueue();
    if (verifyFailed) state.connected = false;
    else if (!stoppedOffline && !writeQueue.length) state.connected = true;
    if (writeQueue.length && navigator.onLine && !verifyFailed && !stoppedOffline) kickQueue();
    else refreshSyncLabel();
  }
}
// 追加した家事の仮IDを、サーバー発行の実IDへ付け替える（記録・対象・未送信操作も追随）
function replaceTempId(oldId, newId) {
  const c = choreById(oldId);
  if (c) c.id = newId;
  if (state.openSteps.has(oldId)) { state.openSteps.delete(oldId); state.openSteps.add(newId); }
  if (state.editingId === oldId) state.editingId = newId;
  if (state.lastDeleted && state.lastDeleted.id === oldId) state.lastDeleted.id = newId;
  for (const r of state.records) if (r.choreId === oldId) r.choreId = newId;
  for (const t of state.targets) if (t.choreId === oldId) t.choreId = newId;
  for (const q of writeQueue) {
    if (q.body.choreId === oldId) q.body.choreId = newId;
    if (q.body.id === oldId) q.body.id = newId;
    if (q.key) q.key = q.key.split(oldId).join(newId);
    if (q.localChore && q.localChore.id === oldId) q.localChore.id = newId;
  }
  persistWriteQueue();
  persistStateCache();
}

/* ---------- 記録・対象の操作（楽観反映 → キューで送信） ---------- */
function applyLocalRecord(date, choreId, who) {
  const idx = state.records.findIndex((r) => r.date === date && r.choreId === choreId);
  if (who === null) { if (idx >= 0) state.records.splice(idx, 1); }
  else if (idx >= 0) state.records[idx].who = who;
  else state.records.push({ date, choreId, who });
}
function tapWho(choreId, who) {
  checkDateRollover();
  const date = todayStr();
  const cur = recordMap().get(date + "|" + choreId) || null;
  const next = cur === who ? null : who;
  applyLocalRecord(date, choreId, next);
  persistStateCache();
  render();
  if (next === null) {
    enqueueWrite({ key: "rec|" + date + "|" + choreId, body: { action: "clearRecord", date, choreId } });
  } else {
    enqueueWrite({ key: "rec|" + date + "|" + choreId, body: { action: "setRecord", date, choreId, who: next } });
  }
}
function applyLocalTargetRaw(scope, key, choreId, on) {
  const idx = state.targets.findIndex((t) => t.scope === scope && t.key === key && t.choreId === choreId);
  if (on && idx < 0) state.targets.push({ scope, key, choreId });
  if (!on && idx >= 0) state.targets.splice(idx, 1);
}
function applyLocalTarget(choreId, on) {
  const { scope, key } = targetKey();
  applyLocalTargetRaw(scope, key, choreId, on);
}
function setTarget(choreId, on) {
  checkDateRollover();
  applyLocalTarget(choreId, on);
  persistStateCache();
  render();
  const { scope, key } = targetKey();
  enqueueWrite({
    key: "tgt|" + scope + "|" + key + "|" + choreId,
    body: { action: "setTarget", scope, key, choreId, on }
  });
}
function applyPreset() {
  const { meal, laundry } = state.presets;
  const daily = activeChores("daily");
  const want = new Set();
  for (const c of daily) {
    if (c.group === "everyday" || c.group === "stock" || !c.group) want.add(c.id);
    if (meal === "cook" && c.group === "cook") want.add(c.id);
    if (meal === "eatout" && c.group === "eatout") want.add(c.id);
    if (laundry && c.group === "laundry") want.add(c.id);
  }
  const cur = targetSet();
  const { scope, key } = targetKey();
  for (const c of daily) {
    const should = want.has(c.id);
    if (should !== cur.has(c.id)) {
      applyLocalTarget(c.id, should);
      enqueueWrite({
        key: "tgt|" + scope + "|" + key + "|" + c.id,
        body: { action: "setTarget", scope, key, choreId: c.id, on: should }
      });
    }
  }
  persistStateCache();
  render();
}

/* ---------- 描画 ---------- */
function whoButtonsHtml(chore, todayWho) {
  return WHO_LIST.map((w) =>
    `<button type="button" class="who-btn ${todayWho === w ? "sel-" + WHO_CLASS[w] : ""}" data-act="who" data-id="${esc(chore.id)}" data-who="${w}" aria-pressed="${todayWho === w ? "true" : "false"}" aria-label="${esc(chore.name)}：${w}">${w}</button>`
  ).join("");
}
function shareHtml(records, totalLabel) {
  const s = shareOf(records);
  if (s.total <= 0) return `<p class="empty-note">まだ記録なし</p>`;
  const conic = `conic-gradient(var(--takuya) 0 ${s.pT}%, var(--aya) ${s.pT}% 100%)`;
  return `<div class="share-wrap">
    <div class="donut" style="background:${conic}"><div class="donut-inner">${esc(totalLabel)}<br>${records.length}件</div></div>
    <div class="share-legend">
      <div class="row"><span><span class="dot" style="background:var(--takuya)"></span>卓也</span><strong>${s.pT}%</strong></div>
      <div class="row"><span><span class="dot" style="background:var(--aya)"></span>あや</span><strong>${s.pA}%</strong></div>
      <div class="row" style="color:var(--muted);font-size:12px"><span>内訳</span><span>卓也 ${s.raw["卓也"]}件／あや ${s.raw["あや"]}件／ふたりで ${s.raw["ふたりで"]}件（半分ずつ按分）</span></div>
      <div class="share-bar"><div style="width:${s.pT}%;background:var(--takuya)"></div><div style="width:${s.pA}%;background:var(--aya)"></div></div>
    </div>
  </div>`;
}
function renderShare() {
  const mk = monthKeyOf(todayStr());
  const recs = state.records.filter((r) => monthKeyOf(r.date) === mk);
  document.getElementById("shareBody").innerHTML = shareHtml(recs, "今月");
}
function renderTodayDone() {
  const t = todayStr();
  const recs = state.records.filter((r) => r.date === t);
  const body = document.getElementById("todayDoneBody");
  if (!recs.length) { body.innerHTML = `<p class="empty-note">今日はまだなし</p>`; return; }
  body.innerHTML = `<div class="done-chips">` + recs.map((r) => {
    const c = choreById(r.choreId);
    const name = c ? c.name : "(削除済み)";
    return `<span class="done-chip">${esc(name)}<span class="badge ${WHO_CLASS[r.who]}">${esc(r.who)}</span></span>`;
  }).join("") + `</div><p class="target-meta" style="margin-top:8px">${recs.length}件</p>`;
}
function renderTargetPanel() {
  const el = document.getElementById("target-daily");
  if (!el) return;
  const set = targetSet();
  // 頻度を問わず、今日の対象に選んだ全家事が対象（毎日／週1回／月1回すべて）
  const items = activeChores().filter((c) => set.has(c.id));
  if (!items.length) {
    el.innerHTML = `<p class="empty-note">対象が選ばれていません。各家事の「${TARGET_LABEL}」ボタンで入れてください（週1回・月1回の家事も入れられます）。</p>`;
    return;
  }
  const map = recordMap();
  const t = todayStr();
  let doneCount = 0, totalMin = 0, restMin = 0;
  const rows = items.map((c) => {
    const todayWho = map.get(t + "|" + c.id) || null;
    const done = Boolean(todayWho);
    if (done) doneCount += 1;
    totalMin += c.minutes || 0;
    if (!done) restMin += c.minutes || 0;
    return `<div class="target-row">
      <span class="name">${esc(c.name)}<span class="badge freq">${esc(FREQ_LABEL[c.freq] || "")}</span><span class="badge ${done ? "done" : "todo"}">${done ? "完了" : "未完了"}</span></span>
      <span class="who-row" style="margin:0;flex:1 1 200px">${whoButtonsHtml(c, todayWho)}</span>
      <button type="button" class="mini-btn" data-act="untarget" data-id="${esc(c.id)}" aria-label="${esc(c.name)}を今日の対象から外す">対象から外す</button>
    </div>`;
  }).join("");
  const pct = Math.round((doneCount / items.length) * 100);
  el.innerHTML = `<div class="target-meta">対象 ${items.length}件中 ${doneCount}件完了 ｜ 合計見込み 約${totalMin}分（残り 約${restMin}分）</div>
    <div class="progress"><div style="width:${pct}%"></div></div>` + rows;
}
function choreCardHtml(c, freq) {
  const t = todayStr();
  const todayWho = recordMap().get(t + "|" + c.id) || null;
  const rec = periodRecord(c.id, freq);
  const inTarget = targetSet().has(c.id);
  let status = "";
  if (freq === "daily") {
    status = todayWho ? `${todayWho}が実施` : "今日は未実施";
  } else if (rec) {
    status = `${rec.date.slice(5).replace("-", "/")} に${rec.who}が実施`;
  } else {
    status = freq === "weekly" ? "今週は未実施" : "今月は未実施";
  }
  const stepsOpen = state.openSteps.has(c.id);
  let stepsHtml = "";
  if (stepsOpen) {
    if (state.editingId === c.id) {
      stepsHtml = editFormHtml(c);
    } else {
      const steps = String(c.steps || "").split("\n").map((s) => s.trim()).filter(Boolean);
      stepsHtml = `<div class="steps">${steps.length ? "<ol>" + steps.map((s) => `<li>${esc(s)}</li>`).join("") + "</ol>" : `<p class="empty-note">やり方は未登録（編集で追加できます）</p>`}
        <div class="form-btns"><button type="button" class="plain-btn" data-act="edit" data-id="${esc(c.id)}">やり方・時間を編集</button>
        ${c.custom ? `<button type="button" class="danger-btn" data-act="del" data-id="${esc(c.id)}">この家事を削除</button>` : ""}</div></div>`;
    }
  }
  return `<div class="chore ${rec ? "done" : ""}" data-card="${esc(c.id)}">
    <div class="chore-top"><span class="chore-name">${esc(c.name)}</span>
      <span class="chore-min">約${c.minutes || 10}分</span>
      ${c.custom ? `<span class="custom-badge">追加</span>` : ""}
      ${rec ? `<span class="badge done">✓完了</span>` : ""}</div>
    <div class="chore-status">${esc(status)}</div>
    <div class="who-row">${whoButtonsHtml(c, todayWho)}</div>
    <div class="chore-foot">
      <button type="button" class="foot-btn ${inTarget ? "on" : ""}" data-act="target" data-id="${esc(c.id)}" aria-pressed="${inTarget ? "true" : "false"}">${TARGET_LABEL}${inTarget ? " ✓" : ""}</button>
      <button type="button" class="foot-btn" data-act="steps" data-id="${esc(c.id)}" aria-expanded="${stepsOpen ? "true" : "false"}">やり方${stepsOpen ? "を閉じる" : ""}</button>
    </div>
    ${stepsHtml}
  </div>`;
}
function editFormHtml(c) {
  return `<form class="edit-form" data-form="edit" data-id="${esc(c.id)}">
    <label for="edit-name-${esc(c.id)}">名前</label><input id="edit-name-${esc(c.id)}" name="name" value="${esc(c.name)}" maxlength="60" required>
    <label for="edit-freq-${esc(c.id)}">頻度</label><select id="edit-freq-${esc(c.id)}" name="freq">
      ${Object.keys(FREQ_LABEL).map((f) => `<option value="${f}" ${c.freq === f ? "selected" : ""}>${FREQ_LABEL[f]}</option>`).join("")}
    </select>
    <label for="edit-minutes-${esc(c.id)}">所要時間（分）</label><input id="edit-minutes-${esc(c.id)}" name="minutes" type="number" min="0" max="600" step="1" value="${c.minutes || 0}">
    <label for="edit-steps-${esc(c.id)}">やり方（1行に1手順）</label><textarea id="edit-steps-${esc(c.id)}" name="steps" rows="5" maxlength="2000">${esc(c.steps || "")}</textarea>
    <div class="form-btns">
      <button type="submit" class="primary-btn">保存</button>
      <button type="button" class="plain-btn" data-act="canceledit">キャンセル</button>
    </div>
    <p class="form-note">保存するとあやの画面にも反映されます。</p>
  </form>`;
}
function groupedChores(freq) {
  const items = activeChores(freq);
  if (state.groupMode[freq] === "time") {
    return TIME_BANDS.map(([lo, hi, label]) => ({
      label,
      items: items.filter((c) => { const m = c.minutes || 10; return m >= lo && m <= hi; })
    })).filter((g) => g.items.length);
  }
  if (freq === "daily") {
    return DAILY_GROUPS.map(([key, label]) => ({
      label,
      items: items.filter((c) => (c.group || "") === key)
    })).filter((g) => g.items.length);
  }
  return [{ label: "", items }];
}
function renderList(freq) {
  const el = document.getElementById("list-" + freq);
  const groups = groupedChores(freq);
  if (!groups.length) { el.innerHTML = `<p class="empty-note">家事がありません</p>`; }
  else {
    el.innerHTML = groups.map((g) =>
      (g.label ? `<div class="group-title">${esc(g.label)}</div>` : "") +
      g.items.map((c) => choreCardHtml(c, freq)).join("")
    ).join("");
  }
  document.querySelectorAll(`#view-${freq} .seg-btn`).forEach((b) => {
    const active = b.dataset.mode === state.groupMode[freq];
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", active ? "true" : "false");
  });
  // 追加フォーム
  const addEl = document.getElementById("add-" + freq);
  if (!state.addOpen[freq]) {
    addEl.innerHTML = `<button type="button" class="add-open-btn" data-act="addopen" data-freq="${freq}">＋ 家事を追加</button>`;
  } else {
    addEl.innerHTML = `<form class="add-form" data-form="add" data-freq="${freq}">
      <label for="add-name-${freq}">家事の名前（必須）</label><input id="add-name-${freq}" name="name" maxlength="60" required placeholder="例：浴室の鏡磨き">
      <label for="add-freq-${freq}">頻度</label><select id="add-freq-${freq}" name="freq">${Object.keys(FREQ_LABEL).map((f) => `<option value="${f}" ${f === freq ? "selected" : ""}>${FREQ_LABEL[f]}</option>`).join("")}</select>
      <label for="add-minutes-${freq}">所要時間（分・任意）</label><input id="add-minutes-${freq}" name="minutes" type="number" min="0" max="600" step="1" placeholder="10">
      <label for="add-steps-${freq}">やり方（任意・1行に1手順）</label><textarea id="add-steps-${freq}" name="steps" rows="4" maxlength="2000"></textarea>
      <div class="form-btns"><button type="submit" class="primary-btn">追加する</button>
      <button type="button" class="plain-btn" data-act="addcancel" data-freq="${freq}">やめる</button></div>
      <p class="form-note">追加するとあやの画面にも表示されます。</p>
    </form>`;
  }
}
function renderHistory() {
  const now = new Date();
  if (!state.calCursor) state.calCursor = { y: now.getFullYear(), m: now.getMonth() };
  if (!state.selectedDay) state.selectedDay = todayStr();
  const { y, m } = state.calCursor;
  document.getElementById("calTitle").textContent = `${y}年${m + 1}月`;
  const mk = y + "-" + pad(m + 1);
  const monthRecs = state.records.filter((r) => monthKeyOf(r.date) === mk);
  document.getElementById("monthShare").innerHTML = shareHtml(monthRecs, `${m + 1}月`);
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const startDate = addDays(fmtDate(first), -startDow);
  const t = todayStr();
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const ds = addDays(startDate, i);
    const inMonth = monthKeyOf(ds) === mk;
    const recs = state.records.filter((r) => r.date === ds);
    const s = shareOf(recs);
    cells += `<button type="button" class="cal-cell ${inMonth ? "" : "out"} ${ds === t ? "today" : ""} ${ds === state.selectedDay ? "selected" : ""}" data-act="day" data-day="${ds}" aria-pressed="${ds === state.selectedDay ? "true" : "false"}" aria-label="${Number(ds.slice(5, 7))}月${Number(ds.slice(8))}日${recs.length ? "、" + recs.length + "件の記録" : "、記録なし"}">
      <div>${Number(ds.slice(8))}${ds === t ? " 今日" : ""}</div>
      ${recs.length ? `<div class="cnt">${recs.length}件</div><div class="mini-bar"><div style="width:${s.pT}%;background:var(--takuya)"></div><div style="width:${s.pA}%;background:var(--aya)"></div></div>` : ""}
    </button>`;
    if (i >= 35 && monthKeyOf(addDays(startDate, i + 1)) !== mk && new Date(y, m + 1, 0).getDate() + startDow <= i + 1) break;
  }
  document.getElementById("calendar").innerHTML = cells;
  // 日別詳細
  const ds = state.selectedDay;
  const d = parseDate(ds);
  document.getElementById("dayDetailTitle").textContent = `${d.getMonth() + 1}/${d.getDate()} の記録`;
  const recs = state.records.filter((r) => r.date === ds);
  const detail = document.getElementById("dayDetail");
  if (!recs.length) detail.innerHTML = `<p class="empty-note">この日の記録はありません</p>`;
  else {
    const s = shareOf(recs);
    detail.innerHTML = `<p class="target-meta">卓也 ${s.pT}% ／ あや ${s.pA}%（${recs.length}件）</p>` + recs.map((r) => {
      const c = choreById(r.choreId);
      return `<div class="day-row"><span>${esc(c ? c.name : "(削除済み)")}</span><span class="badge ${WHO_CLASS[r.who]}">${esc(r.who)}</span></div>`;
    }).join("");
  }
}
function renderPresets() {
  const cook = document.getElementById("presetCook");
  const eatout = document.getElementById("presetEatout");
  const laundry = document.getElementById("presetLaundry");
  cook.classList.toggle("on", state.presets.meal === "cook");
  cook.setAttribute("aria-pressed", state.presets.meal === "cook" ? "true" : "false");
  eatout.classList.toggle("on", state.presets.meal === "eatout");
  eatout.setAttribute("aria-pressed", state.presets.meal === "eatout" ? "true" : "false");
  laundry.classList.toggle("on", state.presets.laundry);
  laundry.setAttribute("aria-pressed", state.presets.laundry ? "true" : "false");
}
function render(options) {
  const keepScroll = !options || options.keepScroll !== false;
  const scrollY = window.scrollY || 0;
  updateTodayLabel();
  const versionEl = document.getElementById("appVersion");
  if (versionEl) versionEl.textContent = "v" + APP_VERSION;
  document.getElementById("apiNotice").classList.toggle("hidden", Boolean(API_URL));
  for (const freq of ["daily", "weekly", "monthly"]) {
    document.getElementById("view-" + freq).classList.toggle("hidden", state.tab !== freq);
    if (state.tab === freq) renderList(freq);
  }
  document.getElementById("view-history").classList.toggle("hidden", state.tab !== "history");
  if (state.tab === "daily") { renderShare(); renderTodayDone(); renderPresets(); renderTargetPanel(); }
  if (state.tab === "history") renderHistory();
  document.querySelectorAll(".tab").forEach((b) => {
    const active = b.dataset.tab === state.tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  window.scrollTo(0, keepScroll ? scrollY : 0);
}

/* ---------- イベント ---------- */
document.addEventListener("click", async (e) => {
  if (e.target.id === "retryLoadButton") { window.location.reload(); return; }
  const tabBtn = e.target.closest(".tab");
  if (tabBtn) { state.tab = tabBtn.dataset.tab; render({ keepScroll: false }); return; }
  const seg = e.target.closest(".seg-btn");
  if (seg) {
    const view = seg.closest(".view");
    const freq = view.id.replace("view-", "");
    state.groupMode[freq] = seg.dataset.mode;
    render();
    return;
  }
  if (e.target.id === "presetCook" || e.target.id === "presetEatout") {
    const meal = e.target.id === "presetCook" ? "cook" : "eatout";
    state.presets.meal = state.presets.meal === meal ? null : meal;
    renderPresets();
    await applyPreset();
    return;
  }
  if (e.target.id === "presetLaundry") {
    state.presets.laundry = !state.presets.laundry;
    renderPresets();
    await applyPreset();
    return;
  }
  if (e.target.id === "calPrev" || e.target.id === "calNext") {
    const c = state.calCursor;
    const d = new Date(c.y, c.m + (e.target.id === "calNext" ? 1 : -1), 1);
    state.calCursor = { y: d.getFullYear(), m: d.getMonth() };
    render();
    return;
  }
  if (e.target.id === "undoButton") {
    const del = state.lastDeleted;
    if (del) {
      state.lastDeleted = null;
      document.getElementById("undoBar").classList.add("hidden");
      const c = choreById(del.id);
      if (c) c.deleted = false;
      render();
      persistStateCache();
      enqueueWrite({
        body: { action: "restoreChore", id: del.id },
        undoOnFail: del
      });
    }
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === "who") { await tapWho(id, btn.dataset.who); return; }
  if (act === "target") {
    await setTarget(id, !targetSet().has(id));
    return;
  }
  if (act === "untarget") { await setTarget(id, false); return; }
  if (act === "steps") {
    if (state.openSteps.has(id)) state.openSteps.delete(id); else state.openSteps.add(id);
    if (state.editingId === id) state.editingId = null;
    render();
    return;
  }
  if (act === "edit") { state.editingId = id; state.openSteps.add(id); render(); return; }
  if (act === "canceledit") { state.editingId = null; if (!consumeDateRollover()) render(); return; }
  if (act === "del") {
    const c = choreById(id);
    if (!c) return;
    c.deleted = true;
    state.lastDeleted = { id, name: c.name };
    state.editingId = null;
    const bar = document.getElementById("undoBar");
    document.getElementById("undoText").textContent = `「${c.name}」を削除しました`;
    bar.classList.remove("hidden");
    persistStateCache();
    render();
    enqueueWrite({ body: { action: "deleteChore", id } });
    return;
  }
  if (act === "addopen") { state.addOpen[btn.dataset.freq] = true; render(); return; }
  if (act === "addcancel") { state.addOpen[btn.dataset.freq] = false; render(); return; }
  if (act === "day") {
    state.selectedDay = btn.dataset.day;
    const d = parseDate(state.selectedDay);
    state.calCursor = { y: d.getFullYear(), m: d.getMonth() };
    render();
    return;
  }
});

function validateChoreInput(name, freq, minutesRaw, steps, fallbackMinutes) {
  if (!name) return { error: "名前を入力してください" };
  if (name.length > 60) return { error: "名前は60文字以内で入力してください" };
  if (!Object.prototype.hasOwnProperty.call(FREQ_LABEL, freq)) return { error: "頻度を選んでください" };
  if (steps.length > 2000) return { error: "やり方は2000文字以内で入力してください" };
  if (minutesRaw === "") return { minutes: fallbackMinutes };
  if (!/^\d+$/.test(minutesRaw)) return { error: "所要時間は0〜600の整数で入力してください" };
  const minutes = Number(minutesRaw);
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 600) return { error: "所要時間は0〜600の整数で入力してください" };
  return { minutes: minutes };
}

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const name = String(fd.get("name") || "").trim();
  const freq = String(fd.get("freq") || "daily");
  const minutesRaw = String(fd.get("minutes") || "").trim();
  let minutes = minutesRaw === "" ? NaN : Number(minutesRaw);
  const steps = String(fd.get("steps") || "");
  if (form.dataset.form === "add") {
    const checked = validateChoreInput(name, freq, minutesRaw, steps, 10);
    if (checked.error) { showError(checked.error); return; }
    minutes = checked.minutes;
    if (activeChores().some((c) => c.name === name)) { showError("同じ名前の家事が既にあります"); return; }
    const tempId = "tmp" + Date.now().toString(36);
    const newChore = { id: tempId, name, freq, group: "", steps, minutes, custom: true, deleted: false, order: 9999 };
    state.chores.push(newChore);
    state.addOpen[form.dataset.freq] = false;
    const tabChanged = state.tab !== freq;
    state.tab = freq;
    persistStateCache();
    render({ keepScroll: !tabChanged });
    enqueueWrite({
      body: { action: "addChore", chore: { name, freq, steps, minutes } },
      localChore: newChore,
      tempId: tempId
    });
    return;
  }
  if (form.dataset.form === "edit") {
    const id = form.dataset.id;
    const c = choreById(id);
    if (!c) return;
    const checked = validateChoreInput(name, freq, minutesRaw, steps, c.minutes || 0);
    if (checked.error) { showError(checked.error); return; }
    minutes = checked.minutes;
    if (activeChores().some((other) => other.id !== id && other.name === name)) { showError("同じ名前の家事が既にあります"); return; }
    const expectName = c.name;
    Object.assign(c, { name, freq, steps, minutes });
    state.editingId = null;
    const tabChanged = state.tab !== freq;
    state.tab = freq;
    persistStateCache();
    render({ keepScroll: !tabChanged });
    consumeDateRollover();
    enqueueWrite({
      body: { action: "updateChore", id, expect: { name: expectName }, chore: { name, freq, steps, minutes } }
    });
  }
});

/* ---------- 起動・同期 ---------- */
async function init() {
  const now = new Date();
  state.calCursor = { y: now.getFullYear(), m: now.getMonth() };
  state.selectedDay = todayStr();
  state.currentDate = todayStr();
  const hadCache = loadStateCache();
  restoreWriteQueue();
  if (writeQueue.length) reapplyQueuedOps();
  render();
  if (hadCache) setLoadingState("hidden");
  else setLoadingState("loading");

  const snap = API_URL ? await fetchServerState() : null;
  if (snap) {
    const beforeHash = stateHash(state);
    applySnap(snap);
    reapplyQueuedOps();
    state.connected = true;
    state.hasCachedState = true;
    persistStateCache();
    setLoadingState("hidden");
    refreshSyncLabel();
    if (stateHash(state) !== beforeHash) render();
  } else {
    state.connected = false;
    if (hadCache || state.chores.length) setLoadingState("hidden");
    else setLoadingState("error");
    refreshSyncLabel();
  }
  kickQueue();

  setInterval(async () => {
    checkDateRollover();
    if (state.editingId) return; // 編集中は上書きしない
    if (hasPendingOps()) { kickQueue(); return; }
    if (await refreshFromServer()) render();
  }, 15000);
  setInterval(() => { checkDateRollover(); }, 60000);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    checkDateRollover();
    if (state.editingId) return;
    if (hasPendingOps()) { kickQueue(); return; }
    if (await refreshFromServer()) render();
  });
  window.addEventListener("focus", () => { checkDateRollover(); });
  window.addEventListener("online", () => { refreshSyncLabel(); kickQueue(); });
  window.addEventListener("offline", () => { refreshSyncLabel(); });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}
init();
