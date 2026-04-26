'use strict';
/* ============================================================
   VEZOO OPERATOR — Order Management Panel
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUE         = null;
let _invite       = null;
let _agreedCheck  = false;
let _ordersUnsub  = null;
let _soundTimer   = null;
let _assignOrderId = null;
let _allOrders    = [];

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') {
    localStorage.clear(); location.replace(location.pathname); return;
  }
  tgReady();

  // Multi-account guard
  const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try {
    const s = JSON.parse(localStorage.getItem('vez_op_state') || '{}');
    if (!tgUserId || !s.tgId || s.tgId === tgUserId) {
      STATE.uid  = s.uid  || null;
      STATE.user = s.user || null;
    }
  } catch {}

  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }

  await initFirebase();

  if (!STATE.uid) {
    const tgUid = await resolveUidByTgId();
    if (tgUid) { STATE.uid = tgUid; saveState(); }
  }

  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (!existing) { showScreen('s-no-uid'); return; }
  if (existing.blocked) { showScreen('s-blocked'); return; }
  if (!existing.agreedOperator) { STATE.user = existing; saveState(); showScreen('s-agree'); return; }
  if (!existing.name) { STATE.user = existing; saveState(); showScreen('s-onboard'); return; }

  STATE.user = existing; saveState();
  await checkVenueAssignment();
});

function saveState() {
  const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem('vez_op_state', JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId: tgUserId })); } catch {}
}

// ── Agreement ──
function toggleAgreeCheck() {
  _agreedCheck = !_agreedCheck;
  document.getElementById('agree-box').textContent = _agreedCheck ? '✓' : '';
  document.getElementById('agree-check-row').classList.toggle('checked', _agreedCheck);
  document.getElementById('agree-btn').disabled = !_agreedCheck;
}

async function submitAgree() {
  await dbSet('users', STATE.uid, { agreedOperator: true });
  STATE.user = { ...(STATE.user || {}), agreedOperator: true }; saveState();
  if (!STATE.user?.name) { showScreen('s-onboard'); return; }
  await checkVenueAssignment();
}

// ── Onboarding ──
async function onboardSubmit() {
  const name = document.getElementById('ob-name').value.trim();
  if (!name) { showToast('Введите ваше имя', 'warning'); return; }
  const btn = document.getElementById('ob-btn');
  btn.disabled = true;
  const linkData = await dbGet('user_links', STATE.uid);
  STATE.user = {
    ...(STATE.user || {}),
    name, phone: linkData?.phone || '',
    role: 'operator', agreedOperator: true,
    createdAt: new Date().toISOString()
  };
  await dbSet('users', STATE.uid, STATE.user);
  saveState();
  btn.disabled = false;
  await checkVenueAssignment();
}

// ══════════════════════════════════════════════════════════
//  VENUE ASSIGNMENT
// ══════════════════════════════════════════════════════════
async function checkVenueAssignment() {
  // 1. Check if already has accepted venue
  const fresh = await dbGet('users', STATE.uid);
  if (fresh?.operatorVenueId) {
    VENUE = await dbGet('venues', fresh.operatorVenueId);
    if (VENUE) { STATE.user = fresh; saveState(); initMain(); return; }
  }

  // 2. Check for pending invite
  const invite = await dbGet('operator_invites', STATE.uid);
  if (invite && invite.status === 'pending') {
    _invite = invite;
    document.getElementById('invite-venue-name').textContent = invite.venueName || 'Заведение';
    document.getElementById('invite-venue-addr').textContent = invite.venueAddress || '';
    showScreen('s-confirm-venue');
    return;
  }

  showScreen('s-no-venue');
}

async function acceptVenueInvite() {
  if (!_invite) return;
  const venueId = _invite.venueId;
  await dbSet('users', STATE.uid, { operatorVenueId: venueId, role: 'operator' });
  await dbSet('operator_invites', STATE.uid, { status: 'accepted' });
  STATE.user = { ...STATE.user, operatorVenueId: venueId, role: 'operator' };
  saveState();
  VENUE = await dbGet('venues', venueId);
  tgHaptic('success');
  showToast('Вы приняты в заведение!', 'success');
  initMain();
}

async function declineVenueInvite() {
  if (!_invite) return;
  await dbDelete('operator_invites', STATE.uid);
  _invite = null;
  showScreen('s-no-venue');
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  document.getElementById('op-venue-name-hdr').textContent = VENUE?.name || 'Заведение';
  startHeartbeat(STATE.uid);
  watchOrders();
  showScreen('s-new-orders');
  setNav(document.getElementById('nav-new'));
}

function watchOrders() {
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }
  _ordersUnsub = onQuerySnap('orders', 'venueId', '==', VENUE.id, orders => {
    _allOrders = orders;

    const newOrders    = orders.filter(o => o.status === 'pending')
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const activeOrders = orders.filter(o => ['accepted','cooking','searching_courier','delivering'].includes(o.status))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    // Badge & alert
    const badge = document.getElementById('new-badge');
    badge.textContent = newOrders.length;
    badge.classList.toggle('hidden', newOrders.length === 0);
    document.getElementById('new-orders-alert').classList.toggle('hidden', newOrders.length === 0);

    // Sound loop
    if (newOrders.length > 0) {
      if (!_soundTimer) { playNewOrder(); _soundTimer = setInterval(playNewOrder, 4000); }
    } else {
      if (_soundTimer) { clearInterval(_soundTimer); _soundTimer = null; }
    }

    // Refresh visible screens
    if (document.getElementById('s-new-orders').classList.contains('active'))
      renderNewOrders(newOrders);
    if (document.getElementById('s-active-orders').classList.contains('active'))
      renderActiveOrders(activeOrders);

    // Delivered notification
    orders.filter(o => o.status === 'delivered' && !o.opNotified).forEach(async o => {
      document.getElementById('notif-delivered-op-text').textContent =
        `Заказ #${(o.id || '').slice(-6)} успешно доставлен клиенту.`;
      document.getElementById('notif-delivered-op').classList.add('open');
      await dbSet('orders', o.id, { opNotified: true });
    });
  });
}

// ── Nav helpers ──
function navToNewOrders() {
  showScreen('s-new-orders');
  setNav(document.getElementById('nav-new'));
  const newOrders = _allOrders.filter(o => o.status === 'pending')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  renderNewOrders(newOrders);
}

function navToActiveOrders() {
  showScreen('s-active-orders');
  setNav(document.getElementById('nav-active'));
  const activeOrders = _allOrders.filter(o => ['accepted','cooking','searching_courier','delivering'].includes(o.status))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  renderActiveOrders(activeOrders);
}

// ══════════════════════════════════════════════════════════
//  RENDER ORDERS
// ══════════════════════════════════════════════════════════
function renderNewOrders(orders) {
  const list = document.getElementById('new-orders-list');
  if (!orders.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🔔</div><div class="empty-text">Новых заказов нет.<br>Они появятся здесь автоматически.</div></div>`;
    return;
  }
  list.innerHTML = orders.map(o => renderOpOrderCard(o)).join('');
}

function renderActiveOrders(orders) {
  const list = document.getElementById('active-orders-list');
  if (!orders.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">⚡</div><div class="empty-text">Нет активных заказов</div></div>`;
    return;
  }
  list.innerHTML = orders.map(o => renderOpOrderCard(o)).join('');
}

function renderOpOrderCard(o) {
  const addr = o.address;
  const statusColors = {
    pending:'var(--warning)', accepted:'var(--info)', cooking:'var(--info)',
    searching_courier:'var(--primary)', delivering:'var(--success)'
  };
  const accentColor = statusColors[o.status] || 'var(--border)';
  return `
    <div class="order-card" onclick="openOrderDetail('${o.id}')" style="cursor:pointer;border-left:3px solid ${accentColor}">
      <div class="order-card-hdr">
        <div>
          <div class="font-bold" style="font-size:14px">${o.clientName || 'Клиент'}</div>
          <div class="order-id">${fmtDate(o.createdAt)} · #${(o.id || '').slice(-6)}</div>
        </div>
        <div style="text-align:right">
          <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
          <div style="font-weight:700;font-size:16px;color:var(--primary);margin-top:4px">${fmtPrice(o.total)}</div>
        </div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items || []).map(i => `${i.emoji || '🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
        ${addr
          ? `<div class="text-sm text-dim mt-1">📍 ${addr.street} ${addr.house}${addr.apt ? ', кв.' + addr.apt : ''}</div>`
          : `<div class="text-sm text-dim mt-1">🏪 Самовывоз</div>`}
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  ORDER DETAIL SHEET
// ══════════════════════════════════════════════════════════
async function openOrderDetail(orderId) {
  const order = _allOrders.find(o => o.id === orderId)
    || (await dbQuery('orders', 'venueId', '==', VENUE.id)).find(o => o.id === orderId);
  if (!order) return;

  const addr = order.address;
  let actionBtns = '';

  if (order.status === 'pending') {
    actionBtns = `
      <div class="btn-row">
        <button class="btn btn-danger btn-sm" onclick="opCancelOrder('${orderId}')">❌ Отменить</button>
        <button class="btn btn-primary btn-sm" onclick="opAcceptOrder('${orderId}')">✅ Принять</button>
      </div>`;
  } else if (order.status === 'accepted' || order.status === 'cooking') {
    actionBtns = `
      <button class="btn btn-secondary btn-sm" onclick="opSearchCourier('${orderId}')">🔍 Ищем курьера</button>`;
  } else if (order.status === 'searching_courier') {
    actionBtns = `
      <button class="btn btn-primary btn-sm" onclick="opOpenAssignCourier('${orderId}')">🚴 Назначить курьера</button>`;
  } else if (order.status === 'delivering') {
    actionBtns = `
      <div class="alert-box primary" style="text-align:center">🚴 Курьер: <strong>${order.courierName || '—'}</strong></div>`;
  } else if (order.status === 'delivered' || order.status === 'cancelled') {
    actionBtns = '';
  }

  document.getElementById('op-order-detail').innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:12px">
      <div>
        <div class="font-bold" style="font-size:16px">Заказ #${(order.id || '').slice(-6)}</div>
        <div class="order-id">${fmtDate(order.createdAt)}</div>
      </div>
      <span class="${statusBadgeClass(order.status)}">${statusLabel(order.status)}</span>
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span class="font-bold">${order.clientName || '—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${order.clientPhone || '—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment === 'cash' ? '💵 Наличные' : '💳 Карта'}</span></div>
      ${addr
        ? `<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addr.street} ${addr.house}${addr.apt ? ', кв.' + addr.apt : ''}${addr.hasIntercom ? ` · 🔔 ${addr.intercomCode || 'есть'}` : ''}</span></div>`
        : `<div class="flex justify-between"><span class="text-dim">Получение</span><span>🏪 Самовывоз</span></div>`}
      ${order.comment ? `<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%;font-size:12px">${order.comment}</span></div>` : ''}
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав заказа</div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      ${(order.items || []).map(it =>
        `<div class="flex justify-between"><span>${it.emoji || '🍽️'} ${it.name}${it.variantName ? ' (' + it.variantName + ')' : ''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price * it.qty)}</span></div>`
      ).join('')}
      <div class="divider"></div>
      ${order.deliveryPrice ? `<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(order.deliveryPrice)}</span></div>` : ''}
      <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice(order.total)}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">${actionBtns}</div>`;

  document.getElementById('order-overlay').classList.add('open');
}

async function opAcceptOrder(orderId) {
  const cookingTime = VENUE?.cookingTime || 30;
  const deliveryTime = VENUE?.deliveryTime || 30;
  const totalMins = cookingTime + deliveryTime;
  const estimatedAt = new Date(Date.now() + totalMins * 60000).toISOString();
  await dbSet('orders', orderId, {
    status: 'cooking',
    acceptedAt: new Date().toISOString(),
    estimatedAt,
    deliveryMinutes: totalMins,
    clientNotification: { type: 'accepted', seen: false, message: 'Ваш заказ принят и готовится!' }
  });
  closeOrderSheet();
  tgHaptic('success');
  showToast('Заказ принят ✅', 'success');
}

async function opCancelOrder(orderId) {
  if (!confirm('Отменить этот заказ?')) return;
  await dbSet('orders', orderId, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    clientNotification: { type: 'cancelled', seen: false, message: 'Ваш заказ был отменён. Обратитесь в поддержку.' }
  });
  closeOrderSheet();
  tgHaptic('light');
  showToast('Заказ отменён', 'info');
}

async function opSearchCourier(orderId) {
  await dbSet('orders', orderId, { status: 'searching_courier', updatedAt: new Date().toISOString() });
  closeOrderSheet();
  tgHaptic('light');
  showToast('Ищем курьера...', 'info');
}

async function opOpenAssignCourier(orderId) {
  _assignOrderId = orderId;
  const listEl = document.getElementById('courier-select-list');
  listEl.innerHTML = '<div class="loader"><div class="spinner"></div></div>';

  document.getElementById('order-overlay').classList.remove('open');
  document.getElementById('courier-overlay').classList.add('open');

  const allCouriers  = await dbQuery('couriers', 'onShift', '==', true);
  const onShift      = allCouriers.filter(c => c.status === 'active');
  const permUids     = VENUE?.permanentCourierIds || [];

  if (!onShift.length) {
    listEl.innerHTML = `<div class="empty" style="padding:24px"><div class="empty-icon">🚴</div><div class="empty-text">Нет курьеров на смене</div></div>`;
    return;
  }

  const sorted = [...onShift].sort((a, b) => {
    const aP = permUids.includes(a.uid) ? 0 : 1;
    const bP = permUids.includes(b.uid) ? 0 : 1;
    return aP - bP;
  });

  listEl.innerHTML = sorted.map(c => `
    <div class="list-item" onclick="opAssignCourier('${c.uid}','${c.name || 'Курьер'}')">
      <div class="li-icon yellow">🚴</div>
      <div class="li-body">
        <div class="li-title">${c.name || '—'}${permUids.includes(c.uid) ? ' <span class="pill" style="font-size:10px">Постоянный</span>' : ''}</div>
        <div class="li-sub">${c.phone || ''}</div>
      </div>
      <div class="chevron">›</div>
    </div>`).join('');
}

async function opAssignCourier(courierUid, courierName) {
  if (!_assignOrderId) return;
  await dbSet('orders', _assignOrderId, {
    status: 'delivering',
    courierUid,
    courierName,
    assignedAt: new Date().toISOString(),
    clientNotification: { type: 'delivering', seen: false, message: `Курьер ${courierName} везёт ваш заказ!` }
  });
  closeCourierSheet();
  tgHaptic('success');
  showToast(`Назначен курьер: ${courierName}`, 'success');
}

// ══════════════════════════════════════════════════════════
//  HISTORY
// ══════════════════════════════════════════════════════════
async function loadOpHistory() {
  const dateInput = document.getElementById('hist-date');
  const list      = document.getElementById('op-history-list');
  list.innerHTML  = '<div class="loader"><div class="spinner"></div></div>';

  let orders = (await dbQuery('orders', 'venueId', '==', VENUE.id))
    .filter(o => ['delivered', 'cancelled'].includes(o.status));

  if (dateInput.value) {
    orders = orders.filter(o => (o.createdAt || '').startsWith(dateInput.value));
  }
  orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (!orders.length) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Нет заказов за этот период</div></div>`;
    return;
  }
  list.innerHTML = orders.map(o => renderOpOrderCard(o)).join('');
}

// ══════════════════════════════════════════════════════════
//  SHEET CLOSE
// ══════════════════════════════════════════════════════════
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
