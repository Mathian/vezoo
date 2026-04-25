'use strict';
/* ============================================================
   VEZOO OPERATOR — Order Management Mini App
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUE        = null;
let _newUnsub    = null;
let _activeUnsub = null;
let _alertInterval = null;
let _pendingOrders = [];
let _activeOrders  = [];
let _inviteData    = null;
let _agreedCheck   = false;
let _assignOrderId = null;

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') { localStorage.clear(); location.replace(location.pathname); return; }
  tgReady();
  try {
    const s = JSON.parse(localStorage.getItem('vez_op_state') || '{}');
    STATE.uid = s.uid||null; STATE.user = s.user||null;
  } catch {}
  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }
  await initFirebase();
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing?.blocked) { showScreen('s-blocked'); return; }
  if (!existing?.agreedOperator) { showScreen('s-agree'); return; }
  STATE.user = existing; saveState();
  await checkVenueAssignment();
});

function saveState() { try { localStorage.setItem('vez_op_state', JSON.stringify({ uid: STATE.uid, user: STATE.user })); } catch {} }

// ── Agreement ──
function toggleAgreeCheck() {
  _agreedCheck = !_agreedCheck;
  document.getElementById('agree-box').textContent = _agreedCheck ? '✓' : '';
  document.getElementById('agree-check-row').classList.toggle('checked', _agreedCheck);
  document.getElementById('agree-btn').disabled = !_agreedCheck;
}
async function submitAgree() { showScreen('s-onboard'); }

async function onboardSubmit() {
  const name = document.getElementById('ob-name').value.trim();
  if (!name) { showToast('Введите имя', 'warning'); return; }
  const btn = document.getElementById('ob-btn'); btn.disabled = true;
  const linkData = await dbGet('user_links', STATE.uid);
  STATE.user = { name, phone: linkData?.phone||'', tgId: linkData?.tgId||'', role: 'operator', agreedOperator: true, createdAt: new Date().toISOString() };
  await dbSet('users', STATE.uid, STATE.user); saveState();
  btn.disabled = false;
  await checkVenueAssignment();
}

// ── Check venue assignment ──
async function checkVenueAssignment() {
  // Check if there's a pending invite
  const invite = await dbGet('operator_invites', STATE.uid);
  if (invite && invite.status === 'pending') {
    _inviteData = invite;
    document.getElementById('invite-venue-name').textContent = invite.venueName||'Заведение';
    document.getElementById('invite-venue-addr').textContent = invite.venueAddress||'';
    showScreen('s-confirm-venue');
    return;
  }

  const user = await dbGet('users', STATE.uid);
  if (user?.operatorVenueId) {
    const v = await dbGet('venues', user.operatorVenueId);
    if (v) { VENUE = v; initMain(); return; }
  }
  showScreen('s-no-venue');
}

async function acceptVenueInvite() {
  if (!_inviteData) return;
  await dbSet('operator_invites', STATE.uid, { status: 'confirmed', confirmedAt: new Date().toISOString() });
  await dbSet('users', STATE.uid, { operatorVenueId: _inviteData.venueId });
  VENUE = await dbGet('venues', _inviteData.venueId);
  tgHaptic('success'); initMain();
}

async function declineVenueInvite() {
  if (!_inviteData) return;
  await dbDelete('operator_invites', STATE.uid);
  _inviteData = null; showScreen('s-no-venue');
}

// ── Init main ──
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  document.getElementById('op-venue-name-hdr').textContent = VENUE.name;
  startHeartbeat(STATE.uid);
  watchOrders();
  showScreen('s-new-orders');
  // Set today as default history date
  const today = new Date().toISOString().slice(0,10);
  const dateInput = document.getElementById('hist-date');
  if (dateInput) dateInput.value = today;
}

// ══════════════════════════════════════════════════════════
//  ORDER WATCHING
// ══════════════════════════════════════════════════════════
function watchOrders() {
  _newUnsub = onQuerySnap('orders', 'venueId', '==', VENUE.id, orders => {
    _pendingOrders = orders.filter(o => o.status === 'pending').sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''));
    _activeOrders  = orders.filter(o => ['accepted','cooking','searching_courier','delivering'].includes(o.status));

    const cnt = _pendingOrders.length;
    document.getElementById('new-orders-badge').textContent = cnt;
    document.getElementById('new-orders-badge').classList.toggle('hidden', cnt===0);
    document.getElementById('new-badge').textContent = cnt;
    document.getElementById('new-badge').classList.toggle('hidden', cnt===0);
    document.getElementById('new-orders-alert').classList.toggle('hidden', cnt===0);

    if (cnt > 0) {
      if (!_alertInterval) { playNewOrder(); _alertInterval = setInterval(playNewOrder, 4000); }
    } else {
      if (_alertInterval) { clearInterval(_alertInterval); _alertInterval = null; }
    }

    if (document.getElementById('s-new-orders').classList.contains('active')) renderPendingOrders();
    if (document.getElementById('s-active-orders').classList.contains('active')) renderActiveOrders();

    // Check for delivered orders to notify
    orders.filter(o => o.status === 'delivered' && !o._opNotified).forEach(o => {
      showDeliveredNotif(o);
    });
  });
}

function renderPendingOrders() {
  const list = document.getElementById('new-orders-list');
  if (!_pendingOrders.length) { list.innerHTML='<div class="empty" style="padding-top:40px"><div class="empty-icon">🔔</div><div class="empty-text">Нет новых заказов</div></div>'; return; }
  list.innerHTML = _pendingOrders.map(o => renderOpOrderCard(o, true)).join('');
}

function renderActiveOrders() {
  const list = document.getElementById('active-orders-list');
  if (!_activeOrders.length) { list.innerHTML='<div class="empty" style="padding-top:40px"><div class="empty-icon">⚡</div><div class="empty-text">Нет активных заказов</div></div>'; return; }
  list.innerHTML = _activeOrders.sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')).map(o => renderOpOrderCard(o, false)).join('');
}

function renderOpOrderCard(o, isPending) {
  const addr = o.address;
  return `
    <div class="order-card" onclick="openOpOrderDetail('${o.id}')" style="cursor:pointer${isPending?';border-color:rgba(255,214,10,.4)':''}">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">${o.clientName}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id||'').slice(-6)}</div></div>
        <div style="text-align:right"><span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span><div style="font-weight:700;font-size:15px;color:var(--primary);margin-top:2px">${fmtPrice(o.total)}</div></div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items||[]).map(i=>`${i.emoji||'🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
        ${addr?`<div class="text-sm text-dim mt-1">📍 ${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}</div>`:''}
        ${o.comment?`<div class="text-sm text-dim mt-1">💬 ${o.comment}</div>`:''}
      </div>
    </div>`;
}

// ── Order detail ──
async function openOpOrderDetail(orderId) {
  const all = [..._pendingOrders, ..._activeOrders];
  let order  = all.find(o => o.id === orderId);
  if (!order) {
    const fetched = await dbGet('orders', orderId);
    if (!fetched) return;
    order = fetched;
  }
  const addr    = order.address;
  const content = document.getElementById('op-order-detail');
  content.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:12px">
      <div><div class="font-bold" style="font-size:16px">Заказ #${(order.id||'').slice(-6)}</div><div class="order-id">${fmtDate(order.createdAt)}</div></div>
      <span class="${statusBadgeClass(order.status)}">${statusLabel(order.status)}</span>
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span class="font-bold">${order.clientName}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${order.clientPhone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
      ${addr?`<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}${addr.hasIntercom?' · домофон: '+(addr.intercomCode||'есть'):''}</span></div>`:''}
      ${order.deliveryType==='pickup'?'<div class="flex justify-between"><span class="text-dim">Получение</span><span>🏪 Самовывоз</span></div>':''}
      ${order.comment?`<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%">${order.comment}</span></div>`:''}
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      ${(order.items||[]).map(it=>`<div class="flex justify-between"><span>${it.emoji||'🍽️'} ${it.name}${it.variantName?' ('+it.variantName+')':''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
      <div class="divider"></div>
      ${order.deliveryPrice?`<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(order.deliveryPrice)}</span></div>`:''}
      <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice(order.total+(order.deliveryPrice||0))}</span></div>
    </div>
    ${renderOpActions(order)}`;
  document.getElementById('order-overlay').classList.add('open');
}

function renderOpActions(order) {
  if (order.status === 'pending') return `
    <div class="btn-row">
      <button class="btn btn-danger btn-sm" onclick="opCancelOrder('${order.id}')">❌ Отменить</button>
      <button class="btn btn-success btn-sm" onclick="opAcceptOrder('${order.id}')">✅ Подтвердить</button>
    </div>`;
  if (order.status === 'accepted' || order.status === 'cooking') return `
    <div class="btn-row">
      <button class="btn btn-primary btn-sm" onclick="opSearchCourier('${order.id}')">🔍 Искать курьера</button>
      <button class="btn btn-secondary btn-sm" onclick="opOpenAssignCourier('${order.id}')">👤 Назначить</button>
    </div>`;
  if (order.status === 'searching_courier') return `
    <button class="btn btn-secondary btn-sm" onclick="opOpenAssignCourier('${order.id}')">👤 Назначить курьера</button>`;
  if (order.status === 'delivering') return `
    <div class="alert-box success" style="margin-bottom:8px">🚴 Передан курьеру: ${order.courierName||'—'}</div>
    <button class="btn btn-ghost btn-sm" onclick="opRetransfer('${order.id}')">🔄 Переназначить</button>`;
  return '';
}

async function opAcceptOrder(orderId) {
  const mins = VENUE?.deliveryTime || 60;
  const estimated = new Date(Date.now() + mins * 60000).toISOString();
  await dbSet('orders', orderId, {
    status: 'cooking', acceptedAt: new Date().toISOString(), operatorUid: STATE.uid,
    deliveryMinutes: mins, estimatedAt: estimated,
    clientNotification: { type: 'accepted', seen: false }
  });
  tgHaptic('success'); closeOrderSheet(); showToast('Заказ принят', 'success');
}

async function opCancelOrder(orderId) {
  if (!confirm('Отменить заказ? Клиент получит уведомление.')) return;
  await dbSet('orders', orderId, { status: 'cancelled', cancelledAt: new Date().toISOString(), clientNotification: { type: 'cancelled', seen: false } });
  tgHaptic('light'); closeOrderSheet(); showToast('Заказ отменён', 'info');
}

async function opSearchCourier(orderId) {
  await dbSet('orders', orderId, { status: 'searching_courier', searchStartedAt: new Date().toISOString() });
  tgHaptic('success'); showToast('Ищем курьеров...', 'info');
  closeOrderSheet();
}

async function opOpenAssignCourier(orderId) {
  _assignOrderId = orderId;
  const listEl = document.getElementById('courier-select-list');
  listEl.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  document.getElementById('order-overlay').classList.remove('open');
  document.getElementById('courier-overlay').classList.add('open');

  const onShift  = (await dbQuery('couriers','onShift','==',true)).filter(c => c.status==='active');
  const permLinks = await dbQuery('courier_venue_links','venueId','==',VENUE.id);
  const permUids  = permLinks.filter(l=>l.status==='confirmed').map(l=>l.uid);
  const sorted    = [...onShift].sort((a,_) => permUids.includes(a.uid)?-1:1);

  if (!sorted.length) { listEl.innerHTML='<div class="empty"><div class="empty-text">Нет курьеров на смене</div></div>'; return; }
  listEl.innerHTML = sorted.map(c => `
    <div class="list-item" onclick="opAssignCourier('${c.uid}','${c.name||'Курьер'}')">
      <div class="li-icon yellow">🚴</div>
      <div class="li-body"><div class="li-title">${c.name||'—'}${permUids.includes(c.uid)?' <span class="pill" style="font-size:10px">Постоянный</span>':''}</div><div class="li-sub">${c.phone||''}</div></div>
      <div class="chevron">›</div>
    </div>`).join('');
}

async function opAssignCourier(courierUid, courierName) {
  if (!_assignOrderId) return;
  await dbSet('orders', _assignOrderId, {
    status: 'delivering', courierUid, courierName, assignedAt: new Date().toISOString(),
    clientNotification: { type: 'delivering', seen: false, message: `Курьер ${courierName} везёт ваш заказ!` }
  });
  closeCourierSheet(); tgHaptic('success'); showToast(`Передано курьеру ${courierName}`, 'success');
}

async function opRetransfer(orderId) {
  await dbSet('orders', orderId, { status: 'searching_courier', courierUid: null, courierName: null });
  closeOrderSheet();
  await opOpenAssignCourier(orderId);
}

function showDeliveredNotif(order) {
  const el = document.getElementById('notif-delivered-op');
  document.getElementById('notif-delivered-op-text').textContent = `Заказ #${(order.id||'').slice(-6)} от ${order.clientName} доставлен.`;
  el.classList.add('open');
  playSuccess();
  dbSet('orders', order.id, { _opNotified: true });
}

// ── History ──
async function loadOpHistory() {
  const list = document.getElementById('op-history-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const date = document.getElementById('hist-date')?.value;
  let orders = (await dbQuery('orders','venueId','==',VENUE.id))
    .filter(o => ['delivered','cancelled'].includes(o.status));
  if (date) orders = orders.filter(o => o.createdAt?.startsWith(date));
  orders = orders.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  if (!orders.length) { list.innerHTML='<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Заказов за этот день нет</div></div>'; return; }
  list.innerHTML = orders.map(o => renderOpOrderCard(o, false)).join('');
}

function closeOrderSheet(e) {
  if (e && e.target !== document.getElementById('order-overlay')) return;
  document.getElementById('order-overlay').classList.remove('open');
}
function closeCourierSheet(e) {
  if (e && e.target !== document.getElementById('courier-overlay')) return;
  document.getElementById('courier-overlay').classList.remove('open');
}
function setNav(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}
