'use strict';
/* ============================================================
   VEZOO COURIER — Delivery App
   ============================================================ */

const STATE = { uid: null, user: null };
let COURIER_DATA      = null;

// ── Venue cache for courier (Дыра №8) ──
let _courierVenueCache = {};
async function _refreshCourierVenueCache() {
  try {
    const versions = await dbGet('versions', 'main') || {};
    const remoteV  = versions.venues || 0;
    const localV   = parseInt(localStorage.getItem('vez_local_venues_v') || '0');
    const cached   = JSON.parse(localStorage.getItem('vez_venues_data') || '[]');
    if (remoteV > 0 && remoteV === localV && cached.length) {
      for (const v of cached) _courierVenueCache[v.id] = v;
      return;
    }
    const venues = await dbGetAll('venues', 'name', 'asc');
    localStorage.setItem('vez_venues_data', JSON.stringify(venues));
    localStorage.setItem('vez_local_venues_v', String(remoteV));
    for (const v of venues) _courierVenueCache[v.id] = v;
  } catch {}
}
async function _getVenueCached(venueId) {
  if (_courierVenueCache[venueId]) return _courierVenueCache[venueId];
  const v = await dbGet('venues', venueId);
  if (v) _courierVenueCache[venueId] = v;
  return v;
}
let _availUnsub       = null;
let _venueUnsub       = null;
let _myUnsub          = null;
let _availOrders      = [];
let _venueOrders      = [];
let _myOrders         = [];
let _shownAssigned    = new Set();
let _acceptOrderId    = null;
let _acceptOrderIds   = [];
let _acceptFromPool   = 'available'; // 'available' | 'venue'
let _myHistory        = [];
// Key is per-user so two different couriers on the same device don't share history
function _histKey() { return 'vez_courier_hist_' + (STATE.uid || 'anon'); }
function _loadHistoryFromStorage() { try { return JSON.parse(localStorage.getItem(_histKey())||'[]'); } catch { return []; } }
function _saveHistoryToStorage(h)  { try { localStorage.setItem(_histKey(), JSON.stringify(h)); } catch {} }
let _shownImportant   = new Set();
let _openMyOrderId    = null;

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') {
    localStorage.clear(); location.replace(location.pathname); return;
  }
  tgReady();
  _initCourierBackButton();

  const _tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try {
    const s = JSON.parse(localStorage.getItem('vez_courier_state') || '{}');
    if (!_tgUserId || s.tgId === _tgUserId) {
      STATE.uid = s.uid || null; STATE.user = s.user || null;
    }
  } catch {}

  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; _saveState(); }

  await initFirebase();

  if (!STATE.uid) {
    const tgUid = await resolveUidByTgId();
    if (tgUid) { STATE.uid = tgUid; _saveState(); }
  }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing?.blocked || existing?.blockedCourier) { showScreen('s-blocked'); return; }

  if (!existing?.agreedCourier) {
    document.getElementById('s-agree').style.display = 'flex';
    return;
  }

  STATE.user = existing; _saveState();
  // Variant A: SA-triggered per-user cache reset
  if (existing.resetCache === true && !sessionStorage.getItem('_vez_reset_done')) {
    sessionStorage.setItem('_vez_reset_done', '1');
    try { await dbUpdate('users', STATE.uid, { resetCache: false }); } catch {}
    localStorage.clear(); location.reload(); return;
  }
  sessionStorage.removeItem('_vez_reset_done');
  await checkCourierStatus();
});

function _getTgName() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return null;
  return (u.first_name + (u.last_name ? ' ' + u.last_name : '')).trim() || null;
}

function _saveState() {
  const tgId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem('vez_courier_state', JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId })); } catch {}
}

// ── Agreement ──
async function submitAgree() {
  const btn = document.getElementById('agree-btn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  const linkData = await dbGet('user_links', STATE.uid);
  const autoName = _getTgName() || linkData?.firstName || 'Курьер';
  STATE.user = {
    name: autoName,
    phone: linkData?.phone || '',
    tgId: linkData?.tgId || '',
    role: 'courier',
    agreedCourier: true,
    createdAt: new Date().toISOString()
  };
  await dbSet('users', STATE.uid, STATE.user);
  // Always (re-)create the courier doc on agreement — this is the registration event.
  // The old guard `if (!existingCourier)` caused the doc not to be re-created after
  // a manual deletion because getCourier still found stale data in couriers/all.
  await setCourier(STATE.uid, {
    uid: STATE.uid, name: autoName, phone: linkData?.phone || '',
    status: 'pending', totalDeliveries: 0, createdAt: new Date().toISOString()
  });
  _saveState();
  document.getElementById('s-agree').style.display = 'none';
  showScreen('s-pending');
}

// ── Check courier status ──
async function checkCourierStatus() {
  // Дыра №7: read from single couriers document
  const courier = await getCourier(STATE.uid);
  // Preserve locally-tracked totalDeliveries if it's higher (offline-safe)
  const localRaw = (() => { try { return JSON.parse(localStorage.getItem('vez_courier_data') || 'null'); } catch { return null; } })();
  const localDeliveries = localRaw?.totalDeliveries || 0;
  if (courier && localDeliveries > (courier.totalDeliveries || 0)) {
    courier.totalDeliveries = localDeliveries;
  }
  COURIER_DATA = courier;
  if (!courier) {
    // Courier doc is missing (e.g. manually deleted) but user has agreedCourier:true.
    // Auto-recreate with 'pending' so the SA panel can pick it up.
    if (_fbR) {
      const fresh = {
        uid: STATE.uid,
        name: STATE.user?.name || _getTgName() || 'Курьер',
        phone: STATE.user?.phone || '',
        status: 'pending', totalDeliveries: 0,
        createdAt: new Date().toISOString()
      };
      await setCourier(STATE.uid, fresh);
      COURIER_DATA = fresh;
    }
    showScreen('s-pending'); return;
  }
  if (courier.status === 'pending')     { showScreen('s-pending'); return; }
  if (courier.status === 'blocked')     { showScreen('s-blocked'); return; }

  // Superadmin assigns couriers directly with status='confirmed' — no invite screen needed.
  initMain();
}

// acceptVenueInvite / declineVenueInvite removed — superadmin assigns couriers directly.

// ── Boot history sync — merge Firestore delivered orders into local history ──
// Runs every boot (not just when empty) so deliveries completed while the app
// was closed are added to history without waiting for a docChanges() event.
async function _ensureDeliveryHistory() {
  try {
    // No orderBy — the existing composite index covers (courierUid + active).
    // Adding orderBy('createdAt') would require a 3-field index that doesn't exist.
    // Sort in JS after fetching.
    const recent = await dbQueryWhere('orders',
      [['courierUid', '==', STATE.uid], ['active', '==', false]],
      null, 'desc', 50
    );
    const delivered = recent.filter(o => o.status === 'delivered');
    if (!delivered.length) return;
    const existing = _loadHistoryFromStorage();
    const byId = {};
    for (const o of existing) byId[o.id] = o;
    let changed = false;
    for (const fresh of delivered) {
      // Add new deliveries OR update stale entries (e.g. cached as 'delivering')
      if (!byId[fresh.id] || byId[fresh.id].status !== fresh.status) {
        byId[fresh.id] = fresh;
        changed = true;
      }
    }
    if (changed) {
      const merged = Object.values(byId)
        .sort((a, b) => (b.deliveredAt || b.createdAt || '').localeCompare(a.deliveredAt || a.createdAt || ''));
      _saveHistoryToStorage(merged);
    }
  } catch (e) { console.warn('[boot] ensureDeliveryHistory:', e.message); }
}

// ── Init main ──
async function initMain() {
  document.getElementById('main-nav').style.display = 'flex';

  // City label
  if (COURIER_DATA?.cityName) {
    document.getElementById('courier-city-label').textContent = '📍 ' + COURIER_DATA.cityName;
  }

  // Primary venue label
  if (COURIER_DATA?.primaryVenueName) {
    document.getElementById('primary-venue-label').textContent = COURIER_DATA.primaryVenueName;
  }

  // Дыра №8: warm up venue cache
  _refreshCourierVenueCache();

  // Sync delivery history from Firestore (adds deliveries made while app was closed)
  _myHistory = _loadHistoryFromStorage();
  await _ensureDeliveryHistory();
  _myHistory = _loadHistoryFromStorage(); // reload after merge
  watchMyOrders();
  watchAvailableOrders();
  watchVenueOrders();
  navToAvailable();
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
function navToAvailable() {
  showScreen('s-available'); setNav(document.getElementById('nav-avail'));
  renderAvailableOrders();
  tg?.BackButton?.hide();
}
function navToVenueOrders() {
  showScreen('s-venue-orders'); setNav(document.getElementById('nav-venue'));
  renderVenueOrders();
  tg?.BackButton?.hide();
}
function navToMyOrders() {
  showScreen('s-my-orders'); setNav(document.getElementById('nav-my'));
  renderMyOrders();
  tg?.BackButton?.hide();
}
function navToProfile() {
  showScreen('s-courier-profile'); setNav(document.getElementById('nav-profile'));
  loadCourierProfile();
  tg?.BackButton?.hide();
}

function setNav(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}

// ══════════════════════════════════════════════════════════
//  VENUE LOCK HELPER
// ══════════════════════════════════════════════════════════
// Returns the venueId the courier is currently committed to (has active orders from),
// or null if they have no active orders.
// Rule: a courier may only hold orders from ONE venue at a time from the general pool.
// They must complete (or return) all orders from that venue before accepting from another.
function _getCourierLockedVenueId() {
  if (!_myOrders.length) return null;
  return _myOrders[0].venueId || null;
}

// ══════════════════════════════════════════════════════════
//  AVAILABLE ORDERS (общий пул)
// ══════════════════════════════════════════════════════════
function watchAvailableOrders() {
  if (_availUnsub) { _availUnsub(); _availUnsub = null; }
  _availUnsub = onQuerySnap('orders', 'status', '==', 'searching_courier', orders => {
    _availOrders = orders.filter(o => !o.courierUid);
    const cnt = _availOrders.length;
    document.getElementById('avail-badge').textContent = cnt;
    document.getElementById('avail-badge').classList.toggle('hidden', cnt === 0);
    renderAvailableOrders();
  });
}

function renderAvailableOrders() {
  const list = document.getElementById('available-list');
  if (!_availOrders.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">Нет доступных заказов</div></div>';
    return;
  }
  const myVenue      = COURIER_DATA?.primaryVenueId;
  const lockedVenueId = _getCourierLockedVenueId();
  const byVenue = {};
  for (const o of _availOrders) {
    if (!byVenue[o.venueId]) byVenue[o.venueId] = [];
    byVenue[o.venueId].push(o);
  }
  // Sort: locked venue first (if any), then own venue, then rest
  const groups = Object.values(byVenue).sort((a, b) => {
    const aId = a[0].venueId, bId = b[0].venueId;
    if (lockedVenueId) {
      if (aId === lockedVenueId && bId !== lockedVenueId) return -1;
      if (bId === lockedVenueId && aId !== lockedVenueId) return  1;
    }
    return (aId === myVenue ? -1 : 1) - (bId === myVenue ? -1 : 1);
  });
  list.innerHTML = groups.map(g => _poolBundleCard(g, myVenue, lockedVenueId)).join('');
}

// ══════════════════════════════════════════════════════════
//  VENUE ORDERS (важные — заказы своего заведения)
// ══════════════════════════════════════════════════════════
// H-1: Subscribe only to active venue orders (not full history).
// REQUIRES Firestore composite index: orders — venueId ASC + active ASC
function watchVenueOrders() {
  if (_venueUnsub) { _venueUnsub(); _venueUnsub = null; }
  const myVenue = COURIER_DATA?.primaryVenueId;
  if (!myVenue) return;
  _venueUnsub = onQuerySnapWhere('orders', [
    ['venueId', '==', myVenue],
    ['active', '==', true]
  ], orders => {
    // Only ready_for_courier orders belong in the venue "important" section.
    // searching_courier (general pool) is visible to ALL couriers in watchAvailableOrders.
    _venueOrders = orders.filter(o => o.status === 'ready_for_courier');
    // Haptic + sound for newly ready orders
    _venueOrders.filter(o => o.status === 'ready_for_courier').forEach(o => {
      if (!_shownImportant.has(o.id)) {
        _shownImportant.add(o.id);
        tgHaptic('heavy');
        playNewOrder();
        showToast(`⚡ Заказ готов — ${o.venueName || 'заведение'}`, 'success');
      }
    });
    const cnt = _venueOrders.length;
    document.getElementById('venue-badge').textContent = cnt;
    document.getElementById('venue-badge').classList.toggle('hidden', cnt === 0);
    renderVenueOrders();
  });
}

function renderVenueOrders() {
  const list = document.getElementById('venue-orders-list');
  const myVenue = COURIER_DATA?.primaryVenueId;
  if (!myVenue) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">Вы не привязаны к заведению.<br>Ждите приглашения.</div></div>';
    return;
  }

  // Venue tab only shows ready_for_courier orders for this venue's permanent couriers.
  // General pool (searching_courier) is in the separate Pool tab visible to all couriers.
  if (!_venueOrders.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">✅</div><div class="empty-text">Нет ожидающих заказов</div></div>';
    return;
  }

  let html = `<div class="section-title" style="padding:0 4px;margin-bottom:6px">⚡ Готовы к выдаче (${_venueOrders.length})</div>`;
  html += _venueOrders.map(o => _importantOrderCard(o)).join('');
  list.innerHTML = html;
}

function _importantOrderCard(order) {
  const addr = order.address;
  const addrStr = addr ? `${addr.street} ${addr.house}${addr.apt ? ', кв.' + addr.apt : ''}` : 'Самовывоз';
  return `
    <div class="delivery-card" style="border-left:3px solid var(--success)">
      <div class="delivery-card-hdr">
        <div>
          <div class="font-bold" style="font-size:14px">⚡ ${escHtml(order.venueName || 'Заведение')}</div>
          <div class="text-xs text-dim">#${(order.id || '').slice(-6)} · ${fmtDate(order.createdAt)}</div>
        </div>
        <span class="${statusBadgeClass(order.status)}">${statusLabel(order.status)}</span>
      </div>
      <div class="delivery-card-body" style="font-size:13px">
        <div>📍 ${escHtml(addrStr)}</div>
        <div>💰 ${fmtPrice((order.total || 0) + (order.deliveryPrice || 0))} · ${order.payment === 'cash' ? 'Наличные' : 'Карта'}</div>
      </div>
      <div class="delivery-card-foot" style="font-size:12px;color:var(--text-dim);padding-top:4px">
        ℹ️ Заказ готов — оператор передаст его лично при вашем приезде
      </div>
    </div>`;
}

function _poolBundleCard(orders, myVenueId, lockedVenueId) {
  const first  = orders[0];
  const isOwn  = first.venueId === myVenueId;
  const pool   = isOwn ? 'venue' : 'available';
  const ids    = orders.map(o => o.id).join(',');
  const totalDelivery = orders.reduce((s,o) => s+(o.deliveryPrice||0), 0);
  const totalAmt      = orders.reduce((s,o) => s+(o.total||0)+(o.deliveryPrice||0), 0);

  // Locked = courier has active orders from a DIFFERENT venue
  const isLocked = !!lockedVenueId && first.venueId !== lockedVenueId;
  const isActive = !!lockedVenueId && first.venueId === lockedVenueId; // this is the venue they're working

  const addrLines = orders.map(o => {
    const addr = o.address;
    return addr
      ? `<div class="flex items-center gap-2"><span>📍</span><span>${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt?', кв.'+escHtml(addr.apt):''}</span></div>`
      : '<div>🏪 Самовывоз</div>';
  }).join('');

  const lockBanner = isLocked
    ? `<div style="margin-top:6px;padding:6px 8px;background:var(--warning-soft,#fef3c7);border-radius:6px;font-size:11px;color:var(--warning,#d97706)">
         🔒 Сначала доставьте заказы из текущего кафе
       </div>`
    : '';
  const activeBanner = isActive
    ? `<div style="margin-top:6px;padding:6px 8px;background:var(--success-soft,#d1fae5);border-radius:6px;font-size:11px;color:var(--success,#059669)">
         ✅ Ваши текущие заказы — можно добавить ещё
       </div>`
    : '';

  const cardStyle  = isLocked ? 'opacity:0.55;pointer-events:none;' : 'cursor:pointer;';
  const btnClass   = isLocked ? 'btn-ghost' : 'btn-primary';
  const btnLabel   = isLocked ? '🔒 Недоступно' : '✅ Принять →';
  const btnClick   = isLocked ? '' : `event.stopPropagation();openBundleAcceptSheet('${ids}','${pool}')`;
  const cardClick  = isLocked ? '' : `openBundleAcceptSheet('${ids}','${pool}')`;

  return `
    <div class="delivery-card" onclick="${cardClick}" style="${cardStyle}${isActive?'border-left:3px solid var(--success);':''}">
      <div class="delivery-card-hdr">
        <div>
          <div class="font-bold" style="font-size:14px">🏪 ${escHtml(first.venueName||'Заведение')}</div>
          <div class="text-xs text-dim">${orders.length>1?orders.length+' заказа(ов)':fmtDate(first.createdAt)}</div>
        </div>
        <div class="text-primary font-bold">${fmtPrice(totalDelivery)}</div>
      </div>
      <div class="delivery-card-body" style="font-size:13px;display:flex;flex-direction:column;gap:3px">
        ${addrLines}
        <div class="flex items-center gap-2" style="margin-top:2px"><span>💰</span><span>${fmtPrice(totalAmt)}</span></div>
        ${isOwn?'<div class="pill" style="margin-top:4px;font-size:10px;width:fit-content;background:var(--primary)20;color:var(--primary)">⭐ Ваше кафе</div>':''}
        ${lockBanner}${activeBanner}
      </div>
      <div class="delivery-card-foot">
        <button class="btn ${btnClass} btn-sm" ${isLocked?'disabled':''} onclick="${btnClick}">
          ${btnLabel}
        </button>
      </div>
    </div>`;
}

// Kept for any legacy call paths
function _orderPoolCard(o, myVenueId) { return _poolBundleCard([o], myVenueId, _getCourierLockedVenueId()); }

// ── Accept Sheet ──
async function openAcceptSheet(orderId, pool) {
  _acceptOrderId = orderId;
  _acceptFromPool = pool || 'available';
  const order = (pool === 'venue' ? _venueOrders : _availOrders).find(o => o.id === orderId)
    || _availOrders.find(o => o.id === orderId)
    || _venueOrders.find(o => o.id === orderId);
  if (!order) return;
  const addr = order.address;
  let venueAddr = '—';
  try { venueAddr = (await _getVenueCached(order.venueId))?.address || '—'; } catch {} // Дыра №8
  const content = document.getElementById('accept-order-content');
  content.innerHTML = `
    <div class="sheet-title">Принять заказ?</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${escHtml(order.venueName || '—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес кафе</span><span style="text-align:right;max-width:60%">${escHtml(venueAddr)}</span></div>
      <div class="flex justify-between"><span class="text-dim">Доставка</span><span style="text-align:right;max-width:60%">${addr ? `${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt ? ', кв.' + escHtml(addr.apt) : ''}` : 'Самовывоз'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment === 'cash' ? '💵 Наличные' : '💳 Карта'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Вознаграждение</span><span class="font-bold text-primary">${fmtPrice(order.deliveryPrice || 0)}</span></div>
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав</div>
    <div class="card card-body" style="margin-bottom:14px;gap:4px;display:flex;flex-direction:column">
      ${(order.items || []).map(it => `
        <div class="flex justify-between text-sm">
          <span>${it.emoji || '🍽️'} ${escHtml(it.name)}${it.variantName ? ' (' + escHtml(it.variantName) + ')' : ''} ×${it.qty}</span>
          <span>${fmtPrice(it.price * it.qty)}</span>
        </div>`).join('')}
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="closeAcceptSheet()">Отмена</button>
      <button class="btn btn-primary" onclick="acceptOrder('${order.id}')">✅ Принять заказ</button>
    </div>`;
  document.getElementById('accept-overlay').classList.add('open');
  tg?.BackButton?.show();
}

async function acceptOrder(orderId) {
  // M-4: Use Firestore transaction to prevent race condition when multiple couriers
  // press Accept simultaneously. The transaction atomically reads the order status
  // and writes only if it hasn't already been taken.

  // Venue lock check
  const lockedVenueId = _getCourierLockedVenueId();
  if (lockedVenueId) {
    const order = _availOrders.find(o => o.id === orderId) || _venueOrders.find(o => o.id === orderId);
    if (order && order.venueId !== lockedVenueId) {
      closeAcceptSheet();
      tgHaptic('error');
      showToast('Сначала завершите текущие доставки', 'warning');
      return;
    }
  }

  try {
    const orderRef = db.collection('orders').doc(orderId);
    await db.runTransaction(async txn => {
      const snap = await txn.get(orderRef);
      if (!snap.exists) throw Object.assign(new Error('not_found'), { code: 'not_found' });
      const data = snap.data();
      const ok = data.status === 'searching_courier' || data.status === 'ready_for_courier';
      if (!ok) throw Object.assign(new Error('taken'), { code: 'taken' });
      txn.update(orderRef, {
        status: 'courier_assigned',
        courierUid: STATE.uid,
        courierName: COURIER_DATA?.name || 'Курьер',
        courierPhone: COURIER_DATA?.phone || '',
        assignedAt: new Date().toISOString()
      });
    });
    _shownAssigned.add(orderId);
    closeAcceptSheet();
    tgHaptic('success');
    showToast('Заказ принят! Едете в кафе.', 'success');
    navToMyOrders();
  } catch (e) {
    if (e.code === 'taken') {
      closeAcceptSheet();
      tgHaptic('error');
      showToast('Этот заказ уже взял другой курьер.', 'error');
    } else if (e.code === 'not_found') {
      closeAcceptSheet();
      tgHaptic('error');
      showToast('Заказ не найден.', 'error');
    } else {
      tgHaptic('error');
      showToast('Ошибка при принятии заказа. Попробуйте ещё раз.', 'error');
      console.warn('[acceptOrder] txn error:', e.message);
    }
  }
}

async function openBundleAcceptSheet(orderIdsStr, pool) {
  const ids = orderIdsStr.split(',').filter(Boolean);
  const src = pool==='venue' ? _venueOrders : _availOrders;
  const orders = ids.map(id => src.find(o=>o.id===id) || _availOrders.find(o=>o.id===id) || _venueOrders.find(o=>o.id===id)).filter(Boolean);
  if (!orders.length) return;

  // Venue lock: can only hold orders from one venue at a time
  const lockedVenueId = _getCourierLockedVenueId();
  if (lockedVenueId && orders[0].venueId !== lockedVenueId) {
    const lockedName = _myOrders[0]?.venueName || lockedVenueId;
    tgHaptic('error');
    showToast(`Сначала завершите доставки из «${lockedName}»`, 'warning');
    return;
  }

  _acceptOrderIds  = ids;
  _acceptOrderId   = ids[0];
  _acceptFromPool  = pool;

  const first = orders[0];
  let venueAddr = '—';
  try { venueAddr = (await _getVenueCached(first.venueId))?.address || '—'; } catch {} // Дыра №8

  const totalDelivery = orders.reduce((s,o)=>s+(o.deliveryPrice||0),0);

  const content = document.getElementById('accept-order-content');
  const orderCards = orders.map((o,i) => {
    const addr = o.address;
    const addrStr = addr ? `${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt?', кв.'+escHtml(addr.apt):''}` : 'Самовывоз';
    return `
      <div class="section-title" style="margin-bottom:4px">Заказ ${orders.length>1?i+1+' · ':''}#${(o.id||'').slice(-6)}</div>
      <div class="card card-body" style="margin-bottom:8px;gap:4px;display:flex;flex-direction:column">
        <div class="flex justify-between text-sm"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addrStr}</span></div>
        <div class="flex justify-between text-sm"><span class="text-dim">Оплата</span><span>${o.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
        ${(o.items||[]).map(it=>`<div class="flex justify-between text-sm"><span>${it.emoji||'🍽️'} ${escHtml(it.name)} ×${it.qty}</span><span>${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
      </div>`;
  }).join('');

  content.innerHTML = `
    <div class="sheet-title">Принять ${orders.length>1?orders.length+' заказа(ов)':'заказ'}?</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${escHtml(first.venueName||'—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес кафе</span><span style="text-align:right;max-width:60%">${escHtml(venueAddr)}</span></div>
      <div class="flex justify-between"><span class="text-dim">Вознаграждение</span><span class="font-bold text-primary">${fmtPrice(totalDelivery)}</span></div>
    </div>
    ${orderCards}
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="closeAcceptSheet()">Отмена</button>
      <button class="btn btn-primary" onclick="acceptBundleOrders()">✅ Принять всё</button>
    </div>`;
  document.getElementById('accept-overlay').classList.add('open');
  tg?.BackButton?.show();
}

async function acceptBundleOrders() {
  // M-4: Use Firestore transaction to atomically claim all bundle orders.
  // Reads every order first; if ANY is already taken, the whole transaction aborts
  // so the courier never gets a partial bundle.
  if (!_acceptOrderIds.length) return;

  // Re-check venue lock — _myOrders may have changed since the sheet was opened
  const lockedVenueId = _getCourierLockedVenueId();
  const firstOrder = _availOrders.find(o => o.id === _acceptOrderIds[0])
                  || _venueOrders.find(o => o.id === _acceptOrderIds[0]);
  if (lockedVenueId && firstOrder && firstOrder.venueId !== lockedVenueId) {
    closeAcceptSheet();
    tgHaptic('error');
    showToast('Сначала завершите текущие доставки', 'warning');
    return;
  }

  const ids   = [..._acceptOrderIds];
  const now   = new Date().toISOString();
  const cName = COURIER_DATA?.name || 'Курьер';
  try {
    const refs = ids.map(id => db.collection('orders').doc(id));
    await db.runTransaction(async txn => {
      const snaps = await Promise.all(refs.map(r => txn.get(r)));
      for (const snap of snaps) {
        if (!snap.exists) throw Object.assign(new Error('not_found'), { code: 'not_found' });
        const data = snap.data();
        const ok = data.status === 'searching_courier' || data.status === 'ready_for_courier';
        if (!ok) throw Object.assign(new Error('taken'), { code: 'taken' });
      }
      // All orders are still available — claim them all atomically
      for (const ref of refs) {
        txn.update(ref, {
          status: 'courier_assigned',
          courierUid: STATE.uid, courierName: cName,
          courierPhone: COURIER_DATA?.phone || '',
          assignedAt: now
        });
      }
    });
    ids.forEach(id => _shownAssigned.add(id));
    closeAcceptSheet();
    tgHaptic('success');
    showToast(`Принято ${ids.length} заказ(а)! Едете в кафе.`, 'success');
    navToMyOrders();
  } catch (e) {
    if (e.code === 'taken') {
      closeAcceptSheet();
      tgHaptic('error');
      showToast('Один или несколько заказов уже взял другой курьер.', 'error');
    } else if (e.code === 'not_found') {
      closeAcceptSheet();
      tgHaptic('error');
      showToast('Один из заказов не найден.', 'error');
    } else {
      tgHaptic('error');
      showToast('Ошибка при принятии заказов. Попробуйте ещё раз.', 'error');
      console.warn('[acceptBundleOrders] txn error:', e.message);
    }
  }
}

function closeAcceptSheet(e) {
  if (e && e.target !== document.getElementById('accept-overlay')) return;
  document.getElementById('accept-overlay').classList.remove('open');
  if (document.querySelector('.overlay.open') === null) tg?.BackButton?.hide();
}

// ══════════════════════════════════════════════════════════
//  MY ORDERS
// ══════════════════════════════════════════════════════════
// H-1: Subscribe only to active courier orders (not full history).
// Delivered orders are captured via docChanges() type='removed' and saved to localStorage.
// REQUIRES Firestore composite index: orders — courierUid ASC + active ASC
function watchMyOrders() {
  if (_myUnsub) { _myUnsub(); _myUnsub = null; }

  const _applyMyOrders = active => {
    _myOrders = active
      .filter(o => o.status === 'courier_assigned' || o.status === 'delivering')
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    const cnt = _myOrders.length;
    document.getElementById('my-badge').textContent = cnt;
    document.getElementById('my-badge').classList.toggle('hidden', cnt === 0);

    _myOrders.forEach(o => {
      if (!_shownAssigned.has(o.id)) {
        _shownAssigned.add(o.id);
        showAssignedNotif(o);
      }
    });

    renderMyOrders();

    // Auto-refresh open order detail if data changed (e.g. admin handed off → status delivering)
    if (_openMyOrderId && document.getElementById('my-order-overlay')?.classList.contains('open')) {
      openMyOrder(_openMyOrderId);
    }
  };

  if (!_fbR) {
    // Offline fallback: poll active orders only
    const t = setInterval(async () => {
      const orders = await dbQueryWhere('orders', [['courierUid','==',STATE.uid],['active','==',true]]);
      _applyMyOrders(orders);
    }, 15000);
    _myUnsub = () => clearInterval(t);
    return;
  }

  _myUnsub = db.collection('orders')
    .where('courierUid', '==', STATE.uid)
    .where('active', '==', true)
    .onSnapshot(snap => {
      // Capture delivered orders as they leave the active query
      snap.docChanges().forEach(change => {
        if (change.type === 'removed') {
          const finished = { id: change.doc.id, ...change.doc.data() };
          if (finished.status === 'delivered') {
            const existingIds = new Set(_myHistory.map(o => o.id));
            if (!existingIds.has(finished.id)) {
              _myHistory = [finished, ..._myHistory]
                .sort((a, b) => (b.deliveredAt || b.createdAt || '').localeCompare(a.deliveredAt || a.createdAt || ''));
              _saveHistoryToStorage(_myHistory);
            }
          }
        }
      });
      _applyMyOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, e => console.warn('[DB] myOrders snap:', e.message));
}

function showAssignedNotif(order) {
  const addr = order.address;
  document.getElementById('notif-assigned-text').textContent =
    `Заказ из ${order.venueName || 'заведения'} → ${addr ? addr.street + ' ' + addr.house : 'клиенту'}`;
  document.getElementById('notif-assigned').classList.add('open');
  tgHaptic('heavy'); playNewOrder();
}

function renderMyOrders() {
  const list = document.getElementById('my-orders-list');
  let html = '';

  if (_myOrders.length) {
    html += `<div class="section-title" style="padding:0 4px;margin-bottom:4px">Активные (${_myOrders.length})</div>`;
    html += _myOrders.map(o => {
      const addr = o.address;
      return `
        <div class="delivery-card" onclick="openMyOrder('${o.id}')" style="cursor:pointer">
          <div class="delivery-card-hdr">
            <div>
              <div class="font-bold" style="font-size:14px">🏪 ${escHtml(o.venueName || 'Заведение')}</div>
              <div class="text-xs text-dim">#${(o.id || '').slice(-6)} · ${fmtDate(o.createdAt)}</div>
            </div>
            <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
          </div>
          <div class="delivery-card-body" style="font-size:13px">
            ${addr ? `<div>📍 ${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt ? ', кв.' + escHtml(addr.apt) : ''}</div>` : '<div>🏪 Самовывоз</div>'}
            <div>💰 ${fmtPrice((o.total || 0) + (o.deliveryPrice || 0))} · ${o.payment === 'cash' ? 'Наличные' : 'Карта'}</div>
          </div>
          <div class="delivery-card-foot">
            <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openMyOrder('${o.id}')">Детали →</button>
          </div>
        </div>`;
    }).join('');
  }

  if (!html) {
    html = '<div class="empty" style="padding-top:40px"><div class="empty-icon">📦</div><div class="empty-text">Нет активных доставок</div></div>';
  }

  // History section (from localStorage — no Firebase query)
  if (_myHistory.length) {
    const dayEarnings = _myHistory.reduce((s,o)=>s+(o.deliveryPrice||0),0);
    html += `<div class="section-title" style="padding:4px 4px 4px;margin-top:8px">
      История (${_myHistory.length}) · <span class="text-primary font-bold">${fmtPrice(dayEarnings)}</span>
    </div>`;
    html += _myHistory.slice(0, 30).map(o => `
      <div class="delivery-card" style="opacity:.85">
        <div class="delivery-card-hdr">
          <div>
            <div class="font-bold" style="font-size:13px">${escHtml(o.venueName||'Заведение')}</div>
            <div class="text-xs text-dim">${fmtTime(o.deliveredAt||o.createdAt)} · #${(o.id||'').slice(-6)}</div>
          </div>
          <div class="text-success font-bold">${fmtPrice(o.deliveryPrice||0)}</div>
        </div>
        <div class="delivery-card-body text-sm text-dim">
          ${o.address?`📍 ${escHtml(o.address.street)} ${escHtml(o.address.house)}`:'🏪 Самовывоз'}
        </div>
      </div>`).join('');
  }

  list.innerHTML = html;
}

// ── My order detail ──
async function openMyOrder(orderId) {
  const order = _myOrders.find(o => o.id === orderId);
  if (!order) return;
  const addr = order.address;
  let venueAddr = '—';
  let venuePhone = null;
  try {
    // Дыра №8: use cached venue data
    const venueData = await _getVenueCached(order.venueId);
    venueAddr = venueData?.address || '—';
    venuePhone = venueData?.phone || null;
  } catch {}
  const callBtn = order.clientPhone
    ? `<button class="btn-call" onclick="callPhone('${normPhone(order.clientPhone)}')">📞 Позвонить клиенту</button>`
    : '';
  const callVenueBtn = venuePhone
    ? `<button class="btn-call" onclick="callPhone('${normPhone(venuePhone)}')">📞 Позвонить оператору кафе</button>`
    : '';
  const content = document.getElementById('my-order-detail');
  content.innerHTML = `
    <div class="sheet-title">Заказ #${(order.id || '').slice(-6)}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${escHtml(order.venueName || '—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес кафе</span><span style="text-align:right;max-width:60%">${escHtml(venueAddr)}</span></div>
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span>${escHtml(order.clientName || '—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${escHtml(order.clientPhone || '—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addr ? `${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt ? ', кв.' + escHtml(addr.apt) : ''}${addr.hasIntercom ? ' · домофон: ' + escHtml(addr.intercomCode || 'есть') : ''}` : 'Самовывоз'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment === 'cash' ? '💵 Наличные' : '💳 Карта'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Итого</span><span class="font-bold text-primary">${fmtPrice((order.total || 0) + (order.deliveryPrice || 0))}</span></div>
      ${order.comment ? `<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%">${escHtml(order.comment)}</span></div>` : ''}
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      ${(order.items || []).map(it => `
        <div class="flex justify-between text-sm">
          <span>${it.emoji || '🍽️'} ${escHtml(it.name)}${it.variantName ? ' (' + escHtml(it.variantName) + ')' : ''} ×${it.qty}</span>
          <span>${fmtPrice(it.price * it.qty)}</span>
        </div>`).join('')}
    </div>
    ${callBtn}
    ${callVenueBtn}

    ${order.status === 'courier_assigned'
      ? `<div class="alert-box info" style="text-align:center;font-size:14px;margin-bottom:12px">
           🏃 Едете в кафе за заказом.<br>
           <span style="font-size:12px;color:var(--text-dim)">Оператор передаст заказ и подтвердит выдачу</span>
         </div>`
      : `<div class="btn-row" style="margin-top:24px">
           <button class="btn btn-ghost btn-sm" onclick="courierReturn('${order.id}')">↩ Возврат</button>
           <button class="btn btn-success" onclick="courierDeliver('${order.id}')">✅ Доставил</button>
         </div>`
    }`;
  _openMyOrderId = orderId;
  document.getElementById('my-order-overlay').classList.add('open');
  tg?.BackButton?.show();
}

async function courierDeliver(orderId) {
  const doDeliver = async () => {
    const deliveredAt = new Date().toISOString();
    await dbSet('orders', orderId, {
      status: 'delivered', active: false,       // Дыра №5
      deliveredAt,
      clientNotification: { type: 'delivered', seen: false }
    });
    // Optimistic local update — remove from _myOrders immediately, don't wait for onSnapshot
    const finished = _myOrders.find(o => o.id === orderId);
    _myOrders = _myOrders.filter(o => o.id !== orderId);
    if (finished) {
      const deliveredEntry = { ...finished, status: 'delivered', active: false, deliveredAt };
      const existingIds = new Set(_myHistory.map(o => o.id));
      if (!existingIds.has(orderId)) {
        _myHistory = [deliveredEntry, ..._myHistory]
          .sort((a, b) => (b.deliveredAt || b.createdAt || '').localeCompare(a.deliveredAt || a.createdAt || ''));
        _saveHistoryToStorage(_myHistory);
      }
    }
    renderMyOrders();
    // Increment total deliveries (from local data, no extra Firestore read)
    const total = (COURIER_DATA?.totalDeliveries || 0) + 1;
    COURIER_DATA = { ...COURIER_DATA, totalDeliveries: total };
    await setCourier(STATE.uid, COURIER_DATA); // Дыра №7
    try { localStorage.setItem('vez_courier_data', JSON.stringify(COURIER_DATA)); } catch {}
    closeMyOrderSheet();
    tgHaptic('success'); showToast('Заказ доставлен!', 'success');
  };
  if (tg?.showConfirm) tg.showConfirm('Подтвердить доставку?', ok => { if (ok) doDeliver(); });
  else if (confirm('Подтвердить доставку?')) await doDeliver();
}

async function courierReturn(orderId) {
  const doReturn = async () => {
    await dbSet('orders', orderId, {
      status: 'searching_courier',
      courierUid: null, courierName: null, courierPhone: null,
      returnAt: new Date().toISOString(),
      returnedByUid: STATE.uid,
      returnedByName: STATE.user?.name || ''
    });
    closeMyOrderSheet();
    tgHaptic('light'); showToast('Возврат оформлен', 'info');
  };
  if (tg?.showConfirm) tg.showConfirm('Вернуть заказ оператору?', ok => { if (ok) doReturn(); });
  else if (confirm('Вернуть заказ?')) await doReturn();
}

function closeMyOrderSheet(e) {
  if (e && e.target !== document.getElementById('my-order-overlay')) return;
  _openMyOrderId = null;
  document.getElementById('my-order-overlay').classList.remove('open');
  if (document.querySelector('.overlay.open') === null) tg?.BackButton?.hide();
}

// ══════════════════════════════════════════════════════════
//  PROFILE
// ══════════════════════════════════════════════════════════
async function loadCourierProfile() {
  const courier = COURIER_DATA || {};

  const phone = courier.phone || STATE.user?.phone || '';
  // QR
  document.getElementById('courier-qr-phone').textContent = phone || '—';
  if (phone) renderQrCode('courier-qr-img', phone, 180);

  // Stats
  const statsGrid = document.getElementById('courier-stats-grid');
  const delivered = courier.totalDeliveries || 0;
  statsGrid.innerHTML = `
    <div class="stat-card"><div class="stat-val">${delivered}</div><div class="stat-lbl">Доставок</div></div>`;

  // Venue info
  const venueCard = document.getElementById('courier-venue-card');
  if (courier.primaryVenueId) {
    try {
      const venue = await _getVenueCached(courier.primaryVenueId); // Дыра №8
      venueCard.innerHTML = `
        <div class="font-bold">${venue?.name || courier.primaryVenueId}</div>
        <div class="text-dim text-sm mt-1">${venue?.address || ''}</div>
        ${venue?.phone ? `<div class="text-sm mt-1">📞 ${venue.phone}</div>` : ''}`;
    } catch {
      venueCard.innerHTML = `<div class="text-dim text-sm">Ошибка загрузки</div>`;
    }
  } else {
    venueCard.innerHTML = `<div class="text-dim text-sm">Не привязан к заведению</div>`;
  }

}

async function courierLeaveVenue() {
  const ok = await new Promise(resolve => {
    if (tg?.showConfirm) tg.showConfirm('Отвязаться от заведения?', resolve);
    else resolve(confirm('Отвязаться от заведения?'));
  });
  if (!ok) return;
  COURIER_DATA = { ...COURIER_DATA, primaryVenueId: null, primaryVenueName: null };
  await setCourier(STATE.uid, COURIER_DATA); // Дыра №7
  document.getElementById('primary-venue-label').textContent = '—';
  if (_venueUnsub) { _venueUnsub(); _venueUnsub = null; }
  _venueOrders = [];
  document.getElementById('venue-orders-list').innerHTML =
    '<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">Вы не привязаны к заведению.<br>Ждите приглашения.</div></div>';
  tgHaptic('light'); showToast('Вы отвязаны от заведения', 'info');
  loadCourierProfile();
}

// ══════════════════════════════════════════════════════════
//  BACK BUTTON
// ══════════════════════════════════════════════════════════
function _initCourierBackButton() {
  if (!tg?.BackButton) return;
  tg.BackButton.onClick(() => {
    const open = document.querySelector('.overlay.open');
    if (open) {
      open.classList.remove('open');
      if (!document.querySelector('.overlay.open')) tg.BackButton.hide();
      return;
    }
    const cur = document.querySelector('.screen.active')?.id;
    if (cur && cur !== 's-available') {
      navToAvailable(); return;
    }
    tg.BackButton.hide();
  });
}
