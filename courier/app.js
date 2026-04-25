'use strict';
/* ============================================================
   VEZOO COURIER — Delivery App
   ============================================================ */

const STATE = { uid: null, user: null };
let COURIER_DATA    = null;
let _availUnsub     = null;
let _myUnsub        = null;
let _availOrders    = [];
let _myOrders       = [];
let _shownAssigned  = new Set();
let _agreedCheck    = false;
let _venueInvite    = null;
let _acceptOrderId  = null;

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') { localStorage.clear(); location.replace(location.pathname); return; }
  tgReady();
  try {
    const s = JSON.parse(localStorage.getItem('vez_courier_state') || '{}');
    STATE.uid = s.uid||null; STATE.user = s.user||null;
  } catch {}
  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }
  await initFirebase();
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing?.blocked) { showScreen('s-blocked'); return; }
  if (!existing?.agreedCourier) { showScreen('s-agree'); return; }
  STATE.user = existing; saveState();
  await checkCourierStatus();
});

function saveState() { try { localStorage.setItem('vez_courier_state', JSON.stringify({ uid: STATE.uid, user: STATE.user })); } catch {} }

// ── Agreement ──
function toggleAgreeCheck() {
  const cb = document.getElementById('agree-cb');
  _agreedCheck = cb ? cb.checked : !_agreedCheck;
  document.getElementById('agree-box').textContent = _agreedCheck ? '✓' : '';
  document.getElementById('agree-check-row').classList.toggle('checked', _agreedCheck);
  document.getElementById('agree-btn').disabled = !_agreedCheck;
}
async function submitAgree() { showScreen('s-onboard'); }

async function onboardSubmit() {
  const name = document.getElementById('ob-name').value.trim();
  if (!name) { showToast('Введите имя', 'warning'); return; }
  const btn = document.getElementById('ob-btn'); btn.disabled = true; btn.classList.add('btn-loading');
  const linkData = await dbGet('user_links', STATE.uid);
  STATE.user = { name, phone: linkData?.phone||'', tgId: linkData?.tgId||'', role: 'courier', agreedCourier: true, createdAt: new Date().toISOString() };
  await dbSet('users', STATE.uid, STATE.user);
  await dbSet('couriers', STATE.uid, { uid: STATE.uid, name, phone: linkData?.phone||'', status: 'pending', onShift: false, createdAt: new Date().toISOString() });
  saveState();
  btn.disabled = false; btn.classList.remove('btn-loading');
  showScreen('s-pending');
}

// ── Check courier status ──
async function checkCourierStatus() {
  const courier = await dbGet('couriers', STATE.uid);
  COURIER_DATA  = courier;
  if (!courier) { showScreen('s-pending'); return; }
  if (courier.status === 'pending') { showScreen('s-pending'); return; }
  if (courier.status === 'blocked') { showScreen('s-blocked'); return; }

  // Check for pending venue invite
  const invite = await dbGet('courier_venue_links', STATE.uid);
  if (invite && invite.status === 'pending') {
    _venueInvite = invite;
    document.getElementById('venue-invite-name').textContent = invite.venueName||'Заведение';
    document.getElementById('venue-invite-addr').textContent = invite.venueAddress||'';
    const notice = document.getElementById('current-primary-notice');
    if (courier.primaryVenueId && courier.primaryVenueId !== invite.venueId) {
      const primaryVenue = await dbGet('venues', courier.primaryVenueId);
      notice.textContent = `Сейчас ваше постоянное кафе: ${primaryVenue?.name||courier.primaryVenueId}. При принятии — оно сменится.`;
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
  watchMyOrders();
  if (onShift) watchAvailableOrders();
  showScreen('s-available');
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
    watchAvailableOrders(); tgHaptic('success'); showToast('Смена начата', 'success');
  } else {
    if (_availUnsub) { _availUnsub(); _availUnsub = null; }
    _availOrders = [];
    document.getElementById('available-list').innerHTML = '<div class="empty"><div class="empty-icon">🚴</div><div class="empty-text">Включите смену, чтобы<br>видеть доступные заказы</div></div>';
    document.getElementById('avail-badge').classList.add('hidden');
    tgHaptic('light'); showToast('Смена завершена', 'info');
  }
}

// ══════════════════════════════════════════════════════════
//  AVAILABLE ORDERS
// ══════════════════════════════════════════════════════════
function watchAvailableOrders() {
  if (_availUnsub) { _availUnsub(); _availUnsub = null; }
  _availUnsub = onQuerySnap('orders', 'status', '==', 'searching_courier', orders => {
    _availOrders = orders.filter(o => !o.courierUid);
    const cnt = _availOrders.length;
    document.getElementById('avail-badge').textContent = cnt;
    document.getElementById('avail-badge').classList.toggle('hidden', cnt===0);
    if (document.getElementById('s-available').classList.contains('active')) renderAvailableOrders();
  });
}

function renderAvailableOrders() {
  const list = document.getElementById('available-list');
  if (!_availOrders.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">Нет доступных заказов</div></div>';
    return;
  }
  // Sort: primary venue orders first
  const myVenue = COURIER_DATA?.primaryVenueId;
  const sorted = [..._availOrders].sort((a,_) => a.venueId === myVenue ? -1 : 1);
  list.innerHTML = sorted.map(o => `
    <div class="delivery-card" onclick="openAcceptSheet('${o.id}')" style="cursor:pointer">
      <div class="delivery-card-hdr">
        <div><div class="font-bold" style="font-size:14px">🏪 ${o.venueName||'Заведение'}</div><div class="text-xs text-dim">${fmtDate(o.createdAt)}</div></div>
        <div class="text-primary font-bold">${fmtPrice(o.deliveryPrice||0)}</div>
      </div>
      <div class="delivery-card-body" style="font-size:13px">
        ${o.address?`<div class="flex items-center gap-2"><span>📍</span><span>${o.address.street} ${o.address.house}${o.address.apt?', кв.'+o.address.apt:''}</span></div>`:'<div>🏪 Самовывоз</div>'}
        <div class="flex items-center gap-2"><span>💰</span><span>${fmtPrice(o.total+(o.deliveryPrice||0))}</span><span class="text-dim">· ${o.payment==='cash'?'Наличные':'Карта'}</span></div>
        ${o.venueId===myVenue?'<div class="pill" style="margin-top:4px;font-size:10px;width:fit-content">⭐ Ваше кафе</div>':''}
      </div>
      <div class="delivery-card-foot"><button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openAcceptSheet('${o.id}')">Принять заказ →</button></div>
    </div>`).join('');
}

async function openAcceptSheet(orderId) {
  _acceptOrderId = orderId;
  const order = _availOrders.find(o => o.id === orderId);
  if (!order) return;
  const addr = order.address;
  const content = document.getElementById('accept-order-content');
  content.innerHTML = `
    <div class="sheet-title">Принять заказ?</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${order.venueName||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес кафе</span><span style="text-align:right;max-width:60%">${(await dbGet('venues',order.venueId))?.address||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес доставки</span><span style="text-align:right;max-width:60%">${addr?`${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}`:order.deliveryType==='pickup'?'Самовывоз':'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Вознаграждение</span><span class="font-bold text-primary">${fmtPrice(order.deliveryPrice||0)}</span></div>
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав</div>
    <div class="card card-body" style="margin-bottom:14px;gap:4px;display:flex;flex-direction:column">
      ${(order.items||[]).map(it=>`<div class="flex justify-between text-sm"><span>${it.emoji||'🍽️'} ${it.name} ×${it.qty}</span><span>${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="closeAcceptSheet()">Отмена</button>
      <button class="btn btn-primary" onclick="acceptOrder('${order.id}')">✅ Принять</button>
    </div>`;
  document.getElementById('accept-overlay').classList.add('open');
}

async function acceptOrder(orderId) {
  await dbSet('orders', orderId, {
    status: 'delivering', courierUid: STATE.uid, courierName: COURIER_DATA?.name||'Курьер',
    assignedAt: new Date().toISOString(),
    clientNotification: { type: 'delivering', seen: false, message: `Курьер везёт ваш заказ!` }
  });
  closeAcceptSheet(); tgHaptic('success'); showToast('Заказ принят!', 'success');
  showScreen('s-my-orders'); setNav(document.getElementById('nav-my'));
}

function closeAcceptSheet(e) {
  if (e && e.target !== document.getElementById('accept-overlay')) return;
  document.getElementById('accept-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  MY ORDERS
// ══════════════════════════════════════════════════════════
function watchMyOrders() {
  if (_myUnsub) { _myUnsub(); _myUnsub = null; }
  _myUnsub = onQuerySnap('orders', 'courierUid', '==', STATE.uid, orders => {
    _myOrders = orders.filter(o => o.status === 'delivering').sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''));
    const cnt = _myOrders.length;
    document.getElementById('my-badge').textContent = cnt;
    document.getElementById('my-badge').classList.toggle('hidden', cnt===0);

    // Check for newly assigned orders (from operator direct assign)
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
  document.getElementById('notif-assigned-text').textContent = `Заказ из ${order.venueName||'заведения'} → ${order.address?order.address.street+' '+order.address.house:'клиенту'}`;
  document.getElementById('notif-assigned').classList.add('open');
  tgHaptic('heavy'); playNewOrder();
}

function renderMyOrders() {
  const list = document.getElementById('my-orders-list');
  if (!_myOrders.length) { list.innerHTML='<div class="empty" style="padding-top:40px"><div class="empty-icon">📦</div><div class="empty-text">Нет активных доставок</div></div>'; return; }
  list.innerHTML = _myOrders.map(o => {
    const addr = o.address;
    const showCd = o.estimatedAt;
    return `
      <div class="delivery-card" onclick="openMyOrder('${o.id}')" style="cursor:pointer">
        <div class="delivery-card-hdr">
          <div><div class="font-bold" style="font-size:14px">🏪 ${o.venueName||'Заведение'}</div><div class="text-xs text-dim">#${(o.id||'').slice(-6)} · ${fmtDate(o.createdAt)}</div></div>
          <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
        </div>
        <div class="delivery-card-body" style="font-size:13px">
          ${addr?`<div>📍 ${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}</div>`:''}
          <div>💰 ${fmtPrice(o.total+(o.deliveryPrice||0))} · ${o.payment==='cash'?'Наличные':'Карта'}</div>
          ${showCd?`<div id="cdc-${o.id}" style="font-size:12px;color:var(--primary);margin-top:2px">⏱ —</div>`:''}
        </div>
        <div class="delivery-card-foot">
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openMyOrder('${o.id}')">Детали →</button>
        </div>
      </div>`;
  }).join('');
  _myOrders.forEach(o => { if (o.estimatedAt) startMiniCountdown(o); });
}

function startMiniCountdown(o) {
  const target = new Date(o.estimatedAt).getTime();
  const tick = () => {
    const el = document.getElementById(`cdc-${o.id}`);
    if (!el) return;
    const rem = target - Date.now();
    if (rem <= 0) { el.textContent = '⏱ Должно быть доставлено!'; el.style.color='var(--danger)'; return; }
    el.textContent = '⏱ ' + fmtCountdown(rem);
  };
  tick(); setInterval(tick, 1000);
}

// ── My order detail ──
async function openMyOrder(orderId) {
  const order = _myOrders.find(o => o.id === orderId);
  if (!order) return;
  const addr    = order.address;
  const venueDoc = await dbGet('venues', order.venueId);
  const content  = document.getElementById('my-order-detail');
  content.innerHTML = `
    <div class="sheet-title">Заказ #${(order.id||'').slice(-6)}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${order.venueName||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес кафе</span><span style="text-align:right;max-width:60%">${venueDoc?.address||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span>${order.clientName}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${order.clientPhone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес доставки</span><span style="text-align:right;max-width:60%">${addr?`${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}${addr.hasIntercom?' · домофон: '+(addr.intercomCode||'есть'):''}`:order.deliveryType==='pickup'?'Самовывоз':'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Сумма</span><span class="font-bold text-primary">${fmtPrice(order.total+(order.deliveryPrice||0))}</span></div>
      ${order.comment?`<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%">${order.comment}</span></div>`:''}
    </div>
    <div class="card card-body" style="margin-bottom:14px;gap:5px;display:flex;flex-direction:column">
      ${(order.items||[]).map(it=>`<div class="flex justify-between text-sm"><span>${it.emoji||'🍽️'} ${it.name}${it.variantName?' ('+it.variantName+')':''} ×${it.qty}</span><span>${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost btn-sm" onclick="courierReturn('${order.id}')">↩ Возврат</button>
      <button class="btn btn-success" onclick="courierDeliver('${order.id}')">✅ Доставил</button>
    </div>`;
  document.getElementById('my-order-overlay').classList.add('open');
}

async function courierDeliver(orderId) {
  if (!confirm('Подтвердить доставку заказа?')) return;
  await dbSet('orders', orderId, {
    status: 'delivered', deliveredAt: new Date().toISOString(),
    clientNotification: { type: 'delivered', seen: false }
  });
  closeMyOrderSheet(); tgHaptic('success'); showToast('Заказ доставлен!', 'success');
}

async function courierReturn(orderId) {
  if (!confirm('Оформить возврат заказа? Статус изменится на "Ищем курьера".\nОба подтверждения обязательны.')) return;
  if (!confirm('Вы уверены, что хотите вернуть заказ?')) return;
  await dbSet('orders', orderId, { status: 'searching_courier', courierUid: null, courierName: null, returnAt: new Date().toISOString() });
  closeMyOrderSheet(); tgHaptic('light'); showToast('Возврат оформлен', 'info');
}

function closeMyOrderSheet(e) {
  if (e && e.target !== document.getElementById('my-order-overlay')) return;
  document.getElementById('my-order-overlay').classList.remove('open');
}

// ── History ──
async function loadCourierHistory() {
  const list = document.getElementById('courier-history-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const orders = (await dbQuery('orders','courierUid','==',STATE.uid))
    .filter(o => o.status === 'delivered').sort((a,b)=>(b.deliveredAt||b.createdAt||'').localeCompare(a.deliveredAt||a.createdAt||'')).slice(0,60);
  if (!orders.length) { list.innerHTML='<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Нет завершённых доставок</div></div>'; return; }
  list.innerHTML = orders.map(o => `
    <div class="delivery-card">
      <div class="delivery-card-hdr">
        <div><div class="font-bold" style="font-size:13px">${o.venueName||'Заведение'}</div><div class="text-xs text-dim">${fmtDate(o.deliveredAt||o.createdAt)}</div></div>
        <div class="text-success font-bold">${fmtPrice(o.deliveryPrice||0)}</div>
      </div>
      <div class="delivery-card-body text-sm">
        <div>${o.address?`📍 ${o.address.street} ${o.address.house}`:'Самовывоз'}</div>
        <div class="text-dim">${(o.items||[]).slice(0,2).map(i=>`${i.emoji||'🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
      </div>
    </div>`).join('');
}

function setNav(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}
