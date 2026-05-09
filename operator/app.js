'use strict';
/* ============================================================
   VEZOO OPERATOR — Order Management Panel
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUE          = null;
let MENU_ITEMS_OP  = [];
let _invite        = null;
let _ordersUnsub   = null;
let _soundTimer    = null;
let _assignOrderId = null;
let _allOrders     = [];
let _opHandoffCourier = null;
let _opHandoffSelected = new Set();
let _opMoCart = {};

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') { localStorage.clear(); location.replace(location.pathname); return; }
  tgReady();
  _initOpBackButton();
  const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try {
    const s = JSON.parse(localStorage.getItem('vez_op_state') || '{}');
    if (!tgUserId || s.tgId === tgUserId) { STATE.uid = s.uid||null; STATE.user = s.user||null; }
  } catch {}
  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }
  await initFirebase();
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }
  const existing = await dbGet('users', STATE.uid);
  if (!existing) { showScreen('s-no-uid'); return; }
  if (existing.blocked) { showScreen('s-blocked'); return; }
  if (!existing.agreedOperator) { STATE.user = existing; saveState(); showAgreement(); return; }
  if (!existing.name) {
    const autoName = _getTgName() || 'Оператор';
    await dbSet('users', STATE.uid, { name: autoName }); existing.name = autoName;
  }
  STATE.user = existing; saveState();
  await checkVenueAssignment();
});

function _getTgName() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return null;
  return (u.first_name + (u.last_name ? ' ' + u.last_name : '')).trim() || null;
}

function saveState() {
  const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem('vez_op_state', JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId: tgUserId })); } catch {}
}

// ══════════════════════════════════════════════════════════
//  AGREEMENT
// ══════════════════════════════════════════════════════════
function showAgreement() {
  document.getElementById('s-splash').style.display = 'none';
  document.getElementById('s-agree').style.display  = 'flex';
}

async function submitAgree() {
  const btn = document.getElementById('agree-btn'); if (btn) btn.disabled = true;
  const linkData = await dbGet('user_links', STATE.uid);
  const autoName = _getTgName() || linkData?.firstName || 'Оператор';
  STATE.user = { ...(STATE.user||{}), name: autoName, phone: linkData?.phone||'', role: 'operator', agreedOperator: true, createdAt: new Date().toISOString() };
  await dbSet('users', STATE.uid, STATE.user); saveState();
  if (btn) btn.disabled = false;
  document.getElementById('s-agree').style.display = 'none';
  await checkVenueAssignment();
}

async function onboardSubmit() { await checkVenueAssignment(); }

// ══════════════════════════════════════════════════════════
//  VENUE ASSIGNMENT
// ══════════════════════════════════════════════════════════
async function checkVenueAssignment() {
  const fresh = await dbGet('users', STATE.uid);
  if (fresh?.operatorVenueId) {
    VENUE = await dbGet('venues', fresh.operatorVenueId);
    if (VENUE) { STATE.user = fresh; saveState(); initMain(); return; }
  }
  const invite = await dbGet('operator_invites', STATE.uid);
  if (invite && invite.status === 'pending') {
    _invite = invite;
    document.getElementById('invite-venue-name').textContent = invite.venueName||'Заведение';
    document.getElementById('invite-venue-addr').textContent = invite.venueAddress||'';
    showScreen('s-confirm-venue'); return;
  }
  _renderWaitingQr();
  showScreen('s-no-venue');
}

function _renderWaitingQr() {
  const phone = STATE.user?.phone || '';
  const qrImg = document.getElementById('op-waiting-qr');
  const qrPhn = document.getElementById('op-waiting-phone');
  if (qrImg && phone) {
    qrImg.src = getQrUrl(phone, 160);
    qrImg.onerror = () => { qrImg.style.display = 'none'; };
  }
  if (qrPhn) qrPhn.textContent = phone || '—';
}

async function acceptVenueInvite() {
  if (!_invite) return;
  const venueId = _invite.venueId;
  await dbSet('users', STATE.uid, { operatorVenueId: venueId, role: 'operator' });
  await dbSet('operator_invites', STATE.uid, { status: 'accepted' });
  STATE.user = { ...STATE.user, operatorVenueId: venueId, role: 'operator' }; saveState();
  VENUE = await dbGet('venues', venueId);
  tgHaptic('success'); showToast('Вы приняты в заведение!', 'success');
  initMain();
}

async function declineVenueInvite() {
  if (!_invite) return;
  await dbDelete('operator_invites', STATE.uid); _invite = null;
  showScreen('s-no-venue');
}

async function opLeaveVenue() {
  if (!confirm('Отвязаться от заведения?')) return;
  await dbSet('users', STATE.uid, { operatorVenueId: null });
  await dbDelete('operator_invites', STATE.uid);
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }
  if (_soundTimer) { clearInterval(_soundTimer); _soundTimer = null; }
  STATE.user = { ...STATE.user, operatorVenueId: null }; saveState();
  VENUE = null;
  document.getElementById('main-nav').style.display = 'none';
  showScreen('s-no-venue');
  showToast('Отвязались от заведения', 'info');
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  document.getElementById('op-venue-name-hdr').textContent = VENUE?.name||'Заведение';
  startHeartbeat(STATE.uid);
  watchOrders();
  showScreen('s-new-orders');
  setNav(document.getElementById('nav-new'));
}

function watchOrders() {
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }
  _ordersUnsub = onQuerySnap('orders', 'venueId', '==', VENUE.id, orders => {
    _allOrders = orders;
    const newOrders    = orders.filter(o=>o.status==='pending').sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    const activeOrders = orders.filter(o=>['accepted','cooking','searching_courier','courier_assigned','ready_for_courier','delivering','ready'].includes(o.status)).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    const badge = document.getElementById('new-badge');
    badge.textContent = newOrders.length; badge.classList.toggle('hidden', newOrders.length===0);
    document.getElementById('new-orders-alert').classList.toggle('hidden', newOrders.length===0);
    if (newOrders.length>0) { if (!_soundTimer) { playNewOrder(); _soundTimer=setInterval(playNewOrder,4000); } }
    else { if (_soundTimer) { clearInterval(_soundTimer); _soundTimer=null; } }
    if (document.getElementById('s-new-orders').classList.contains('active')) renderNewOrders(newOrders);
    if (document.getElementById('s-active-orders').classList.contains('active')) renderActiveOrders(activeOrders);

    orders.filter(o=>(o.status==='delivered'||o.status==='issued')&&!o.opNotified).forEach(async o=>{
      document.getElementById('notif-delivered-op-text').textContent = o.status==='issued'
        ? `Заказ #${(o.id||'').slice(-6)} выдан клиенту.`
        : `Заказ #${(o.id||'').slice(-6)} успешно доставлен клиенту.`;
      document.getElementById('notif-delivered-op').classList.add('open');
      await dbSet('orders',o.id,{opNotified:true});
    });
  });
}

function navToNewOrders() {
  showScreen('s-new-orders'); setNav(document.getElementById('nav-new'));
  renderNewOrders(_allOrders.filter(o=>o.status==='pending').sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')));
}

function navToActiveOrders() {
  showScreen('s-active-orders'); setNav(document.getElementById('nav-active'));
  renderActiveOrders(_allOrders.filter(o=>['accepted','cooking','searching_courier','courier_assigned','ready_for_courier','delivering','ready'].includes(o.status)).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')));
}

// ══════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════
function renderNewOrders(orders) {
  const list = document.getElementById('new-orders-list');
  if (!orders.length) { list.innerHTML=`<div class="empty"><div class="empty-icon">🔔</div><div class="empty-text">Новых заказов нет.<br>Они появятся здесь автоматически.</div></div>`; return; }
  list.innerHTML = orders.map(o=>renderOpOrderCard(o)).join('');
}

function renderActiveOrders(orders) {
  const list = document.getElementById('active-orders-list');
  if (!orders.length) { list.innerHTML=`<div class="empty"><div class="empty-icon">⚡</div><div class="empty-text">Нет активных заказов</div></div>`; return; }
  list.innerHTML = orders.map(o=>renderOpOrderCard(o)).join('');
}

function renderOpOrderCard(o) {
  const addr = o.address;
  const addrStr = typeof addr==='string' ? addr : (addr ? (`${addr.street||''} ${addr.house||''}${addr.apt?', кв.'+addr.apt:''}`).trim() : null);
  const accentColors = {pending:'var(--warning)',accepted:'var(--info)',cooking:'var(--info)',searching_courier:'var(--primary)',courier_assigned:'var(--primary)',delivering:'var(--success)',delivered:'var(--success)',cancelled:'var(--danger)'};
  return `
    <div class="order-card" onclick="openOrderDetail('${o.id}')" style="cursor:pointer;border-left:3px solid ${accentColors[o.status]||'var(--border)'}">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:14px">${o.clientName||'Клиент'}${o.isManual?' <span class="badge badge-accepted" style="font-size:10px">📞</span>':''}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id||'').slice(-6)}</div></div>
        <div style="text-align:right"><span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span><div style="font-weight:700;font-size:16px;color:var(--primary);margin-top:4px">${fmtPrice((o.total||0)+(o.deliveryPrice||0))}</div></div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items||[]).map(i=>`${i.emoji||'🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
        ${addrStr?`<div class="text-sm text-dim mt-1">📍 ${addrStr}</div>`:'<div class="text-sm text-dim mt-1">🏪 Самовывоз</div>'}
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  ORDER DETAIL
// ══════════════════════════════════════════════════════════
async function openOrderDetail(orderId) {
  const order = _allOrders.find(o=>o.id===orderId) || (await dbQuery('orders','venueId','==',VENUE.id)).find(o=>o.id===orderId);
  if (!order) return;
  const addr = order.address;
  const addrStr = typeof addr==='string' ? addr : (addr ? (`${addr.street||''} ${addr.house||''}${addr.apt?', кв.'+addr.apt:''}${addr.hasIntercom?` · 🔔 ${addr.intercomCode||'есть'}`:''}`).trim() : null);
  const callBtn = order.clientPhone ? `<button class="btn-call" onclick="callPhone('${normPhone(order.clientPhone)}')">📞 Позвонить клиенту</button>` : '';
  const callCourierBtn = order.courierPhone ? `<button class="btn-call" onclick="callPhone('${normPhone(order.courierPhone)}')">📞 Позвонить курьеру</button>` : '';
  const cancelBtn = `<button class="btn btn-danger btn-sm" onclick="opCancelOrder('${orderId}')">❌ Отменить</button>`;
  const isPickup = order.deliveryType === 'pickup';
  let actions = '';
  if (isPickup) {
    if (order.status==='pending') actions=`<div class="btn-row">${cancelBtn}<button class="btn btn-primary btn-sm" onclick="opAcceptOrder('${orderId}')">✅ Принять</button></div>`;
    else if (order.status==='accepted'||order.status==='cooking') actions=`<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box info" style="font-size:13px">🏪 Самовывоз</div><div class="btn-row">${cancelBtn}<button class="btn btn-primary btn-sm" onclick="opIssueOrder('${orderId}')">📦 Выдать клиенту</button></div></div>`;
    else if (order.status==='ready') actions=`<div class="alert-box success" style="margin-bottom:8px;font-size:13px">✅ Заказ готов к выдаче</div><button class="btn btn-primary" onclick="opIssueOrder('${orderId}')">📦 Выдан клиенту</button>`;
  } else {
    if (order.status==='pending') actions=`<div class="btn-row">${cancelBtn}<button class="btn btn-primary btn-sm" onclick="opAcceptOrder('${orderId}')">✅ Принять</button></div>`;
    else if (order.status==='accepted'||order.status==='cooking') actions=`<div style="display:flex;flex-direction:column;gap:8px"><button class="btn btn-success btn-sm" onclick="opMarkReadyForCourier('${orderId}')">✅ Заказ готов</button><div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="opSearchCourier('${orderId}')">🔍 В общий пул</button><button class="btn btn-primary btn-sm" onclick="opOpenHandoff()">📦 Передать</button></div>${cancelBtn}</div>`;
    else if (order.status==='ready_for_courier') actions=`<div class="alert-box success" style="margin-bottom:8px;font-size:13px">⚡ Заказ готов — ждём курьера кафе</div><div style="display:flex;flex-direction:column;gap:8px"><button class="btn btn-primary btn-sm" onclick="opOpenHandoff()">📦 Передать курьеру</button><button class="btn btn-secondary btn-sm" onclick="opSearchCourier('${orderId}')">🔍 Выставить в общий пул</button>${cancelBtn}</div>`;
    else if (order.status==='searching_courier') actions=`<div class="alert-box info" style="margin-bottom:8px;font-size:13px">⏳ Ждём курьера из пула…</div><div style="display:flex;flex-direction:column;gap:8px"><button class="btn btn-primary btn-sm" onclick="opOpenHandoff()">📦 Передать курьеру</button>${cancelBtn}</div>`;
    else if (order.status==='courier_assigned') actions=`<div class="alert-box info" style="margin-bottom:8px;font-size:13px">🏃 <strong>${order.courierName||'Курьер'}</strong> едет в кафе</div><div style="display:flex;flex-direction:column;gap:8px"><button class="btn btn-success btn-sm" onclick="opOpenHandoff()">📦 Передать заказ курьеру</button>${cancelBtn}</div>`;
    else if (order.status==='delivering') actions=`<div class="alert-box success" style="margin-bottom:8px">🚴 <strong>${order.courierName||'—'}</strong></div><div class="btn-row">${cancelBtn}<button class="btn btn-ghost btn-sm" onclick="opSearchCourier('${orderId}')">🔍 Найти нового</button></div>`;
  }

  document.getElementById('op-order-detail').innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:12px">
      <div><div class="font-bold" style="font-size:16px">Заказ #${(order.id||'').slice(-6)}</div><div class="order-id">${fmtDate(order.createdAt)}</div></div>
      <span class="${statusBadgeClass(order.status)}">${statusLabel(order.status)}</span>
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span class="font-bold">${order.clientName||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${order.clientPhone||'—'}</span></div>
      ${order.status==='cancelled'&&order.cancelledBy?`<div class="flex justify-between"><span class="text-dim">Отменил</span><span style="color:var(--danger)">${{client:'Клиент',operator:'Оператор',admin:'Администратор'}[order.cancelledBy]||'—'}</span></div>`:''}
      ${callBtn?`<div>${callBtn}</div>`:''}
      ${callCourierBtn?`<div>${callCourierBtn}</div>`:''}
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
      ${addrStr?`<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addrStr}</span></div>`:'<div class="flex justify-between"><span class="text-dim">Получение</span><span>🏪 Самовывоз</span></div>'}
      ${order.comment?`<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%;font-size:12px">${order.comment}</span></div>`:''}
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав</div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      ${(order.items||[]).map(it=>`<div class="flex justify-between"><span>${it.emoji||'🍽️'} ${it.name}${it.variantName?' ('+it.variantName+')':''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
      <div class="divider"></div>
      ${order.deliveryPrice?`<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(order.deliveryPrice)}</span></div>`:''}
      <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice((order.total||0)+(order.deliveryPrice||0))}</span></div>
    </div>
    ${renderOrderTimeline(order)}
    <div style="display:flex;flex-direction:column;gap:8px">${actions}</div>`;
  _openSheet('order-overlay');
}

async function opAcceptOrder(orderId) {
  const totalMins = (VENUE?.cookingTime||30) + (VENUE?.deliveryTime||30);
  await dbSet('orders', orderId, { status:'cooking', acceptedAt:new Date().toISOString(), estimatedAt:new Date(Date.now()+totalMins*60000).toISOString(), deliveryMinutes:totalMins, clientNotification:{type:'accepted',seen:false,message:'Ваш заказ принят и готовится!'} });
  closeOrderSheet(); tgHaptic('success'); showToast('Заказ принят ✅','success');
}

async function opCancelOrder(orderId) {
  const doCancel=async()=>{ await dbSet('orders',orderId,{status:'cancelled',cancelledAt:new Date().toISOString(),cancelledBy:'operator',clientNotification:{type:'cancelled',seen:false,message:'Ваш заказ отменён оператором.'}}); closeOrderSheet(); tgHaptic('light'); showToast('Заказ отменён','info'); };
  if (tg?.showConfirm) tg.showConfirm('Отменить заказ?',ok=>{if(ok)doCancel();});
  else if (confirm('Отменить заказ?')) await doCancel();
}

async function opSearchCourier(orderId) {
  await dbSet('orders',orderId,{status:'searching_courier',courierUid:null,courierName:null,updatedAt:new Date().toISOString()});
  closeOrderSheet(); tgHaptic('light'); showToast('Заявка размещена — ждём курьера','info');
}

async function opHandOverCourier(orderId) {
  const order=_allOrders.find(o=>o.id===orderId);
  const courierName=order?.courierName||'Курьер';
  await dbSet('orders',orderId,{status:'delivering',handedOverAt:new Date().toISOString(),clientNotification:{type:'delivering',seen:false,message:`Курьер ${courierName} везёт ваш заказ!`}});
  closeOrderSheet(); tgHaptic('success'); showToast(`Заказ передан курьеру ${courierName}`,'success');
}

async function opMarkReady(orderId) {
  await dbSet('orders', orderId, { status:'ready', readyAt:new Date().toISOString(), clientNotification:{type:'ready',seen:false,message:'Ваш заказ готов! Приходите забирать.'} });
  closeOrderSheet(); tgHaptic('success'); showToast('Заказ готов ✅','success');
}

async function opMarkReadyForCourier(orderId) {
  await dbSet('orders', orderId, { status:'ready_for_courier', readyForCourierAt:new Date().toISOString() });
  closeOrderSheet(); tgHaptic('success'); showToast('Заказ помечен готовым — курьеры кафе видят его','success');
}

async function opIssueOrder(orderId) {
  await dbSet('orders', orderId, { status:'issued', issuedAt:new Date().toISOString(), opNotified:false, clientNotification:{type:'issued',seen:false,message:'Заказ выдан. Приятного аппетита!'} });
  closeOrderSheet(); tgHaptic('success'); showToast('Заказ выдан клиенту 📦','success');
}

async function opOpenAssignCourier(orderId) {
  _assignOrderId=orderId;
  const listEl=document.getElementById('courier-select-list');
  if (listEl) listEl.innerHTML='<div class="loader"><div class="spinner"></div></div>';
  document.getElementById('order-overlay').classList.remove('open');
  _openSheet('courier-overlay');
  const permLinks=await dbQuery('courier_venue_links','venueId','==',VENUE.id);
  const permUids=permLinks.filter(l=>l.status==='confirmed').map(l=>l.uid);
  const allCouriers=await dbQuery('couriers','onShift','==',true);
  const available=allCouriers.filter(c=>c.status==='active'&&permUids.includes(c.uid));
  if (listEl) {
    if (!available.length) { listEl.innerHTML=`<div class="empty" style="padding:24px"><div class="empty-icon">🚴</div><div class="empty-text">Нет постоянных курьеров на смене.</div></div>`; return; }
    listEl.innerHTML=available.map(c=>`<div class="list-item" onclick="opAssignCourier('${c.uid}','${(c.name||'Курьер').replace(/'/g,'')}')"><div class="li-icon yellow">🚴</div><div class="li-body"><div class="li-title">${c.name||'—'}</div><div class="li-sub">${c.phone||''}</div></div><div class="chevron">›</div></div>`).join('');
  }
}

async function opAssignCourier(courierUid,courierName) {
  if (!_assignOrderId) return;
  await dbSet('orders',_assignOrderId,{status:'delivering',courierUid,courierName,assignedAt:new Date().toISOString(),clientNotification:{type:'delivering',seen:false,message:`Курьер ${courierName} везёт ваш заказ!`}});
  closeCourierSheet(); tgHaptic('success'); showToast(`Назначен курьер: ${courierName}`,'success');
}

// ══════════════════════════════════════════════════════════
//  HANDOFF FLOW (QR or manual)
// ══════════════════════════════════════════════════════════
function opOpenHandoff() {
  _opHandoffCourier=null; _opHandoffSelected.clear();
  document.getElementById('op-handoff-manual-wrap').style.display='none';
  document.getElementById('op-handoff-found').style.display='none';
  document.getElementById('op-handoff-orders-section').style.display='none';
  document.getElementById('op-handoff-phone').value='';
  document.getElementById('op-handoff-warn').style.display='none';
  closeOrderSheet();
  _openSheet('courier-overlay');
}

function opHandoffManual() { document.getElementById('op-handoff-manual-wrap').style.display=''; }

function opHandoffScanQr() {
  if (!tg?.showScanQrPopup) { showToast('QR-сканер доступен только в Telegram','warning'); return; }
  tg.showScanQrPopup({text:'Наведите камеру на QR-код курьера'},async data=>{
    tg.closeScanQrPopup();
    const phone=normPhone(data||'');
    if (phone) { document.getElementById('op-handoff-phone').value=phone; document.getElementById('op-handoff-manual-wrap').style.display=''; await opFindHandoffCourier(); }
  });
}

async function opFindHandoffCourier() {
  const phone=normPhone(document.getElementById('op-handoff-phone').value.trim());
  if (!phone) { showToast('Введите номер телефона','warning'); return; }
  const links=await dbGetAll('user_links');
  const link=links.find(l=>normPhone(l.phone||'')===phone);
  if (!link) { showToast('Курьер не найден','error'); return; }
  const courier=await dbGet('couriers',link.uid);
  if (!courier) { showToast('Этот пользователь не является курьером','error'); return; }
  _opHandoffCourier=courier;
  const foundEl=document.getElementById('op-handoff-found');
  foundEl.style.display='';
  foundEl.innerHTML=`<div class="handoff-courier-found"><div class="handoff-courier-avatar">🚴</div><div><div style="font-weight:700;font-size:15px">${courier.name||'Курьер'}</div><div style="font-size:13px;color:var(--text-dim)">${courier.phone||phone}</div><div style="font-size:12px;color:${courier.onShift?'var(--success)':'var(--text-muted)'}">${courier.onShift?'На смене':'Офлайн'}</div></div></div>`;
  const orders=_allOrders.filter(o=>['accepted','cooking','searching_courier','courier_assigned','ready_for_courier'].includes(o.status) && o.deliveryType!=='pickup');
  if (!orders.length) { showToast('Нет активных заказов для передачи','info'); return; }
  document.getElementById('op-handoff-orders-section').style.display='';
  document.getElementById('op-handoff-orders-list').innerHTML=orders.map(o=>`
    <div class="handoff-order-row" id="oho_${o.id}" onclick="opToggleHandoffOrder('${o.id}','${o.courierUid||''}')">
      <div style="flex:1"><div style="font-weight:600;font-size:14px">#${(o.id||'').slice(-6)} — ${o.clientName||'Клиент'}</div><div style="font-size:12px;color:var(--text-dim)">${statusLabel(o.status)} · ${fmtPrice((o.total||0)+(o.deliveryPrice||0))}</div></div>
      <div id="oho_chk_${o.id}" style="font-size:20px;color:var(--text-muted)">○</div>
    </div>`).join('');
}

function opToggleHandoffOrder(orderId,existingCourierUid) {
  if (_opHandoffSelected.has(orderId)) {
    _opHandoffSelected.delete(orderId);
    document.getElementById('oho_'+orderId).classList.remove('selected');
    document.getElementById('oho_chk_'+orderId).textContent='○'; document.getElementById('oho_chk_'+orderId).style.color='var(--text-muted)';
  } else {
    _opHandoffSelected.add(orderId);
    document.getElementById('oho_'+orderId).classList.add('selected');
    document.getElementById('oho_chk_'+orderId).textContent='●'; document.getElementById('oho_chk_'+orderId).style.color='var(--primary)';
    if (existingCourierUid && existingCourierUid!==_opHandoffCourier?.uid) {
      const w=document.getElementById('op-handoff-warn'); w.style.display=''; w.textContent='⚠️ Один из заказов уже назначен другому курьеру.';
    }
  }
}

async function opConfirmHandoff() {
  if (!_opHandoffCourier||!_opHandoffSelected.size) { showToast('Выберите заказы','warning'); return; }
  const cName=_opHandoffCourier.name||'Курьер';
  for (const orderId of _opHandoffSelected) {
    await dbSet('orders',orderId,{status:'delivering',courierUid:_opHandoffCourier.uid,courierName:cName,handedOverAt:new Date().toISOString(),clientNotification:{type:'delivering',seen:false,message:`Курьер ${cName} везёт ваш заказ!`}});
  }
  closeCourierSheet(); tgHaptic('success'); showToast(`Передано курьеру ${cName}: ${_opHandoffSelected.size} заказов`,'success');
}

// ══════════════════════════════════════════════════════════
//  MANUAL ORDER
// ══════════════════════════════════════════════════════════
async function openOpManualOrder() {
  _opMoCart={};
  document.getElementById('op-mo-phone').value='';
  document.getElementById('op-mo-name').value='';
  document.getElementById('op-mo-address').value='';
  document.getElementById('op-mo-autocomplete').style.display='none';
  document.getElementById('op-mo-cart').innerHTML='';
  document.getElementById('op-mo-total').textContent=fmtPrice(0);
  if (!MENU_ITEMS_OP.length) MENU_ITEMS_OP=await dbQuery('menu_items','venueId','==',VENUE.id);
  const cats=[...new Set(MENU_ITEMS_OP.map(i=>i.category).filter(Boolean))];
  document.getElementById('op-mo-cats').innerHTML=['Все',...cats].map((c,i)=>`<button class="cat-tab${i===0?' active':''}" onclick="opMoFilter(this,'${c}')">${c}</button>`).join('');
  opMoFilter(null,'Все');
  _openSheet('op-manual-overlay');
}

function opMoFilter(el,cat) {
  if(el){document.querySelectorAll('#op-mo-cats .cat-tab').forEach(b=>b.classList.remove('active'));el.classList.add('active');}
  const items=cat==='Все'?MENU_ITEMS_OP:MENU_ITEMS_OP.filter(i=>i.category===cat);
  document.getElementById('op-mo-items').innerHTML=items.filter(i=>i.available!==false).map(item=>`
    <div class="flex items-center gap-2" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1"><div style="font-weight:600;font-size:13px">${item.emoji||'🍽️'} ${item.name}</div><div style="font-size:12px;color:var(--primary)">${fmtPrice(item.price)}</div></div>
      <button class="btn btn-primary btn-xs" onclick="opMoAdd('${item.id}')">+</button>
    </div>`).join('');
}

function opMoAdd(itemId) {
  const item=MENU_ITEMS_OP.find(i=>i.id===itemId); if (!item) return;
  const price=item.variants?.length?item.variants[0].price:item.price;
  if (_opMoCart[itemId]) _opMoCart[itemId].qty++;
  else _opMoCart[itemId]={...item,qty:1,unitPrice:price};
  opMoRenderCart(); tgHaptic('light');
}

function opMoRemove(itemId) {
  if (!_opMoCart[itemId]) return;
  _opMoCart[itemId].qty--;
  if (_opMoCart[itemId].qty<=0) delete _opMoCart[itemId];
  opMoRenderCart();
}

function opMoRenderCart() {
  const items=Object.values(_opMoCart);
  const total=items.reduce((s,i)=>s+i.unitPrice*i.qty,0);
  document.getElementById('op-mo-total').textContent=fmtPrice(total);
  document.getElementById('op-mo-cart').innerHTML=items.map(it=>`<div class="manual-order-item"><span class="manual-order-name">${it.emoji||'🍽️'} ${it.name} ×${it.qty}</span><span class="manual-order-price">${fmtPrice(it.unitPrice*it.qty)}</span><button class="btn btn-icon" style="width:28px;height:28px;font-size:14px;background:var(--danger-soft);color:var(--danger);border:none;border-radius:8px;cursor:pointer" onclick="opMoRemove('${it.id}')">−</button></div>`).join('')||'<div class="text-dim text-sm">Ничего не добавлено</div>';
}

async function opMoPhoneInput(input) {
  const val=input.value.trim();
  if (val.length<7) { document.getElementById('op-mo-autocomplete').style.display='none'; return; }
  const norm=normPhone(val);
  const links=await dbGetAll('user_links');
  const matches=links.filter(l=>normPhone(l.phone||'').includes(norm.replace('+',''))).slice(0,5);
  const dd=document.getElementById('op-mo-autocomplete');
  if (!matches.length) { dd.style.display='none'; return; }
  dd.style.display=''; dd.innerHTML=matches.map(l=>`<div class="autocomplete-item" onclick="opMoSelectClient('${(l.phone||'').replace(/'/g,'')}','${(l.firstName||'').replace(/'/g,'')}')"><span style="font-family:monospace">${l.phone}</span> <span style="color:var(--text-dim)">${l.firstName||''}</span></div>`).join('');
}

function opMoSelectClient(phone,name) {
  document.getElementById('op-mo-phone').value=phone;
  document.getElementById('op-mo-name').value=name||'';
  document.getElementById('op-mo-autocomplete').style.display='none';
}

async function submitOpManualOrder() {
  const phone=normPhone(document.getElementById('op-mo-phone').value.trim());
  const clientName=document.getElementById('op-mo-name').value.trim()||'Клиент (телефон)';
  const address=document.getElementById('op-mo-address').value.trim();
  const payment=document.getElementById('op-mo-payment').value;
  if (!phone) { showToast('Введите телефон клиента','warning'); return; }
  if (!address) { showToast('Введите адрес','warning'); return; }
  const items=Object.values(_opMoCart);
  if (!items.length) { showToast('Добавьте позиции','warning'); return; }
  const total=items.reduce((s,i)=>s+i.unitPrice*i.qty,0);
  const ordId=genOrderId();
  await dbSet('orders',ordId,{ id:ordId, venueId:VENUE.id, venueName:VENUE.name, clientPhone:phone, clientName, clientUid:'manual_'+genId(), address:{street:address}, payment, total, items:items.map(i=>({id:i.id,name:i.name,emoji:i.emoji||'🍽️',qty:i.qty,price:i.unitPrice})), status:'accepted', isManual:true, createdAt:new Date().toISOString(), acceptedAt:new Date().toISOString(), clientNotification:{type:'accepted',seen:false} });
  closeOpManualOrder(); tgHaptic('success'); showToast('Заказ создан','success');
}

function closeOpManualOrder(e) {
  if (e && e.target!==document.getElementById('op-manual-overlay')) return;
  document.getElementById('op-manual-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  HISTORY
// ══════════════════════════════════════════════════════════
async function loadOpHistory() {
  const dateInput=document.getElementById('hist-date');
  const list=document.getElementById('op-history-list');
  list.innerHTML='<div class="loader"><div class="spinner"></div></div>';
  let orders=(await dbQuery('orders','venueId','==',VENUE.id)).filter(o=>['delivered','cancelled','issued'].includes(o.status));
  if (dateInput.value) orders=orders.filter(o=>(o.createdAt||'').startsWith(dateInput.value));
  orders.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  if (!orders.length) { list.innerHTML=`<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Нет заказов за этот период</div></div>`; return; }
  list.innerHTML=orders.map(o=>renderOpOrderCard(o)).join('');
}

// ══════════════════════════════════════════════════════════
//  SETTINGS / QR / STATS
// ══════════════════════════════════════════════════════════
async function loadOpSettings() {
  const user=STATE.user||{};
  const phone=user.phone||'';
  document.getElementById('op-qr-phone').textContent=phone||'—';
  const qrImg=document.getElementById('op-qr-img');
  if (phone) qrImg.src=getQrUrl(phone,180);

  // Venue info
  const vi=document.getElementById('op-venue-info');
  vi.innerHTML=VENUE?`
    <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${VENUE.name||'—'}</span></div>
    <div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${VENUE.address||'—'}</span></div>
    <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${VENUE.phone||'—'}</span></div>
  `:'<div class="text-dim text-sm">Нет данных</div>';

  // 7-day stats
  const cutoff=new Date(Date.now()-7*86400000).toISOString();
  const orders=(await dbQuery('orders','venueId','==',VENUE.id)).filter(o=>(o.createdAt||'')>=cutoff);
  const done=orders.filter(o=>o.status==='delivered');
  const revenue=done.reduce((s,o)=>s+(o.total||0),0);
  document.getElementById('op-stats-grid').innerHTML=`
    <div class="stat-card"><div class="stat-val">${orders.length}</div><div class="stat-lbl">Заказов (7д)</div></div>
    <div class="stat-card"><div class="stat-val text-success">${done.length}</div><div class="stat-lbl">Доставлено</div></div>
    <div class="stat-card"><div class="stat-val text-danger">${orders.filter(o=>o.status==='cancelled').length}</div><div class="stat-lbl">Отменено</div></div>
    <div class="stat-card"><div class="stat-val text-primary">${fmtPrice(revenue)}</div><div class="stat-lbl">Выручка</div></div>`;
}

// ══════════════════════════════════════════════════════════
//  NAV + SHEETS
// ══════════════════════════════════════════════════════════
function closeOrderSheet(e) {
  if (e && e.target!==document.getElementById('order-overlay')) return;
  document.getElementById('order-overlay').classList.remove('open');
}
function closeCourierSheet(e) {
  if (e && e.target!==document.getElementById('courier-overlay')) return;
  document.getElementById('courier-overlay').classList.remove('open');
}
function setNav(el) { document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active')); if (el) el.classList.add('active'); }
function _initOpBackButton() {
  if (!tg?.BackButton) return;
  tg.BackButton.onClick(()=>{ const open=document.querySelector('.overlay.open'); if (open) { open.classList.remove('open'); if (!document.querySelector('.overlay.open')) tg.BackButton.hide(); return; } tg.BackButton.hide(); });
}
function _openSheet(id) { document.getElementById(id)?.classList.add('open'); tg?.BackButton?.show(); }
