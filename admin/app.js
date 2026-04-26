'use strict';
/* ============================================================
   VEZOO ADMIN — Venue Admin Mini App
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUE        = null;
let MENU_ITEMS   = [];
let MENU_CATS    = [];
let ALL_CATS     = [];   // global venue categories
let _editItemId  = null;
let _variants    = [];
let _hasVariants = false;
let _ordersUnsub = null;
let _agreedCheck = false;
let _coverDataUrl = null;
let _itemImgDataUrl = null;
let _invitePending = null; // pending operator invite data

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') { localStorage.clear(); location.replace(location.pathname); return; }
  tgReady();
  _initAdminBackButton();
  const _tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try {
    const s = JSON.parse(localStorage.getItem('vez_admin_state') || '{}');
    if (!_tgUserId || s.tgId === _tgUserId) {
      STATE.uid = s.uid || null; STATE.user = s.user || null;
    }
  } catch {}
  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }
  await initFirebase();
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing?.blocked) { showScreen('s-blocked'); return; }
  if (!existing?.agreedAdmin) { showScreen('s-agree'); return; }
  // Auto-set name from Telegram if missing (no onboard screen)
  if (existing && !existing.name) {
    const autoName = _getTgName() || existing.firstName || 'Администратор';
    await dbSet('users', STATE.uid, { name: autoName });
    existing.name = autoName;
  }
  STATE.user = existing; saveState();
  await checkVenueAndInit();
});

function _getTgName() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return null;
  return (u.first_name + (u.last_name ? ' ' + u.last_name : '')).trim() || null;
}

function saveState() {
  const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem('vez_admin_state', JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId: tgUserId })); } catch {}
}

// ── Agreement ──
function toggleAgreeCheck() {
  // Читаем реальное состояние чекбокса, чтобы избежать двойного срабатывания
  const cb = document.getElementById('agree-cb');
  // Если вызов идёт от label — браузер уже переключил чекбокс, читаем его состояние
  // Если чекбокса нет — используем старый toggle
  if (cb) {
    _agreedCheck = cb.checked;
  } else {
    _agreedCheck = !_agreedCheck;
  }
  document.getElementById('agree-box').textContent = _agreedCheck ? '✓' : '';
  document.getElementById('agree-check-row').classList.toggle('checked', _agreedCheck);
  document.getElementById('agree-btn').disabled = !_agreedCheck;
}
async function submitAgree() {
  const btn = document.getElementById('agree-btn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  const linkData = await dbGet('user_links', STATE.uid);
  const autoName = _getTgName() || linkData?.firstName || 'Администратор';
  STATE.user = {
    name: autoName,
    phone: linkData?.phone || '',
    tgId: linkData?.tgId || '',
    role: 'admin',
    agreedAdmin: true,
    createdAt: new Date().toISOString()
  };
  await dbSet('users', STATE.uid, STATE.user);
  saveState();
  if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  await checkVenueAndInit();
}

// ── Onboarding (не используется — имя берётся из Telegram) ──
async function onboardSubmit() {
  await checkVenueAndInit();
}

// ── Check venue status ──
async function checkVenueAndInit() {
  ALL_CATS = await dbGetAll('categories', 'order', 'asc');
  const venues = await dbQuery('venues', 'ownerId', '==', STATE.uid);
  VENUE = venues[0] || null;
  if (!VENUE) { showCreateVenueForm(); return; }
  if (VENUE.status === 'pending') { showScreen('s-pending'); return; }
  if (VENUE.status === 'rejected') { showScreen('s-rejected'); return; }
  initMain();
}

async function checkVenueStatus() {
  await checkVenueAndInit();
}

function showCreateVenueForm() {
  const sel = document.getElementById('cv-cat');
  sel.innerHTML = '<option value="">Выберите категорию...</option>' +
    ALL_CATS.map(c => `<option value="${c.id}">${c.icon||''} ${c.name}</option>`).join('');
  showScreen('s-create-venue');
}

function previewCover(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    _coverDataUrl = e.target.result;
    const wrap = document.getElementById('cv-cover-upload');
    wrap.innerHTML = `<img src="${_coverDataUrl}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"><input type="file" id="cv-cover-file" accept="image/*" onchange="previewCover(this)" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  };
  reader.readAsDataURL(file);
}

async function submitCreateVenue() {
  const name    = document.getElementById('cv-name').value.trim();
  const catId   = document.getElementById('cv-cat').value;
  const desc    = document.getElementById('cv-desc').value.trim();
  const address = document.getElementById('cv-address').value.trim();
  const open    = document.getElementById('cv-work-open').value;
  const close   = document.getElementById('cv-work-close').value;
  const delTime = parseInt(document.getElementById('cv-delivery-time').value) || 30;
  const delPr   = parseInt(document.getElementById('cv-delivery-price').value) || 0;
  const cookT   = parseInt(document.getElementById('cv-cooking-time').value) || 20;
  const minOrd  = parseInt(document.getElementById('cv-min-order').value) || 0;
  const coverUrl = document.getElementById('cv-cover-url').value.trim() || _coverDataUrl || '';
  const phone    = document.getElementById('cv-phone').value.trim();

  if (!name || !catId || !address) { showToast('Заполните обязательные поля', 'warning'); return; }

  const btn = document.getElementById('cv-btn');
  btn.disabled = true; btn.textContent = 'Отправляем...';

  const venueId = genId();
  const venue = {
    id: venueId, name, categoryId: catId, description: desc, address, phone,
    workOpen: open, workClose: close, deliveryTime: delTime, deliveryPrice: delPr,
    cookingTime: cookT, minOrder: minOrd, coverUrl,
    ownerId: STATE.uid, ownerName: STATE.user?.name||'',
    status: 'pending', rating: 0, reviewCount: 0, blocked: false,
    createdAt: new Date().toISOString()
  };
  await dbSet('venues', venueId, venue);
  VENUE = venue;
  tgHaptic('success');
  showScreen('s-pending');
  btn.disabled = false; btn.textContent = 'Отправить на модерацию';
}

function resetVenueAndCreate() {
  VENUE = null; showCreateVenueForm();
}

// ── Init main ──
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  startHeartbeat(STATE.uid);
  loadMenuItems();
  watchNewOrders();
  showScreen('s-menu');
  setNav(document.getElementById('nav-menu'));
}

// ══════════════════════════════════════════════════════════
//  MENU
// ══════════════════════════════════════════════════════════
async function loadMenuItems() {
  const list = document.getElementById('menu-items-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  MENU_ITEMS = await dbQuery('menu_items', 'venueId', '==', VENUE.id);
  MENU_CATS  = [...new Set(MENU_ITEMS.map(i => i.category).filter(Boolean))];
  renderMenuCatTabs();
  renderMenuItems(null);
  // Update category select in item sheet
  _refreshCatSelect();
}

function _refreshCatSelect(currentVal) {
  const sel = document.getElementById('it-cat');
  if (!sel) return;
  sel.innerHTML =
    '<option value="">— без категории —</option>' +
    MENU_CATS.map(c => `<option value="${c}"${c === currentVal ? ' selected' : ''}>${c}</option>`).join('') +
    '<option value="__new__">✏️ Новая категория...</option>';
  if (currentVal && !MENU_CATS.includes(currentVal)) {
    sel.value = '__new__';
    const custom = document.getElementById('it-cat-custom');
    if (custom) { custom.style.display = ''; custom.value = currentVal; }
  }
}

function handleCatChange(sel) {
  const custom = document.getElementById('it-cat-custom');
  if (!custom) return;
  custom.style.display = sel.value === '__new__' ? '' : 'none';
  if (sel.value !== '__new__') custom.value = '';
}

function _getCatValue() {
  const sel = document.getElementById('it-cat');
  if (sel.value === '__new__') return (document.getElementById('it-cat-custom')?.value || '').trim();
  return sel.value;
}

function renderMenuCatTabs() {
  const container = document.getElementById('menu-cats-tabs');
  const tabs = ['Все', ...MENU_CATS];
  container.innerHTML = tabs.map((c, i) =>
    `<button class="cat-tab${i===0?' active':''}" onclick="filterMenuItems(this,'${c}')">${c}</button>`
  ).join('');
}

function filterMenuItems(el, cat) {
  document.querySelectorAll('#menu-cats-tabs .cat-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderMenuItems(cat === 'Все' ? null : cat);
}

function renderMenuItems(cat) {
  const items = cat ? MENU_ITEMS.filter(i => i.category === cat) : MENU_ITEMS;
  const list  = document.getElementById('menu-items-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🍽️</div><div class="empty-text">Нет позиций в меню.<br>Нажмите «+ Добавить».</div></div>';
    return;
  }
  list.innerHTML = items.map(item => {
    const priceStr = item.variants?.length
      ? item.variants.map(v=>`${v.name}: ${fmtPrice(v.price)}`).join('<br>')
      : fmtPrice(item.price);
    const imgEl = item.imageUrl
      ? `<div class="admin-item-img"><img src="${item.imageUrl}" onerror="this.parentElement.innerHTML='<span style=font-size:26px>${item.emoji||'🍽️'}</span>'"></div>`
      : `<div class="admin-item-img"><span style="font-size:26px">${item.emoji||'🍽️'}</span></div>`;
    return `
      <div class="admin-item">
        ${imgEl}
        <div class="admin-item-body">
          <div class="admin-item-name">${item.name}${item.available===false?' <span class="badge badge-cancelled" style="font-size:10px;padding:2px 6px">Скрыт</span>':''}</div>
          <div class="admin-item-price">${priceStr}</div>
          ${item.category?`<div class="text-xs text-dim" style="margin-top:2px">${item.category}</div>`:''}
        </div>
        <div class="admin-item-actions">
          <button class="btn-icon btn-ghost" onclick="openEditItem('${item.id}')">✏️</button>
          <button class="btn-icon btn-danger" onclick="deleteItem('${item.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

// ── Item sheet ──
function openAddItem() {
  _editItemId = null; _variants = []; _hasVariants = false; _itemImgDataUrl = null;
  document.getElementById('item-sheet-title').textContent = 'Добавить позицию';
  document.getElementById('it-name').value    = '';
  document.getElementById('it-emoji').value   = '';
  document.getElementById('it-desc').value    = '';
  document.getElementById('it-img-url').value = '';
  document.getElementById('it-price').value   = '';
  _refreshCatSelect();
  const custom = document.getElementById('it-cat-custom');
  if (custom) custom.style.display = 'none';
  document.getElementById('it-available').checked = true;
  document.getElementById('it-img-upload').innerHTML = `<input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)"><span class="img-upload-txt">📷 Загрузить фото</span>`;
  document.getElementById('variants-check-box').textContent = '';
  document.getElementById('variants-check-box').parentElement.parentElement.classList.remove('checked');
  document.getElementById('simple-price-wrap').style.display = '';
  document.getElementById('variants-wrap').style.display = 'none';
  document.getElementById('variants-list').innerHTML = '';
  _openSheet('item-overlay');
}

async function openEditItem(itemId) {
  const item = MENU_ITEMS.find(i => i.id === itemId);
  if (!item) return;
  _editItemId = itemId; _variants = [...(item.variants||[])]; _hasVariants = _variants.length > 0; _itemImgDataUrl = null;
  document.getElementById('item-sheet-title').textContent = 'Редактировать позицию';
  document.getElementById('it-name').value    = item.name||'';
  _refreshCatSelect(item.category || '');
  document.getElementById('it-emoji').value   = item.emoji||'';
  document.getElementById('it-desc').value    = item.description||'';
  document.getElementById('it-img-url').value = item.imageUrl||'';
  document.getElementById('it-price').value   = item.price||'';
  document.getElementById('it-available').checked = item.available !== false;
  if (item.imageUrl) {
    document.getElementById('it-img-upload').innerHTML = `<img src="${item.imageUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  } else {
    document.getElementById('it-img-upload').innerHTML = `<input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)"><span class="img-upload-txt">📷 Загрузить фото</span>`;
  }
  if (_hasVariants) {
    document.getElementById('variants-check-box').textContent = '✓';
    document.getElementById('simple-price-wrap').style.display = 'none';
    document.getElementById('variants-wrap').style.display = '';
    renderVariants();
  }
  _openSheet('item-overlay');
}

function closeItemSheet(e) {
  if (e && e.target !== document.getElementById('item-overlay')) return;
  document.getElementById('item-overlay').classList.remove('open');
}

function previewItemImg(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    _itemImgDataUrl = e.target.result;
    const wrap = document.getElementById('it-img-upload');
    wrap.innerHTML = `<img src="${_itemImgDataUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  };
  reader.readAsDataURL(file);
}

function toggleVariants() {
  _hasVariants = !_hasVariants;
  document.getElementById('variants-check-box').textContent = _hasVariants ? '✓' : '';
  document.getElementById('simple-price-wrap').style.display = _hasVariants ? 'none' : '';
  document.getElementById('variants-wrap').style.display = _hasVariants ? '' : 'none';
  if (_hasVariants && !_variants.length) addVariant();
}

function addVariant() {
  _variants.push({ name: '', price: 0 });
  renderVariants();
}

function renderVariants() {
  document.getElementById('variants-list').innerHTML = _variants.map((v, i) => `
    <div class="inp-row" style="align-items:flex-end">
      <div class="field"><label>Вариант</label><input class="inp" value="${v.name}" placeholder="Маленький" oninput="_variants[${i}].name=this.value"></div>
      <div class="field"><label>Цена (₸)</label><input class="inp" type="number" value="${v.price}" min="0" oninput="_variants[${i}].price=Number(this.value)"></div>
      <button class="btn-icon btn-danger btn-sm" style="margin-bottom:0;flex-shrink:0" onclick="removeVariant(${i})">×</button>
    </div>`).join('');
}

function removeVariant(i) { _variants.splice(i, 1); renderVariants(); }

async function saveItem() {
  const name  = document.getElementById('it-name').value.trim();
  const cat   = _getCatValue();
  const emoji = document.getElementById('it-emoji').value.trim() || '🍽️';
  const desc  = document.getElementById('it-desc').value.trim();
  const imgUrl = document.getElementById('it-img-url').value.trim() || _itemImgDataUrl || '';
  const avail = document.getElementById('it-available').checked;

  if (!name) { showToast('Введите название', 'warning'); return; }

  let price = 0;
  let variants = [];
  if (_hasVariants) {
    variants = _variants.filter(v => v.name.trim());
    if (!variants.length) { showToast('Добавьте хотя бы один вариант', 'warning'); return; }
  } else {
    price = parseInt(document.getElementById('it-price').value) || 0;
  }

  const btn = document.getElementById('save-item-btn');
  btn.disabled = true;

  const itemId = _editItemId || genId();
  await dbSet('menu_items', itemId, {
    id: itemId, venueId: VENUE.id, name, category: cat, emoji, description: desc,
    imageUrl: imgUrl, price, variants, available: avail, createdAt: new Date().toISOString()
  });

  document.getElementById('item-overlay').classList.remove('open');
  btn.disabled = false;
  tgHaptic('success');
  showToast(_editItemId ? 'Позиция обновлена' : 'Позиция добавлена', 'success');
  await loadMenuItems();
}

async function deleteItem(itemId) {
  if (!confirm('Удалить позицию из меню?')) return;
  await dbDelete('menu_items', itemId);
  tgHaptic('light');
  await loadMenuItems();
}

// ══════════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════════
let _ordersTab = 'active';

function watchNewOrders() {
  _ordersUnsub = onQuerySnap('orders', 'venueId', '==', VENUE.id, orders => {
    const pending = orders.filter(o => o.status === 'pending').length;
    const badge = document.getElementById('orders-badge');
    badge.textContent = pending;
    badge.classList.toggle('hidden', pending === 0);
    if (_ordersTab === 'active' && document.getElementById('s-orders').classList.contains('active')) {
      renderOrdersList(orders.filter(o => ['pending','accepted','cooking','searching_courier','delivering'].includes(o.status)));
    }
  });
}

async function loadOrders(tab, el) {
  _ordersTab = tab;
  if (el) { document.querySelectorAll('#s-orders .cat-tab').forEach(b => b.classList.remove('active')); el.classList.add('active'); }
  const list = document.getElementById('admin-orders-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  let orders = [];
  if (tab === 'active') {
    orders = await dbQuery('orders','venueId','==',VENUE.id);
    orders = orders.filter(o => ['pending','accepted','cooking','searching_courier','delivering'].includes(o.status));
  } else if (tab === 'pending') {
    orders = await dbQuery('orders','venueId','==',VENUE.id);
    orders = orders.filter(o => o.status === 'pending');
  } else {
    orders = await dbQuery('orders','venueId','==',VENUE.id);
    orders = orders.filter(o => ['delivered','cancelled'].includes(o.status));
    orders = orders.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,80);
  }
  renderOrdersList(orders);
}

function renderOrdersList(orders) {
  const list = document.getElementById('admin-orders-list');
  if (!orders.length) { list.innerHTML='<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Заказов нет</div></div>'; return; }
  list.innerHTML = orders.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(o => `
    <div class="order-card" onclick="openOrderDetail('${o.id}')" style="cursor:pointer">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">${o.clientName}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id||'').slice(-6)}</div></div>
        <div style="text-align:right"><span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span><div style="font-weight:700;font-size:15px;color:var(--primary);margin-top:3px">${fmtPrice(o.total)}</div></div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items||[]).map(i=>`${i.emoji||'🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
        ${o.address?`<div class="text-sm text-dim mt-1">📍 ${o.address.street} ${o.address.house}${o.address.apt?', кв.'+o.address.apt:''}</div>`:''}
      </div>
    </div>`).join('');
}

async function openOrderDetail(orderId) {
  const order = (await dbQuery('orders','venueId','==',VENUE.id)).find(o => o.id === orderId);
  if (!order) return;
  const addr = order.address;
  const content = document.getElementById('order-detail-content');
  content.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:12px">
      <div><div class="font-bold" style="font-size:16px">Заказ #${(order.id||'').slice(-6)}</div><div class="order-id">${fmtDate(order.createdAt)}</div></div>
      <span class="${statusBadgeClass(order.status)}">${statusLabel(order.status)}</span>
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span class="font-bold">${order.clientName}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${order.clientPhone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
      ${addr?`<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}${addr.hasIntercom?` · домофон: ${addr.intercomCode||'есть'}`:''}</span></div>`:''}
      ${order.deliveryType==='pickup'?`<div class="flex justify-between"><span class="text-dim">Получение</span><span>🏪 Самовывоз</span></div>`:''}
      ${order.comment?`<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%">${order.comment}</span></div>`:''}
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав заказа</div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      ${(order.items||[]).map(it=>`<div class="flex justify-between"><span>${it.emoji||'🍽️'} ${it.name}${it.variantName?' ('+it.variantName+')':''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
      <div class="divider"></div>
      ${order.deliveryPrice?`<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(order.deliveryPrice)}</span></div>`:''}
      <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice(order.total + (order.deliveryPrice||0))}</span></div>
    </div>
    ${renderAdminOrderActions(order)}`;
  _openSheet('order-overlay');
}

function renderAdminOrderActions(order) {
  const blBtn = order.clientUid
    ? `<button class="btn btn-ghost btn-sm" style="margin-top:8px;color:var(--danger)" onclick="adminBlacklistClient('${order.clientUid}','${(order.clientPhone||'').replace(/'/g,'')}')">🚫 В чёрный список</button>`
    : '';
  const cancelBtn = `<button class="btn btn-danger btn-sm" onclick="adminCancelOrder('${order.id}')">❌ Отменить</button>`;
  if (order.status === 'pending') return `
    <div class="btn-row">${cancelBtn}
      <button class="btn btn-success btn-sm" onclick="adminAcceptOrder('${order.id}')">✅ Принять</button>
    </div>${blBtn}`;
  if (order.status === 'accepted' || order.status === 'cooking') return `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="btn-row">
        <button class="btn btn-secondary btn-sm" onclick="adminSearchCourier('${order.id}')">🔍 Искать курьера</button>
        <button class="btn btn-primary btn-sm" onclick="openAssignCourier('${order.id}')">👤 Назначить напрямую</button>
      </div>
      ${cancelBtn}
    </div>${blBtn}`;
  if (order.status === 'searching_courier') return `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="alert-box info" style="font-size:13px">⏳ Ждём курьера…</div>
      <button class="btn btn-primary btn-sm" onclick="openAssignCourier('${order.id}')">👤 Назначить напрямую</button>
      ${cancelBtn}
    </div>${blBtn}`;
  if (order.status === 'delivering') return `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="alert-box success">🚴 Курьер: <strong>${order.courierName||''}</strong></div>
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm" onclick="adminSearchCourier('${order.id}')">🔍 Найти нового</button>
        <button class="btn btn-ghost btn-sm" onclick="openAssignCourier('${order.id}')">👤 Назначить другого</button>
      </div>
      ${cancelBtn}
    </div>${blBtn}`;
  return blBtn;
}

async function adminAcceptOrder(orderId) {
  const mins = VENUE.deliveryTime || 60;
  const estimated = new Date(Date.now() + mins * 60000).toISOString();
  await dbSet('orders', orderId, {
    status: 'accepted', acceptedAt: new Date().toISOString(), operatorUid: STATE.uid,
    deliveryMinutes: mins, estimatedAt: estimated,
    clientNotification: { type: 'accepted', seen: false }
  });
  tgHaptic('success'); closeOrderSheet(); showToast('Заказ принят', 'success');
  await loadOrders(_ordersTab);
}

async function adminCancelOrder(orderId) {
  const doCancel = async () => {
    await dbSet('orders', orderId, { status: 'cancelled', cancelledAt: new Date().toISOString(), clientNotification: { type: 'cancelled', seen: false } });
    tgHaptic('light'); closeOrderSheet(); showToast('Заказ отменён', 'info');
    await loadOrders(_ordersTab);
  };
  if (tg?.showConfirm) tg.showConfirm('Отменить заказ? Клиент получит уведомление.', ok => { if (ok) doCancel(); });
  else if (confirm('Отменить заказ?')) await doCancel();
}

async function adminSearchCourier(orderId) {
  await dbSet('orders', orderId, { status: 'searching_courier', searchStartedAt: new Date().toISOString() });
  tgHaptic('success'); showToast('Курьеры уведомлены', 'success');
  closeOrderSheet(); await loadOrders(_ordersTab);
}

let _assignOrderId = null;
async function openAssignCourier(orderId) {
  _assignOrderId = orderId;
  const listEl = document.getElementById('courier-select-list');
  listEl.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  document.getElementById('order-overlay').classList.remove('open');
  _openSheet('courier-overlay');

  // Only permanent on-shift couriers
  const onShiftCouriers = (await dbQuery('couriers','onShift','==',true)).filter(c => c.status === 'active');
  const permLinks  = await dbQuery('courier_venue_links','venueId','==',VENUE.id);
  const permUids   = permLinks.filter(l => l.status === 'confirmed').map(l => l.uid);
  const permOnShift = onShiftCouriers.filter(c => permUids.includes(c.uid));

  if (!permOnShift.length) { listEl.innerHTML = '<div class="empty"><div class="empty-text">Нет постоянных курьеров на смене</div></div>'; return; }
  listEl.innerHTML = permOnShift.map(c => `
    <div class="list-item" onclick="assignCourier('${c.uid}','${(c.name||'Курьер').replace(/'/g,'')}')">
      <div class="li-icon yellow">🚴</div>
      <div class="li-body">
        <div class="li-title">${c.name||'—'} <span class="pill" style="font-size:10px">Постоянный</span></div>
        <div class="li-sub">${c.phone||''}</div>
      </div>
      <div class="chevron">›</div>
    </div>`).join('');
}

async function assignCourier(courierUid, courierName) {
  if (!_assignOrderId) return;
  await dbSet('orders', _assignOrderId, { status: 'delivering', courierUid, courierName, assignedAt: new Date().toISOString(), clientNotification: { type: 'delivering', seen: false, message: `Курьер ${courierName} везёт ваш заказ!` } });
  closeCourierSheet(); tgHaptic('success'); showToast(`Заказ назначен курьеру ${courierName}`, 'success');
  await loadOrders(_ordersTab);
}

async function adminRetransferOrder(orderId) {
  await dbSet('orders', orderId, { status: 'searching_courier', courierUid: null, courierName: null });
  closeOrderSheet(); await openAssignCourier(orderId);
}

function closeOrderSheet(e) {
  if (e && e.target !== document.getElementById('order-overlay')) return;
  document.getElementById('order-overlay').classList.remove('open');
}
function closeCourierSheet(e) {
  if (e && e.target !== document.getElementById('courier-overlay')) return;
  document.getElementById('courier-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════
async function loadStats() {
  const orders = await dbQuery('orders','venueId','==',VENUE.id);
  const total  = orders.length;
  const done   = orders.filter(o=>o.status==='delivered').length;
  const cancelled = orders.filter(o=>o.status==='cancelled').length;
  const revenue = orders.filter(o=>o.status==='delivered').reduce((s,o)=>s+(o.total||0),0);

  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card"><div class="stat-val">${total}</div><div class="stat-lbl">Всего заказов</div></div>
    <div class="stat-card"><div class="stat-val text-success">${done}</div><div class="stat-lbl">Доставлено</div></div>
    <div class="stat-card"><div class="stat-val text-danger">${cancelled}</div><div class="stat-lbl">Отменено</div></div>
    <div class="stat-card"><div class="stat-val text-primary">${fmtPrice(revenue)}</div><div class="stat-lbl">Выручка</div></div>`;

  const itemFreq = {};
  orders.filter(o=>o.status==='delivered').forEach(o => {
    (o.items||[]).forEach(it => { itemFreq[it.name] = (itemFreq[it.name]||0) + it.qty; });
  });
  const topItems = Object.entries(itemFreq).sort((a,b)=>b[1]-a[1]).slice(0,5);
  document.getElementById('stats-top-items').innerHTML = topItems.length
    ? `<div class="section-title" style="margin-bottom:6px">Топ блюд</div>${topItems.map(([name,qty])=>`<div class="list-item" style="cursor:default"><div class="li-body"><div class="li-title">${name}</div></div><div class="li-price">${qty} шт</div></div>`).join('')}`
    : '';
}

// ══════════════════════════════════════════════════════════
//  SETTINGS SCREEN
// ══════════════════════════════════════════════════════════
async function loadSettingsScreen() {
  if (!VENUE) return;
  document.getElementById('set-name').value     = VENUE.name||'';
  document.getElementById('set-address').value  = VENUE.address||'';
  document.getElementById('set-phone').value    = VENUE.phone||'';
  document.getElementById('set-desc').value     = VENUE.description||'';
  document.getElementById('set-cover').value    = VENUE.coverUrl||'';
  document.getElementById('set-open').value     = VENUE.workOpen||'09:00';
  document.getElementById('set-close').value    = VENUE.workClose||'22:00';
  document.getElementById('set-delivery-time').value  = VENUE.deliveryTime||30;
  document.getElementById('set-delivery-price').value = VENUE.deliveryPrice||0;
  document.getElementById('set-cooking-time').value   = VENUE.cookingTime||20;
  document.getElementById('set-min-order').value      = VENUE.minOrder||0;

  // Operator
  const op = VENUE.operatorUid ? await dbGet('users', VENUE.operatorUid) : null;
  const opInfo = document.getElementById('current-operator-info');
  const removeBtn = document.getElementById('remove-op-btn');
  if (op) {
    opInfo.textContent = `Оператор: ${op.name||'—'} (${op.phone||'—'})`;
    opInfo.className = 'alert-box success';
    removeBtn.style.display = '';
  } else {
    opInfo.textContent = 'Оператор не назначен';
    opInfo.className = 'alert-box info';
    removeBtn.style.display = 'none';
  }

  // Permanent couriers
  await loadPermCouriers();
  // Blacklist
  await loadBlacklist();
}

async function saveVenueInfo() {
  const name    = document.getElementById('set-name').value.trim();
  const address = document.getElementById('set-address').value.trim();
  const phone   = document.getElementById('set-phone').value.trim();
  const desc    = document.getElementById('set-desc').value.trim();
  const cover   = document.getElementById('set-cover').value.trim();
  if (!name || !address) { showToast('Введите название и адрес', 'warning'); return; }
  await dbSet('venues', VENUE.id, { name, address, phone, description: desc, coverUrl: cover });
  VENUE = { ...VENUE, name, address, phone, description: desc, coverUrl: cover };
  tgHaptic('success'); showToast('Сохранено', 'success');
}

async function saveWorkHours() {
  const open  = document.getElementById('set-open').value;
  const close = document.getElementById('set-close').value;
  await dbSet('venues', VENUE.id, { workOpen: open, workClose: close });
  VENUE = { ...VENUE, workOpen: open, workClose: close };
  tgHaptic('success'); showToast('Часы сохранены', 'success');
}

async function saveDeliverySettings() {
  const delTime  = parseInt(document.getElementById('set-delivery-time').value)||30;
  const delPrice = parseInt(document.getElementById('set-delivery-price').value)||0;
  const cookTime = parseInt(document.getElementById('set-cooking-time').value)||20;
  const minOrd   = parseInt(document.getElementById('set-min-order').value)||0;
  await dbSet('venues', VENUE.id, { deliveryTime: delTime, deliveryPrice: delPrice, cookingTime: cookTime, minOrder: minOrd });
  VENUE = { ...VENUE, deliveryTime: delTime, deliveryPrice: delPrice, cookingTime: cookTime, minOrder: minOrd };
  tgHaptic('success'); showToast('Настройки доставки сохранены', 'success');
}

async function assignOperator() {
  const phone = document.getElementById('op-phone').value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  // Find user by phone in user_links
  const links = await dbGetAll('user_links');
  const link  = links.find(l => l.phone === phone || l.phone === phone.replace(/^\+/,'') || ('+'+l.phone) === phone);
  if (!link) { showToast('Пользователь с таким номером не найден', 'error'); return; }
  const uid = link.uid;
  // Save invite
  await dbSet('operator_invites', uid, { uid, venueId: VENUE.id, venueName: VENUE.name, venueAddress: VENUE.address||'', adminUid: STATE.uid, status: 'pending', createdAt: new Date().toISOString() });
  await dbSet('venues', VENUE.id, { operatorUid: uid });
  VENUE.operatorUid = uid;
  tgHaptic('success'); showToast('Приглашение отправлено оператору', 'success');
  document.getElementById('op-phone').value = '';
  await loadSettingsScreen();
}

async function removeOperator() {
  if (!confirm('Снять оператора с заведения?')) return;
  if (VENUE.operatorUid) {
    await dbDelete('operator_invites', VENUE.operatorUid);
    await dbSet('users', VENUE.operatorUid, { operatorVenueId: null });
  }
  await dbSet('venues', VENUE.id, { operatorUid: null });
  VENUE.operatorUid = null;
  showToast('Оператор снят', 'info');
  await loadSettingsScreen();
}

async function addPermCourier() {
  const phone = document.getElementById('courier-phone').value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  const links = await dbGetAll('user_links');
  const link  = links.find(l => l.phone === phone || l.phone === phone.replace(/^\+/,'') || ('+'+l.phone) === phone);
  if (!link) { showToast('Курьер с таким номером не найден', 'error'); return; }
  const uid = link.uid;
  const courier = await dbGet('couriers', uid);
  if (!courier) { showToast('Этот пользователь не является курьером', 'error'); return; }
  await dbSet('courier_venue_links', uid, { uid, venueId: VENUE.id, venueName: VENUE.name, status: 'pending', invitedAt: new Date().toISOString() });
  tgHaptic('success'); showToast('Приглашение отправлено курьеру', 'success');
  document.getElementById('courier-phone').value = '';
  await loadPermCouriers();
}

async function loadPermCouriers() {
  const links = await dbQuery('courier_venue_links','venueId','==',VENUE.id);
  const listEl = document.getElementById('perm-couriers-list');
  if (!links.length) { listEl.innerHTML='<div class="text-dim text-sm">Нет постоянных курьеров</div>'; return; }
  const rows = await Promise.all(links.map(async l => {
    const c = await dbGet('couriers', l.uid);
    return { ...l, courierName: c?.name||l.uid, phone: c?.phone||'' };
  }));
  listEl.innerHTML = rows.map(r => `
    <div class="flex items-center gap-2">
      <div class="li-icon yellow" style="width:34px;height:34px;font-size:16px">🚴</div>
      <div style="flex:1"><div class="font-bold text-sm">${r.courierName}</div><div class="text-xs text-dim">${r.phone} · ${r.status==='confirmed'?'<span class="text-success">Подтвердил</span>':'Ожидает'}</div></div>
      <button class="btn-xs btn-danger" onclick="removePermCourier('${r.uid}')">×</button>
    </div>`).join('');
}

async function removePermCourier(uid) {
  await dbDelete('courier_venue_links', uid);
  showToast('Курьер удалён', 'info');
  await loadPermCouriers();
}

// ══════════════════════════════════════════════════════════
//  BLACKLIST
// ══════════════════════════════════════════════════════════
async function adminBlacklistClient(clientUid, clientPhone) {
  if (!confirm(`Добавить клиента (${clientPhone || clientUid}) в чёрный список? Он не сможет заказывать в вашем заведении.`)) return;
  const blId = VENUE.id + '_' + clientUid;
  await dbSet('venue_blacklist', blId, {
    venueId: VENUE.id, clientUid, clientPhone,
    addedAt: new Date().toISOString(), adminUid: STATE.uid
  });
  tgHaptic('success'); showToast('Клиент добавлен в ЧС', 'success');
  closeOrderSheet();
}

async function addToBlacklistByPhone() {
  const phone = document.getElementById('bl-phone').value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  const links = await dbGetAll('user_links');
  const link  = links.find(l => l.phone === phone || l.phone === phone.replace(/^\+/,'') || ('+'+l.phone) === phone);
  if (!link) { showToast('Пользователь с таким номером не найден', 'error'); return; }
  const blId = VENUE.id + '_' + link.uid;
  await dbSet('venue_blacklist', blId, {
    venueId: VENUE.id, clientUid: link.uid, clientPhone: link.phone,
    addedAt: new Date().toISOString(), adminUid: STATE.uid
  });
  document.getElementById('bl-phone').value = '';
  tgHaptic('success'); showToast('Клиент добавлен в ЧС', 'success');
  await loadBlacklist();
}

async function loadBlacklist() {
  const items = await dbQuery('venue_blacklist', 'venueId', '==', VENUE.id);
  const listEl = document.getElementById('blacklist-items');
  if (!listEl) return;
  if (!items.length) {
    listEl.innerHTML = '<div class="text-dim text-sm">Чёрный список пуст</div>';
    return;
  }
  listEl.innerHTML = items.map(b => `
    <div class="flex items-center gap-2">
      <div class="li-icon" style="width:34px;height:34px;font-size:16px;background:var(--danger-bg,rgba(239,68,68,.15))">🚫</div>
      <div style="flex:1"><div class="font-bold text-sm">${b.clientPhone||b.clientUid}</div><div class="text-xs text-dim">${fmtDate(b.addedAt)}</div></div>
      <button class="btn-xs btn-danger" onclick="removeFromBlacklist('${b.venueId}_${b.clientUid}')">×</button>
    </div>`).join('');
}

async function removeFromBlacklist(blId) {
  await dbDelete('venue_blacklist', blId);
  showToast('Клиент удалён из ЧС', 'info');
  await loadBlacklist();
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION + TELEGRAM BACK BUTTON
// ══════════════════════════════════════════════════════════
function _initAdminBackButton() {
  if (!tg?.BackButton) return;
  tg.BackButton.onClick(() => {
    const open = document.querySelector('.overlay.open');
    if (open) {
      open.classList.remove('open');
      if (!document.querySelector('.overlay.open')) tg.BackButton.hide();
      return;
    }
    tg.BackButton.hide();
  });
}
function _openSheet(id) {
  document.getElementById(id)?.classList.add('open');
  tg?.BackButton?.show();
}

function adminNavTo(screenId) {
  showScreen(screenId);
}
function setNav(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}
