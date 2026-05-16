'use strict';
/* ============================================================
   VEZOO — Shared Firebase + Utilities
   ============================================================ */

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCVawrhK5yZCwb6wCfmZ9fiD7_nolsiwak",
  authDomain:        "vezoo-delivery.firebaseapp.com",
  projectId:         "vezoo-delivery",
  storageBucket:     "vezoo-delivery.firebasestorage.app",
  messagingSenderId: "619257731960",
  appId:             "1:619257731960:web:ddd1500325d6c1b462868d",
  measurementId:     "G-LSKS6HCHPV"
};

const WEBAPP_BASE = "https://mathian.github.io/vezoo";
const PFX = 'vez_'; // localStorage prefix

// ── Firebase state ──
let db   = null;
let _fbR = false;

function initFirebase() {
  return new Promise(resolve => {
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      const timer = setTimeout(() => {
        console.warn('[Firebase] Auth timeout — offline mode');
        resolve();
      }, 6000);
      firebase.auth().signInAnonymously()
        .then(() => { clearTimeout(timer); _fbR = true; console.log('[Firebase] Auth OK'); resolve(); })
        .catch(e  => { clearTimeout(timer); console.warn('[Firebase] Auth fail:', e.message); resolve(); });
    } catch (e) {
      console.error('[Firebase] Init error:', e);
      resolve();
    }
  });
}

// ── Write (merge) ──
// Returns true on success (or offline), false if Firestore rejected the write.
async function dbSet(col, id, data) {
  const payload = { ...data, _upd: new Date().toISOString() };
  try { localStorage.setItem(`${PFX}${col}_${id}`, JSON.stringify(payload)); } catch {}
  if (!_fbR) return true;  // offline mode — treated as optimistic success
  try {
    await db.collection(col).doc(String(id)).set(payload, { merge: true });
    return true;
  } catch (e) {
    console.warn(`[DB] set ${col}/${id}:`, e.message);
    return false;
  }
}

// ── Delete ──
async function dbDelete(col, id) {
  try { localStorage.removeItem(`${PFX}${col}_${id}`); } catch {}
  if (!_fbR) return;
  try { await db.collection(col).doc(String(id)).delete(); }
  catch (e) { console.warn(`[DB] del ${col}/${id}:`, e.message); }
}

// ── Update (dot-notation nested fields) ──
async function dbUpdate(col, id, dotFields) {
  // Update localStorage cache
  try {
    const key = `${PFX}${col}_${id}`;
    const cached = JSON.parse(localStorage.getItem(key) || '{}');
    for (const [k, v] of Object.entries(dotFields)) {
      const parts = k.split('.');
      let obj = cached;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = v;
    }
    localStorage.setItem(key, JSON.stringify(cached));
  } catch {}
  if (!_fbR) return;
  try { await db.collection(col).doc(String(id)).update(dotFields); }
  catch (e) {
    // Doc may not exist yet — fall back to set+merge
    if (e.code === 'not-found' || (e.message && e.message.includes('No document'))) {
      const plain = {};
      for (const [k, v] of Object.entries(dotFields)) {
        const parts = k.split('.');
        let obj = plain;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]]) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = v;
      }
      try { await db.collection(col).doc(String(id)).set(plain, { merge: true }); }
      catch (e2) { console.warn(`[DB] update/set ${col}/${id}:`, e2.message); }
    } else {
      console.warn(`[DB] update ${col}/${id}:`, e.message);
    }
  }
}

// ── Read one ──
async function dbGet(col, id) {
  if (_fbR) {
    try {
      const s = await db.collection(col).doc(String(id)).get();
      if (s.exists) {
        const d = s.data();
        try { localStorage.setItem(`${PFX}${col}_${id}`, JSON.stringify(d)); } catch {}
        return d;
      } else {
        // Firestore confirmed the document was deleted — clear stale local cache
        // and return null immediately (do NOT fall through to stale localStorage).
        try { localStorage.removeItem(`${PFX}${col}_${id}`); } catch {}
        return null;
      }
    } catch (e) { console.warn(`[DB] get ${col}/${id}:`, e.message); }
  }
  // Offline fallback: use locally cached value if Firebase is unavailable
  try { const r = localStorage.getItem(`${PFX}${col}_${id}`); return r ? JSON.parse(r) : null; }
  catch { return null; }
}

// ── Query (one condition) ──
async function dbQuery(col, field, op, value) {
  if (_fbR) {
    try {
      const snap = await db.collection(col).where(field, op, value).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn(`[DB] query ${col}:`, e.message); }
  }
  return [];
}

// ── Query with multiple conditions ──
async function dbQueryWhere(col, conditions, orderByField = null, dir = 'desc', lim = 200) {
  if (_fbR) {
    try {
      let q = db.collection(col);
      for (const [f, op, v] of conditions) q = q.where(f, op, v);
      if (orderByField) q = q.orderBy(orderByField, dir);
      if (lim) q = q.limit(lim);
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn(`[DB] queryWhere ${col}:`, e.message); }
  }
  return [];
}

// ── Ordered query ──
async function dbQueryOrdered(col, field, op, value, orderBy, dir = 'desc', lim = 100) {
  if (_fbR) {
    try {
      let q = db.collection(col).where(field, op, value).orderBy(orderBy, dir);
      if (lim) q = q.limit(lim);
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn(`[DB] qOrdered ${col}:`, e.message); }
  }
  return [];
}

// ── Get all docs ──
async function dbGetAll(col, orderBy = null, dir = 'asc', lim = 300) {
  if (_fbR) {
    try {
      let q = db.collection(col);
      if (orderBy) q = q.orderBy(orderBy, dir);
      if (lim) q = q.limit(lim);
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn(`[DB] getAll ${col}:`, e.message); }
  }
  return [];
}

// ── Real-time doc listener ──
function onDocSnap(col, id, cb) {
  if (_fbR) {
    try {
      return db.collection(col).doc(String(id)).onSnapshot(
        s => cb(s.exists ? { id: s.id, ...s.data() } : null),
        e => console.warn('[DB] docSnap:', e.message)
      );
    } catch {}
  }
  let last = null;
  const t = setInterval(async () => {
    const d = await dbGet(col, id);
    const j = JSON.stringify(d);
    if (j !== last) { last = j; cb(d); }
  }, 15000);
  return () => clearInterval(t);
}

// ── Real-time query listener ──
function onQuerySnap(col, field, op, value, cb) {
  if (_fbR) {
    try {
      return db.collection(col).where(field, op, value).onSnapshot(
        s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))),
        e => console.warn('[DB] qSnap:', e.message)
      );
    } catch {}
  }
  const t = setInterval(async () => cb(await dbQuery(col, field, op, value)), 15000);
  return () => clearInterval(t);
}

// ── Real-time collection listener ──
function onColSnap(col, cb, orderBy = null, dir = 'asc') {
  if (_fbR) {
    try {
      let q = db.collection(col);
      if (orderBy) q = q.orderBy(orderBy, dir);
      return q.onSnapshot(
        s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))),
        e => console.warn('[DB] colSnap:', e.message)
      );
    } catch {}
  }
  const t = setInterval(async () => cb(await dbGetAll(col, orderBy, dir)), 15000);
  return () => clearInterval(t);
}

// ── Real-time query listener (multiple conditions) ──
// NOTE: Requires composite Firestore index for multi-field queries.
// E.g. for orders: venueId ASC + active ASC
function onQuerySnapWhere(col, conditions, cb) {
  if (_fbR) {
    try {
      let q = db.collection(col);
      for (const [f, op, v] of conditions) q = q.where(f, op, v);
      return q.onSnapshot(
        s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))),
        e => console.warn('[DB] qSnapWhere:', e.message)
      );
    } catch {}
  }
  const t = setInterval(async () => cb(await dbQueryWhere(col, conditions)), 15000);
  return () => clearInterval(t);
}

// ── Courier helpers (Дыра №7) ──
// Each courier keeps its individual doc (needed for status queries in superadmin).
// Additionally, all couriers are mirrored into couriers/all: { couriers: { uid: {...} } }
// for fast bulk lookups (avoids N separate Firestore reads per courier list).
async function getCourier(uid) {
  // Individual doc is authoritative — SA queries run against individual docs,
  // so we must check it first. If it was manually deleted, dbGet returns null
  // (after the dbGet fix: Firestore "not found" clears stale cache and returns null).
  const indiv = await dbGet('couriers', uid);
  if (indiv) return indiv;
  // Fallback: batch doc (covers couriers not yet written individually, or offline).
  const all = await dbGet('couriers', 'all');
  if (all?.couriers?.[uid]) {
    // Individual doc is missing but batch has the data — re-sync so SA queries work.
    if (_fbR) setCourier(uid, all.couriers[uid]); // fire-and-forget
    return all.couriers[uid];
  }
  return null;
}
async function getCourierAll() {
  const doc = await dbGet('couriers', 'all');
  if (doc?.couriers && Object.keys(doc.couriers).length > 0) return doc.couriers;
  // Rebuild from locally cached individual courier docs
  const map = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(`${PFX}couriers_`) || key === `${PFX}couriers_all`) continue;
    try { const c = JSON.parse(localStorage.getItem(key)); if (c?.uid) map[c.uid] = c; } catch {}
  }
  return map;
}
async function setCourier(uid, data) {
  const payload = { ...data, _upd: new Date().toISOString() };
  // Write to individual doc (superadmin queries by status)
  await dbSet('couriers', uid, payload);
  // Mirror into batch doc (fast bulk lookup for admin/courier apps)
  await dbUpdate('couriers', 'all', { [`couriers.${uid}`]: payload });
}

// ── Version bumping (Дыры №2, №3, №4) ──
// field examples: 'venues', 'menu_venueId'
// Хранится в коллекции versions, документ main
async function bumpVersion(field) {
  if (!_fbR) return;
  try {
    await db.collection('versions').doc('main').set(
      { [field]: firebase.firestore.FieldValue.increment(1) },
      { merge: true }
    );
  } catch (e) { console.warn('[Version] bump failed:', e.message); }
}

// ── Firebase UID → HMAC UID mapping ──
// Writes uid_index/fb_{firebaseUid} → {hmacUid} so Firestore Rules can resolve
// the caller's HMAC-based role without relying on request.auth.uid directly.
// Call once during app boot after both initFirebase() and STATE.uid are known.
async function registerFirebaseAuthMapping(hmacUid) {
  if (!_fbR || !hmacUid) return;
  try {
    const firebaseUid = firebase.auth().currentUser?.uid;
    if (!firebaseUid) return;
    await db.collection('uid_index').doc('fb_' + firebaseUid).set(
      { hmacUid, _upd: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) { console.warn('[Firebase] auth mapping:', e.message); }
}

// ── Generate unique ID ──
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function genOrderId() {
  return Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

// ─────────────────────── Sound ───────────────────────
let _audioCtx = null;
function _getCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}
function _tone(freq = 800, dur = 0.18, vol = 0.3) {
  try {
    const ctx = _getCtx();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch {}
}
function playBeep()     { _tone(700,.18,.4); setTimeout(()=>_tone(900,.14,.3),220); }
function playSuccess()  { _tone(600,.1); setTimeout(()=>_tone(800,.1),150); setTimeout(()=>_tone(1000,.22),300); }
function playAlert()    { for(let i=0;i<3;i++) setTimeout(()=>_tone(550,.1,.5),i*200); }
function playNewOrder() { _tone(800,.1,.5);setTimeout(()=>_tone(800,.1,.5),150);setTimeout(()=>_tone(1000,.2,.5),350); }

// ─────────────────────── Format helpers ───────────────────────
function fmtPrice(n, currency = '₸') { return Number(n||0).toLocaleString('ru-RU') + ' ' + currency; }
function fmtDate(ts) {
  if (!ts) return '';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'2-digit'})+' '+
         d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
}
function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000), s = Math.floor((ms%60000)/1000);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ─────────────────────── HTML escaping (C-2 XSS) ───────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusLabel(st) {
  return {
    pending:'Ожидает', accepted:'Принят', cooking:'Готовится',
    searching_courier:'Ищем курьера', courier_assigned:'Курьер едет',
    ready_for_courier:'Ждёт курьера',
    delivering:'Доставляется', delivered:'Доставлен', cancelled:'Отменён',
    ready:'Готово', issued:'Выдан'
  }[st] || st;
}
function statusBadgeClass(st) {
  const map = {
    pending:'badge-pending', accepted:'badge-accepted', cooking:'badge-accepted',
    searching_courier:'badge-searching', courier_assigned:'badge-searching',
    ready_for_courier:'badge-delivering',
    delivering:'badge-delivering', delivered:'badge-delivered', cancelled:'badge-cancelled',
    ready:'badge-accepted', issued:'badge-delivered'
  };
  return 'badge ' + (map[st] || 'badge-pending');
}


// ─────────────────────── Telegram WebApp ───────────────────────
const tg = window.Telegram?.WebApp || null;
function tgReady()          { try { tg?.ready(); tg?.expand(); } catch {} }
function tgHaptic(t='light'){ try { tg?.HapticFeedback?.impactOccurred(t); } catch {} }

// ─────────────────────── UID resolver ───────────────────────
async function resolveUidByTgId() {
  try {
    const tgUser = tg?.initDataUnsafe?.user;
    if (!tgUser?.id) return null;
    const tgIdStr = String(tgUser.id);
    // Bot saves uid_index/{tgId} after phone share
    const idx = await dbGet('uid_index', tgIdStr);
    if (idx?.uid) return idx.uid;
    // Fallback: scan users collection by tgId field
    if (_fbR) {
      const snap = await db.collection('users').where('tgId', '==', tgIdStr).limit(1).get();
      if (!snap.empty) return snap.docs[0].data().uid || snap.docs[0].id;
    }
    return null;
  } catch { return null; }
}

// ─────────────────────── State helpers ───────────────────────
function readUidFromUrl() {
  // 1. Telegram WebApp start_param (передаётся через ?startapp= или бот /start uid_xxx)
  const startParam = tg?.initDataUnsafe?.start_param || '';
  if (startParam && startParam.startsWith('u_') && startParam.length > 5) {
    return startParam;
  }
  // 2. Telegram WebApp передаёт параметры через tgWebAppStartParam в hash
  try {
    const hash = new URLSearchParams(location.hash.replace('#', ''));
    const hashUid = hash.get('tgWebAppStartParam') || hash.get('uid');
    if (hashUid && hashUid.length > 5) return hashUid;
  } catch {}
  // 3. Прямой ?uid= в URL (fallback для тестирования в браузере)
  const p = new URLSearchParams(location.search);
  const uid = p.get('uid') || p.get('tgWebAppStartParam');
  if (uid && uid.length > 5) {
    history.replaceState(null, '', location.pathname);
    return uid;
  }
  return null;
}


// ─────────────────────── Screen helper ───────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ─────────────────────── Toast ───────────────────────
function showToast(msg, type = 'info', dur = 3000) {
  let t = document.getElementById('_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_toast';
    t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;width:calc(100% - 40px);max-width:360px;';
    document.body.appendChild(t);
  }
  const item = document.createElement('div');
  const colors = { info:'#3b82f6', success:'#22c55e', warning:'#f59e0b', error:'#ef4444' };
  item.style.cssText = `background:rgba(20,20,28,.98);border:1px solid ${colors[type]||colors.info}40;border-left:3px solid ${colors[type]||colors.info};border-radius:10px;padding:12px 16px;font-size:13px;font-weight:500;color:#f0f0f5;box-shadow:0 4px 20px rgba(0,0,0,.5);animation:toastIn .25s ease;`;
  item.textContent = msg;
  t.appendChild(item);
  setTimeout(()=>{ item.style.opacity='0'; item.style.transform='translateY(-8px)'; item.style.transition='all .25s'; setTimeout(()=>item.remove(),250); }, dur);
}
const _ts = document.createElement('style');
_ts.textContent = '@keyframes toastIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}';
document.head.appendChild(_ts);

// ─────────────────────── Phone normalizer ───────────────────────
function normPhone(raw) {
  if (!raw) return '';
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  // Russian/Kazakh 8-prefix → 7
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  // Strip leading country code duplicates
  if (d.length === 10) d = '7' + d; // bare 10-digit
  return '+' + d;
}

// ─────────────────────── Phone call helper ───────────────────────
function callPhone(phone) {
  const a = document.createElement('a');
  a.href = 'tel:' + phone;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─────────────────────── Order timeline (for admin/operator history) ───────────────────────
function renderOrderTimeline(order) {
  const events = [
    { label: 'Создан',            time: order.createdAt },
    { label: 'Принят',            time: order.acceptedAt },
    { label: 'Поиск курьера',     time: order.searchStartedAt },
    { label: 'Курьер назначен',   time: order.assignedAt },
    { label: 'Передан курьеру',   time: order.handedOverAt },
    { label: 'Доставлен',         time: order.deliveredAt },
    { label: 'Выдан клиенту',     time: order.issuedAt },
    { label: 'Отменён',           time: order.cancelledAt },
  ].filter(e => e.time);
  if (!events.length) return '';
  return `
    <div class="section-title" style="margin:12px 0 6px">Хронология</div>
    <div class="card card-body" style="gap:5px;display:flex;flex-direction:column">
      ${events.map(e => `<div class="flex justify-between"><span class="text-dim text-sm">${e.label}</span><span style="font-size:12px;font-family:monospace">${fmtDate(e.time)}</span></div>`).join('')}
    </div>`;
}

// ─────────────────────── QR helpers ───────────────────────
function renderQrCode(elementId, text, size = 180) {
  let el = document.getElementById(elementId);
  if (!el || !text) return;
  const data = normPhone(text) || text;
  if (typeof QRCode === 'undefined') return;
  if (el.tagName === 'IMG') {
    const div = document.createElement('div');
    div.id = elementId;
    div.style.cssText = `width:${size}px;height:${size}px;display:inline-block;background:#fff;border-radius:12px;padding:8px;box-shadow:0 4px 20px rgba(0,0,0,.3);box-sizing:content-box`;
    el.parentNode.replaceChild(div, el);
    el = div;
  } else {
    el.innerHTML = '';
  }
  new QRCode(el, { text: data, width: size, height: size, colorDark: '#000000', colorLight: '#ffffff' });
}

// ─────────────────────── Venue categories (hard-coded) ───────────────────────
const VENUE_CATEGORIES = [
  { id: 'cafe',     name: 'Кафе',      icon: '🍛', order: 1 },
  { id: 'coffee',   name: 'Кофейня',   icon: '☕', order: 2 },
  { id: 'pizza',    name: 'Пиццерия',  icon: '🍕', order: 3 },
  { id: 'sushi',    name: 'Суши',      icon: '🍣', order: 4 },
  { id: 'fastfood', name: 'Fast Food', icon: '🍔', order: 5 },
  { id: 'flowers',  name: 'Цветочный', icon: '🌸', order: 6 },
];

// ─────────────────────── PIN helpers ───────────────────────
const PIN_DEFAULTS = { admin:'0000', operator:'0000', master:'0000', superadmin:'0000' };

async function verifyPin(role, entered) {
  try {
    const cfg = await dbGet('settings', 'pins');
    const stored = cfg?.[role] || PIN_DEFAULTS[role] || '0000';
    return entered === stored;
  } catch { return entered === '0000'; }
}

async function savePin(role, newPin) {
  await dbSet('settings', 'pins', { [role]: newPin });
}

async function getPinForRole(role) {
  try {
    const cfg = await dbGet('settings', 'pins');
    return cfg?.[role] || '0000';
  } catch { return '0000'; }
}

// ─────────────────────── Rate limiting ───────────────────────
const _rl = {};
function checkRateLimit(key, maxCalls, windowMs) {
  const now = Date.now();
  if (!_rl[key]) _rl[key] = [];
  _rl[key] = _rl[key].filter(t => now - t < windowMs);
  if (_rl[key].length >= maxCalls) return false;
  _rl[key].push(now);
  return true;
}

const _pinFails = {};
function isPinLockedOut(role) {
  const rec = _pinFails[role];
  if (!rec?.until || Date.now() >= rec.until) return 0;
  return Math.ceil((rec.until - Date.now()) / 1000);
}
function recordPinAttempt(role, success) {
  if (!_pinFails[role]) _pinFails[role] = { count: 0, until: 0 };
  if (success) { _pinFails[role].count = 0; return; }
  _pinFails[role].count++;
  if (_pinFails[role].count >= 5) {
    _pinFails[role].until = Date.now() + 60000;
    _pinFails[role].count = 0;
  }
}

// ─────────────────────── Agreement checkbox ───────────────────────
// Универсальная функция для всех ролей — живёт в shared/firebase.js
function toggleAgreeCheck() {
  const cb  = document.getElementById('agree-cb');
  const box = document.getElementById('agree-box');
  const row = document.getElementById('agree-check-row');
  const btn = document.getElementById('agree-btn');
  // Читаем реальное состояние: если есть скрытый <input type="checkbox">,
  // браузер уже переключил его когда пользователь кликнул на <label>
  const checked = cb ? cb.checked : (box?.textContent !== '✓');
  if (box) box.textContent = checked ? '✓' : '';
  if (row) row.classList.toggle('checked', checked);
  if (btn) btn.disabled = !checked;
}
