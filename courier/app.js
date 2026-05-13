'use strict';
/* ============================================================
   VEZOO COURIER — Delivery App
   ============================================================ */

const STATE = { uid: null, user: null };
let COURIER_DATA      = null;
let _availUnsub       = null;
let _venueUnsub       = null;
let _myUnsub          = null;
let _availOrders      = [];
let _venueOrders      = [];
let _myOrders         = [];
let _shownAssigned    = new Set();
let _venueInvite      = null;
let _acceptOrderId    = null;
let _acceptOrderIds   = [];
let _acceptFromPool   = 'available'; // 'available' | 'venue'
let _myHistory        = [];
let _myHistPage       = 10;
let _shownImportant   = new Set();

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
  initUserStorage(_tgUserId);
  try {
    const s = JSON.parse(localStorage.getItem(storageKey('courier_state')) || '{}');
    if (!_tgUserId || s.tgId === _tgUserId) {
      STATE.uid = s.uid || null; STATE.user = s.user || null;
    }
  } catch {}

  const _urlToken = readUidFromUrl();
  await initFirebase();

  if (_urlToken) {
    const _res = await resolveLoginToken(_urlToken);
    if (_res.uid) {
      if (_res.clearStorage) _clearVezCache();
      STATE.uid = _res.uid;
      _saveState();
    }
  }
  if (!STATE.uid) {
    const tgUid = await resolveUidByTgId();
    if (tgUid) { STATE.uid = tgUid; _saveState(); }
  }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing?.blocked) { showScreen('s-blocked'); return; }

  if (!existing?.agreedCourier && !STATE.user?.agreedCourier) {
    document.getElementById('s-agree').style.display = 'flex';
    return;
  }

  STATE.user = existing; _saveState();
  await checkCourierStatus();
});

function _getTgName() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return null;
  return (u.first_name + (u.last_name ? ' ' + u.last_name : '')).trim() || null;
}

function _saveState() {
  const tgId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem(storageKey('courier_state'), JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId })); } catch {}
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
  const existingCourier = await dbGet('couriers', STATE.uid);
  if (!existingCourier) {
    await dbSet('couriers', STATE.uid, {
      uid: STATE.uid, name: autoName, phone: linkData?.phone || '',
      status: 'pending', onShift: false, rating: 0, ratingCount: 0,
      totalDeliveries: 0, createdAt: new Date().toISOString()
    });
  }
  _saveState();
  document.getElementById('s-agree').style.display = 'none';
  showScreen('s-pending');
}

// ── Check courier status ──
async function checkCourierStatus() {
  const courier = await dbGet('couriers', STATE.uid);
  COURIER_DATA = courier;
  if (!courier)                         { showScreen('s-pending'); return; }
  if (courier.status === 'pending')     { showScreen('s-pending'); return; }
  if (courier.status === 'blocked')     { showScreen('s-blocked'); return; }

  // Check for pending venue invite
  const invite = await dbGet('courier_venue_links', STATE.uid);
  if (invite && invite.status === 'pending') {
    _venueInvite = invite;
    document.getElementById('venue-invite-name').textContent = invite.venueName || 'Заведение';
    document.getElementById('venue-invite-addr').textContent = invite.venueAddress || '';
    const notice = document.getElementById('current-primary-notice');
    if (courier.primaryVenueId && courier.primaryVenueId !== invite.venueId) {
      const pv = await dbGet('venues', courier.primaryVenueId);
      notice.textContent = `Сейчас ваше постоянное кафе: ${pv?.name || courier.primaryVenueId}. При принятии — оно сменится.`;
      notice.classList.remove('hidden');
    }
    showScreen('s-venue-invite'); return;
  }

  initMain();
}

async function acceptVenueInvite() {
  if (!_venueInvite) return;
  await dbSet('courier_venue_links', STATE.uid, { status: 'confirmed', confirmedAt: new Date().toISOString() });
  await dbSet('couriers', STATE.uid, { primaryVenueId: _venueInvite.venueId });
  COURIER_DATA = { ...COURIER_DATA, primaryVenueId: _venueInvite.venueId };
  tgHaptic('success'); showToast('Вы теперь постоянный курьер этого кафе', 'success');
  _venueInvite = null; initMain();
}

async function declineVenueInvite() {
  if (!_venueInvite) return;
  await dbDelete('courier_venue_links', STATE.uid);
  _venueInvite = null; initMain();
}

// ── Init main ──
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  startHeartbeat(STATE.uid);

  const onShift = COURIER_DATA?.onShift || false;
  document.getElementById('shift-toggle').checked = onShift;
  document.getElementById('shift-label').textContent = onShift ? '🟢 На смене' : 'Офлайн';
  document.getElementById('shift-info-banner').classList.toggle('hidden', !onShift);

  // City label
  if (COURIER_DATA?.cityName) {
    document.getElementById('courier-city-label').textContent = '📍 ' + COURIER_DATA.cityName;
  }

  // Primary venue label
  if (COURIER_DATA?.primaryVenueName) {
    document.getElementById('primary-venue-label').textContent = COURIER_DATA.primaryVenueName;
  }

  watchMyOrders();
  if (onShift) { watchAvailableOrders(); watchVenueOrders(); }
  navToAvailable();
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
function navToAvailable() {
  showScreen('s-available'); setNav(document.getElementById('nav-avail'));
  if (COURIER_DATA?.onShift) renderAvailableOrders();
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
//  SHIFT
// ══════════════════════════════════════════════════════════
async function toggleShift(input) {
  const onShift = input.checked;
  document.getElementById('shift-label').textContent = onShift ? '🟢 На смене' : 'Офлайн';
  document.getElementById('shift-info-banner').classList.toggle('hidden', !onShift);
  await dbSet('couriers', STATE.uid, { onShift, shiftUpdatedAt: new Date().toISOString() });
  COURIER_DATA = { ...COURIER_DATA, onShift };
  if (onShift) {
    watchAvailableOrders(); watchVenueOrders();
    tgHaptic('success'); showToast('Смена начата', 'success');
  } else {
    if (_availUnsub) { _availUnsub(); _availUnsub = null; }
    if (_venueUnsub) { _venueUnsub(); _venueUnsub = null; }
    _availOrders = []; _venueOrders = [];
    document.getElementById('available-list').innerHTML =
      '<div class="empty"><div class="empty-icon">🚴</div><div class="empty-text">Включите смену, чтобы<br>видеть доступные заказы</div></div>';
    document.getElementById('venue-orders-list').innerHTML =
      '<div class="empty"><div class="empty-icon">⭐</div><div class="empty-text">Здесь будут заказы вашего<br>постоянного заведения</div></div>';
    document.getElementById('avail-badge').classList.add('hidden');
    document.getElementById('venue-badge').classList.add('hidden');
    tgHaptic('light'); showToast('Смена завершена', 'info');
  }
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
    if (document.getElementById('s-available').classList.contains('active')) renderAvailableOrders();
  });
}

function renderAvailableOrders() {
  const list = document.getElementById('available-list');
  if (!_availOrders.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">Нет доступных заказов</div></div>';
    return;
  }
  const myVenue = COURIER_DATA?.primaryVenueId;
  const byVenue = {};
  for (const o of _availOrders) {
    if (!byVenue[o.venueId]) byVenue[o.venueId] = [];
    byVenue[o.venueId].push(o);
  }
  const groups = Object.values(byVenue).sort((a,b) => (a[0].venueId===myVenue?-1:1)-(b[0].venueId===myVenue?-1:1));
  list.innerHTML = groups.map(g => _poolBundleCard(g, myVenue)).join('');
}

// ══════════════════════════════════════════════════════════
//  VENUE ORDERS (важные — заказы своего заведения)
// ══════════════════════════════════════════════════════════
function watchVenueOrders() {
  if (_venueUnsub) { _venueUnsub(); _venueUnsub = null; }
  const myVenue = COURIER_DATA?.primaryVenueId;
  if (!myVenue) return;
  _venueUnsub = onQuerySnap('orders', 'venueId', '==', myVenue, orders => {
    _venueOrders = orders.filter(o =>
      o.status === 'ready_for_courier' ||
      (o.status === 'searching_courier' && !o.courierUid)
    );
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
    if (document.getElementById('s-venue-orders').classList.contains('active')) renderVenueOrders();
  });
}

function renderVenueOrders() {
  const list = document.getElementById('venue-orders-list');
  const myVenue = COURIER_DATA?.primaryVenueId;
  if (!myVenue) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">Вы не привязаны к заведению.<br>Ждите приглашения.</div></div>';
    return;
  }
  if (!COURIER_DATA?.onShift) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🚴</div><div class="empty-text">Включите смену, чтобы<br>видеть заказы</div></div>';
    return;
  }

  const important = _venueOrders.filter(o => o.status === 'ready_for_courier');
  const pool      = _venueOrders.filter(o => o.status === 'searching_courier' && !o.courierUid);

  if (!important.length && !pool.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">✅</div><div class="empty-text">Нет ожидающих заказов</div></div>';
    return;
  }

  let html = '';
  if (important.length) {
    html += `<div class="section-title" style="padding:0 4px;margin-bottom:6px">⚡ Готовы к выдаче (${important.length})</div>`;
    html += important.map(o => _importantOrderCard(o)).join('');
  }
  if (pool.length) {
    if (important.length) html += `<div class="section-title" style="padding:0 4px;margin:12px 0 6px">📭 Из общего пула (${pool.length})</div>`;
    const byVenue = {};
    for (const o of pool) { if (!byVenue[o.venueId]) byVenue[o.venueId] = []; byVenue[o.venueId].push(o); }
    html += Object.values(byVenue).map(g => _poolBundleCard(g, myVenue)).join('');
  }
  list.innerHTML = html;
}

function _importantOrderCard(order) {
  const addr = order.address;
  const addrStr = addr ? `${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt ? ', кв.' + escHtml(addr.apt) : ''}` : 'Самовывоз';
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
        <div>📍 ${addrStr}</div>
        <div>💰 ${fmtPrice((order.total || 0) + (order.deliveryPrice || 0))} · ${order.payment === 'cash' ? 'Наличные' : 'Карта'}</div>
      </div>
      <div class="delivery-card-foot" style="font-size:12px;color:var(--text-dim);padding-top:4px">
        ℹ️ Заказ готов — оператор передаст его лично при вашем приезде
      </div>
    </div>`;
}

function _poolBundleCard(orders, myVenueId) {
  const first  = orders[0];
  const isOwn  = first.venueId === myVenueId;
  const pool   = isOwn ? 'venue' : 'available';
  const ids    = orders.map(o => o.id).join(',');
  const totalDelivery = orders.reduce((s,o) => s+(o.deliveryPrice||0), 0);
  const totalAmt      = orders.reduce((s,o) => s+(o.total||0)+(o.deliveryPrice||0), 0);
  const addrLines = orders.map(o => {
    const addr = o.address;
    return addr
      ? `<div class="flex items-center gap-2"><span>📍</span><span>${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt?', кв.'+escHtml(addr.apt):''}</span></div>`
      : '<div>🏪 Самовывоз</div>';
  }).join('');
  return `
    <div class="delivery-card" onclick="openBundleAcceptSheet('${ids}','${pool}')" style="cursor:pointer">
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
      </div>
      <div class="delivery-card-foot">
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openBundleAcceptSheet('${ids}','${pool}')">
          ✅ Принять →
        </button>
      </div>
    </div>`;
}

// Kept for any legacy call paths
function _orderPoolCard(o, myVenueId) { return _poolBundleCard([o], myVenueId); }

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
  try { venueAddr = (await dbGet('venues', order.venueId))?.address || '—'; } catch {}
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
  _shownAssigned.add(orderId);
  await dbSet('orders', orderId, {
    status: 'courier_assigned',
    courierUid: STATE.uid,
    courierName: COURIER_DATA?.name || 'Курьер',
    courierPhone: COURIER_DATA?.phone || '',
    assignedAt: new Date().toISOString()
  });
  closeAcceptSheet();
  tgHaptic('success');
  showToast('Заказ принят! Едете в кафе.', 'success');
  navToMyOrders();
}

async function openBundleAcceptSheet(orderIdsStr, pool) {
  const ids = orderIdsStr.split(',').filter(Boolean);
  const src = pool==='venue' ? _venueOrders : _availOrders;
  const orders = ids.map(id => src.find(o=>o.id===id) || _availOrders.find(o=>o.id===id) || _venueOrders.find(o=>o.id===id)).filter(Boolean);
  if (!orders.length) return;
  _acceptOrderIds  = ids;
  _acceptOrderId   = ids[0];
  _acceptFromPool  = pool;

  const first = orders[0];
  let venueAddr = '—';
  try { venueAddr = (await dbGet('venues', first.venueId))?.address || '—'; } catch {}

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
  if (!_acceptOrderIds.length) return;
  const now  = new Date().toISOString();
  const cName = COURIER_DATA?.name || 'Курьер';
  for (const id of _acceptOrderIds) {
    _shownAssigned.add(id);
    await dbSet('orders', id, {
      status: 'courier_assigned',
      courierUid: STATE.uid, courierName: cName,
      courierPhone: COURIER_DATA?.phone || '',
      assignedAt: now
    });
  }
  closeAcceptSheet();
  tgHaptic('success');
  showToast(`Принято ${_acceptOrderIds.length} заказ(а)! Едете в кафе.`, 'success');
  navToMyOrders();
}

function closeAcceptSheet(e) {
  if (e && e.target !== document.getElementById('accept-overlay')) return;
  document.getElementById('accept-overlay').classList.remove('open');
  if (document.querySelector('.overlay.open') === null) tg?.BackButton?.hide();
}

// ══════════════════════════════════════════════════════════
//  MY ORDERS
// ══════════════════════════════════════════════════════════
function watchMyOrders() {
  if (_myUnsub) { _myUnsub(); _myUnsub = null; }
  _myUnsub = onQuerySnap('orders', 'courierUid', '==', STATE.uid, orders => {
    _myOrders = orders
      .filter(o => o.status === 'courier_assigned' || o.status === 'delivering')
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    _myHistory = orders
      .filter(o => o.status === 'delivered' && o.courierUid === STATE.uid)
      .sort((a, b) => (b.deliveredAt || b.createdAt || '').localeCompare(a.deliveredAt || a.createdAt || ''));
    const cnt = _myOrders.length;
    document.getElementById('my-badge').textContent = cnt;
    document.getElementById('my-badge').classList.toggle('hidden', cnt === 0);

    _myOrders.forEach(o => {
      if (!_shownAssigned.has(o.id)) {
        _shownAssigned.add(o.id);
        showAssignedNotif(o);
      }
    });

    if (document.getElementById('s-my-orders').classList.contains('active')) renderMyOrders();
  });
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

  const histSlice = _myHistory.slice(0, _myHistPage);
  if (histSlice.length) {
    html += `<div class="section-title" style="padding:0 4px;margin:12px 0 4px">Последние доставки</div>`;
    html += histSlice.map(o => `
      <div class="delivery-card">
        <div class="delivery-card-hdr">
          <div>
            <div class="font-bold" style="font-size:13px">${escHtml(o.venueName || 'Заведение')}</div>
            <div class="text-xs text-dim">${fmtDate(o.deliveredAt || o.createdAt)} · #${(o.id || '').slice(-6)}</div>
          </div>
          <span class="text-success font-bold">${fmtPrice(o.deliveryPrice || 0)}</span>
        </div>
        <div class="delivery-card-body text-sm text-dim">
          ${o.address ? `📍 ${escHtml(o.address.street)} ${escHtml(o.address.house)}` : '🏪 Самовывоз'}
        </div>
      </div>`).join('');
    if (_myHistory.length > _myHistPage) {
      html += `<button class="btn btn-ghost btn-sm" style="width:100%;margin-top:4px" onclick="_myHistPage+=10;renderMyOrders()">＋ Загрузить ещё</button>`;
    }
  }

  if (!html) {
    html = '<div class="empty" style="padding-top:40px"><div class="empty-icon">📦</div><div class="empty-text">Нет активных доставок</div></div>';
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
    const venueData = await dbGet('venues', order.venueId);
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
      : `<div class="btn-row">
           <button class="btn btn-ghost btn-sm" onclick="courierReturn('${order.id}')">↩ Возврат</button>
           <button class="btn btn-success" onclick="courierDeliver('${order.id}')">✅ Доставил</button>
         </div>`
    }`;
  document.getElementById('my-order-overlay').classList.add('open');
  tg?.BackButton?.show();
}

async function courierDeliver(orderId) {
  const doDeliver = async () => {
    await dbSet('orders', orderId, {
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
      clientNotification: { type: 'delivered', seen: false }
    });
    // Increment total deliveries
    const courier = await dbGet('couriers', STATE.uid);
    const total = (courier?.totalDeliveries || 0) + 1;
    await dbSet('couriers', STATE.uid, { totalDeliveries: total });
    COURIER_DATA = { ...COURIER_DATA, totalDeliveries: total };
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
  document.getElementById('my-order-overlay').classList.remove('open');
  if (document.querySelector('.overlay.open') === null) tg?.BackButton?.hide();
}

// ══════════════════════════════════════════════════════════
//  PROFILE
// ══════════════════════════════════════════════════════════
async function loadCourierProfile() {
  const courier = await dbGet('couriers', STATE.uid) || COURIER_DATA || {};
  COURIER_DATA = { ...COURIER_DATA, ...courier };

  const phone = courier.phone || STATE.user?.phone || '';
  // QR
  document.getElementById('courier-qr-phone').textContent = phone || '—';
  if (phone) {
    document.getElementById('courier-qr-img').src = getQrUrl(phone, 180);
  }

  // Stats
  const statsGrid = document.getElementById('courier-stats-grid');
  const delivered = courier.totalDeliveries || 0;
  const rating = courier.rating || 0;
  const ratingCnt = courier.ratingCount || 0;
  statsGrid.innerHTML = `
    <div class="stat-card"><div class="stat-val">${delivered}</div><div class="stat-lbl">Доставок</div></div>
    <div class="stat-card"><div class="stat-val">${rating > 0 ? rating.toFixed(1) : '—'}</div><div class="stat-lbl">Рейтинг</div></div>
    <div class="stat-card"><div class="stat-val">${ratingCnt}</div><div class="stat-lbl">Оценок</div></div>`;

  // Rating
  const ratingVal = document.getElementById('cr-rating-val');
  const starsRow = document.getElementById('cr-stars-row');
  const ratingCntEl = document.getElementById('cr-rating-cnt');
  if (rating > 0) {
    ratingVal.textContent = rating.toFixed(1);
    starsRow.innerHTML = renderStars(rating);
    ratingCntEl.textContent = ratingCnt + (ratingCnt === 1 ? ' оценка' : ratingCnt < 5 ? ' оценки' : ' оценок');
  } else {
    ratingVal.textContent = '—';
    starsRow.innerHTML = renderStars(0);
    ratingCntEl.textContent = 'Нет оценок';
  }

  // Venue info
  const venueCard = document.getElementById('courier-venue-card');
  if (courier.primaryVenueId) {
    try {
      const venue = await dbGet('venues', courier.primaryVenueId);
      venueCard.innerHTML = `
        <div class="font-bold">${escHtml(venue?.name || courier.primaryVenueId)}</div>
        <div class="text-dim text-sm mt-1">${escHtml(venue?.address || '')}</div>
        ${venue?.phone ? `<div class="text-sm mt-1">📞 ${escHtml(venue.phone)}</div>` : ''}`;
    } catch {
      venueCard.innerHTML = `<div class="text-dim text-sm">Ошибка загрузки</div>`;
    }
  } else {
    venueCard.innerHTML = `<div class="text-dim text-sm">Не привязан к заведению</div>`;
  }

  // Set today's date by default in history picker
  const histDate = document.getElementById('cr-hist-date');
  if (!histDate.value) {
    histDate.value = new Date().toISOString().slice(0, 10);
  }
  await loadCourierHistory();
}

async function loadCourierHistory() {
  const list = document.getElementById('courier-history-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';

  const dateStr = document.getElementById('cr-hist-date').value;
  let orders = (await dbQuery('orders', 'courierUid', '==', STATE.uid))
    .filter(o => o.status === 'delivered');

  if (dateStr) {
    orders = orders.filter(o => {
      const d = (o.deliveredAt || o.createdAt || '').slice(0, 10);
      return d === dateStr;
    });
  }
  orders.sort((a, b) => (b.deliveredAt || b.createdAt || '').localeCompare(a.deliveredAt || a.createdAt || ''));

  if (!orders.length) {
    list.innerHTML = '<div class="empty" style="padding:16px 0"><div class="empty-icon">📋</div><div class="empty-text">Нет доставок за этот день</div></div>';
    return;
  }

  let dayEarnings = 0;
  orders.forEach(o => { dayEarnings += o.deliveryPrice || 0; });

  list.innerHTML = `
    <div class="flex justify-between" style="padding:8px 4px;border-bottom:1px solid var(--border);margin-bottom:4px">
      <span class="text-dim text-sm">${orders.length} ${orders.length === 1 ? 'доставка' : orders.length < 5 ? 'доставки' : 'доставок'}</span>
      <span class="font-bold text-primary">${fmtPrice(dayEarnings)}</span>
    </div>` +
    orders.map(o => `
      <div class="delivery-card">
        <div class="delivery-card-hdr">
          <div>
            <div class="font-bold" style="font-size:13px">${escHtml(o.venueName || 'Заведение')}</div>
            <div class="text-xs text-dim">${fmtTime(o.deliveredAt || o.createdAt)} · #${(o.id || '').slice(-6)}</div>
          </div>
          <div>
            <div class="text-success font-bold">${fmtPrice(o.deliveryPrice || 0)}</div>
            ${o.courierRating ? `<div style="text-align:right;font-size:12px;color:var(--text-dim)">${'★'.repeat(o.courierRating)}</div>` : ''}
          </div>
        </div>
        <div class="delivery-card-body text-sm">
          <div>${o.address ? `📍 ${escHtml(o.address.street)} ${escHtml(o.address.house)}` : '🏪 Самовывоз'}</div>
          <div class="text-dim">${(o.items || []).slice(0, 2).map(i => `${i.emoji || '🍽️'} ${escHtml(i.name)} ×${i.qty}`).join(', ')}</div>
        </div>
      </div>`).join('');
}

async function courierLeaveVenue() {
  const ok = await new Promise(resolve => {
    if (tg?.showConfirm) tg.showConfirm('Отвязаться от заведения?', resolve);
    else resolve(confirm('Отвязаться от заведения?'));
  });
  if (!ok) return;
  await dbSet('couriers', STATE.uid, { primaryVenueId: null, primaryVenueName: null });
  COURIER_DATA = { ...COURIER_DATA, primaryVenueId: null, primaryVenueName: null };
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
