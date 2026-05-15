'use strict';
/* ============================================================
   VEZOO ADMIN — Venue Admin Mini App
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUE           = null;
let MENU_ITEMS      = [];
let MENU_CATS       = [];
let _allOrders      = [];
let _editItemId     = null;
let _variants       = [];
let _hasVariants    = false;
let _ordersUnsub    = null;
let _histOrders     = [];   // history orders fetched separately
let _coverDataUrl   = null;
let _setCoverDataUrl = null;
let _pinTarget      = null;
let _sectionPinBuffer = '';
let _ordersTab      = 'active';
let _handoffCourier = null;
let _handoffSelectedOrders = new Set();
let _payMethods     = { cash: true, card: true };

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
    if (!_tgUserId || s.tgId === _tgUserId) { STATE.uid = s.uid||null; STATE.user = s.user||null; }
  } catch {}
  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }
  await initFirebase();
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing?.blocked) { showScreen('s-blocked'); return; }
  if (!existing?.agreedAdmin) { showAgreement(); return; }

  if (existing && !existing.name) {
    const autoName = _getTgName() || 'Администратор';
    await dbSet('users', STATE.uid, { name: autoName });
    existing.name = autoName;
  }
  STATE.user = existing; saveState();
  // Variant A: SA-triggered per-user cache reset
  if (existing.resetCache === true && !sessionStorage.getItem('_vez_reset_done')) {
    sessionStorage.setItem('_vez_reset_done', '1');
    try { await dbUpdate('users', STATE.uid, { resetCache: false }); } catch {}
    localStorage.clear(); location.reload(); return;
  }
  sessionStorage.removeItem('_vez_reset_done');
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

// ══════════════════════════════════════════════════════════
//  AGREEMENT
// ══════════════════════════════════════════════════════════
function showAgreement() {
  document.getElementById('s-splash').style.display = 'none';
  document.getElementById('s-agree').style.display  = 'flex';
}

async function submitAgree() {
  const btn = document.getElementById('agree-btn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  const linkData = await dbGet('user_links', STATE.uid);
  const autoName = _getTgName() || linkData?.firstName || 'Администратор';
  STATE.user = { name: autoName, phone: linkData?.phone||'', tgId: linkData?.tgId||'', role: 'admin', agreedAdmin: true, createdAt: new Date().toISOString() };
  await dbSet('users', STATE.uid, STATE.user);
  saveState();
  if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  document.getElementById('s-agree').style.display = 'none';
  await checkVenueAndInit();
}

// ══════════════════════════════════════════════════════════
//  SECTION PIN (Menu / Stats access)
// ══════════════════════════════════════════════════════════
function openMenuWithPin() {
  _pinTarget = 'menu';
  _openSectionPin();
}

function openStatsWithPin() {
  _pinTarget = 'stats';
  _openSectionPin();
}

function openChangePinWithPin() {
  _pinTarget = 'changepin';
  _openSectionPin();
}

function _openSectionPin() {
  const lockSec = isPinLockedOut('admin');
  if (lockSec > 0) { showToast(`Заблокировано на ${lockSec} сек.`, 'warning'); return; }
  _sectionPinBuffer = '';
  updateSectionPinDots();
  document.getElementById('spd-sub-text').textContent = 'Введите PIN для доступа';
  document.getElementById('section-pin-overlay').classList.add('open');
}

function sectionPinInput(digit) {
  if (_sectionPinBuffer.length >= 4) return;
  tgHaptic('light');
  _sectionPinBuffer += digit;
  updateSectionPinDots();
  if (_sectionPinBuffer.length === 4) setTimeout(checkSectionPin, 80);
}

function sectionPinDelete() {
  if (!_sectionPinBuffer.length) return;
  _sectionPinBuffer = _sectionPinBuffer.slice(0, -1);
  updateSectionPinDots();
}

function updateSectionPinDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('spd' + i);
    if (!dot) continue;
    dot.classList.toggle('filled', i < _sectionPinBuffer.length);
    dot.classList.remove('error');
  }
}

async function checkSectionPin() {
  const lockSec = isPinLockedOut('admin');
  if (lockSec > 0) {
    document.getElementById('spd-sub-text').textContent = `Заблокировано на ${lockSec} сек.`;
    _sectionPinBuffer = ''; updateSectionPinDots(); return;
  }
  const ok = await verifyPin('admin', _sectionPinBuffer);
  recordPinAttempt('admin', ok);
  if (ok) {
    document.getElementById('section-pin-overlay').classList.remove('open');
    if (_pinTarget === 'menu') {
      document.getElementById('menu-overlay').classList.add('open');
      loadMenuItems();
    } else if (_pinTarget === 'stats') {
      document.getElementById('stats-overlay').classList.add('open');
      loadStats();
    } else if (_pinTarget === 'changepin') {
      document.getElementById('change-pin-overlay').classList.add('open');
    }
    _pinTarget = null;
  } else {
    tgHaptic('error');
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById('spd' + i);
      if (dot) { dot.classList.add('error'); dot.classList.remove('filled'); }
    }
    const remaining = isPinLockedOut('admin');
    document.getElementById('spd-sub-text').textContent = remaining > 0 ? `Заблокировано на ${remaining} сек.` : 'Неверный PIN. Попробуйте снова';
    setTimeout(() => { _sectionPinBuffer = ''; updateSectionPinDots(); document.getElementById('spd-sub-text').textContent = 'Введите PIN для доступа'; }, 900);
  }
}

function closeSectionPin() {
  document.getElementById('section-pin-overlay').classList.remove('open');
  _sectionPinBuffer = ''; _pinTarget = null;
}

function closeMenuOverlay(e) {
  if (e && e.target !== document.getElementById('menu-overlay')) return;
  document.getElementById('menu-overlay').classList.remove('open');
}

function closeStatsOverlay(e) {
  if (e && e.target !== document.getElementById('stats-overlay')) return;
  document.getElementById('stats-overlay').classList.remove('open');
}

function closeChangePinOverlay(e) {
  if (e && e.target !== document.getElementById('change-pin-overlay')) return;
  document.getElementById('change-pin-overlay').classList.remove('open');
}

// ── Menu localStorage helpers ──
function _loadMenuFromStorage() { try { return JSON.parse(localStorage.getItem('vez_admin_menu_' + (VENUE?.id||'')) || '[]'); } catch { return []; } }
function _saveMenuToStorage(items) { try { localStorage.setItem('vez_admin_menu_' + (VENUE?.id||''), JSON.stringify(items)); } catch {} }

async function changeAdminPin() {
  const val = (document.getElementById('new-pin-input')?.value || '').trim();
  if (val.length !== 4 || !/^\d{4}$/.test(val)) { showToast('PIN должен быть 4 цифры', 'warning'); return; }
  await savePin('admin', val);
  document.getElementById('new-pin-input').value = '';
  document.getElementById('change-pin-overlay').classList.remove('open');
  tgHaptic('success'); showToast('PIN изменён', 'success');
}

// ══════════════════════════════════════════════════════════
//  VENUE CHECK
// ══════════════════════════════════════════════════════════
async function checkVenueAndInit() {
  // Superadmin assigns admin directly — no invite/confirmation step needed.
  // Just look for a venue where adminUid equals this user.
  let venues = await dbQuery('venues', 'adminUid', '==', STATE.uid);
  if (!venues.length) {
    // Backward compat: check old ownerId field
    venues = (await dbQuery('venues','ownerId','==',STATE.uid)).filter(v => v.status === 'approved');
  }
  VENUE = venues[0] || null;

  if (!VENUE) { showNoVenueScreen(); return; }
  if (VENUE.blocked) { showScreen('s-blocked'); return; }
  initMain();
}

function showNoVenueScreen() {
  const phone = STATE.user?.phone || '';
  document.getElementById('admin-waiting-phone').textContent = phone || '—';
  showScreen('s-no-venue');
  renderQrCode('admin-waiting-qr', phone || STATE.uid, 160);
}

async function checkAdminInvite() {
  const invite = await dbGet('admin_invites', STATE.uid);
  if (invite && invite.status === 'pending') {
    document.getElementById('admin-invite-venue-name').textContent = invite.venueName || 'Заведение';
    document.getElementById('admin-invite-venue-addr').textContent = invite.venueAddress || '—';
    showScreen('s-confirm-venue');
  } else {
    showToast('Приглашений нет', 'info');
  }
}

async function acceptAdminInvite() {
  const btn = document.querySelector('#s-confirm-venue .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Принятие...'; }
  const invite = await dbGet('admin_invites', STATE.uid);
  if (!invite) { showToast('Приглашение не найдено', 'error'); return; }
  await dbSet('venues', invite.venueId, { adminUid: STATE.uid, adminName: STATE.user?.name || '' });
  await dbSet('admin_invites', STATE.uid, { status: 'accepted' });
  tgHaptic('success');
  await checkVenueAndInit();
}

async function declineAdminInvite() {
  const invite = await dbGet('admin_invites', STATE.uid);
  if (invite) await dbSet('admin_invites', STATE.uid, { status: 'declined' });
  showNoVenueScreen();
}

function previewCover(input, wrapId) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    _setCoverDataUrl = dataUrl;
    const wrap = document.getElementById(wrapId);
    wrap.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"><input type="file" id="set-cover-file" accept="image/*" onchange="previewCover(this,'${wrapId}')" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  };
  reader.readAsDataURL(file);
}

function togglePayTag(btnId, method) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  _payMethods[method] = !_payMethods[method];
  btn.classList.toggle('active-cash', method === 'cash' && _payMethods[method]);
  btn.classList.toggle('active-card', method === 'card' && _payMethods[method]);
  if (!_payMethods[method]) btn.className = 'pay-tag';
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  watchNewOrders();
  showScreen('s-orders');
  setNav(document.getElementById('nav-orders'));
  loadOrders('active');
}

// ══════════════════════════════════════════════════════════
//  MENU
// ══════════════════════════════════════════════════════════
async function loadMenuItems() {
  const list = document.getElementById('menu-items-list');
  if (!list) return;
  // Show localStorage data instantly
  const stored = _loadMenuFromStorage();
  if (stored.length) {
    MENU_ITEMS = stored;
    MENU_CATS  = [...new Set(MENU_ITEMS.map(i => i.category).filter(Boolean))];
    renderMenuCatTabs(); renderMenuItems(null); _refreshCatSelect();
  } else {
    list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  }
  // Fetch from Firestore, update localStorage
  const fresh = await dbQuery('menu_items','venueId','==',VENUE.id);
  if (fresh.length || !stored.length) {
    MENU_ITEMS = fresh;
    _saveMenuToStorage(MENU_ITEMS);
    MENU_CATS  = [...new Set(MENU_ITEMS.map(i => i.category).filter(Boolean))];
    renderMenuCatTabs(); renderMenuItems(null); _refreshCatSelect();
  }
}

function _refreshCatSelect(currentVal) {
  const sel = document.getElementById('it-cat');
  if (!sel) return;
  sel.innerHTML =
    '<option value="">— без категории —</option>' +
    MENU_CATS.map(c=>`<option value="${c}"${c===currentVal?' selected':''}>${c}</option>`).join('') +
    '<option value="__new__">✏️ Новая категория...</option>';
  if (currentVal && !MENU_CATS.includes(currentVal)) {
    sel.value = '__new__';
    const custom = document.getElementById('it-cat-custom');
    if (custom) { custom.style.display=''; custom.value=currentVal; }
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
  if (sel.value === '__new__') return (document.getElementById('it-cat-custom')?.value||'').trim();
  return sel.value;
}

function renderMenuCatTabs() {
  const container = document.getElementById('menu-cats-tabs');
  container.innerHTML = ['Все',...MENU_CATS].map((c,i)=>
    `<button class="cat-tab${i===0?' active':''}" onclick="filterMenuItems(this,'${c}')">${c}</button>`
  ).join('');
}

function filterMenuItems(el, cat) {
  document.querySelectorAll('#menu-cats-tabs .cat-tab').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  renderMenuItems(cat==='Все'?null:cat);
}

function renderMenuItems(cat) {
  const items = cat ? MENU_ITEMS.filter(i=>i.category===cat) : MENU_ITEMS;
  const list  = document.getElementById('menu-items-list');
  if (!items.length) { list.innerHTML='<div class="empty"><div class="empty-icon">🍽️</div><div class="empty-text">Нет позиций в меню.<br>Нажмите «+ Добавить».</div></div>'; return; }
  list.innerHTML = items.map(item => {
    const priceStr = item.variants?.length
      ? item.variants.map(v=>`${escHtml(v.name)}: ${fmtPrice(v.price)}`).join(' · ')
      : fmtPrice(item.price);
    const hiddenBadge = item.available===false
      ? `<span style="display:inline-block;margin-left:6px;background:var(--danger-soft);color:var(--danger);font-size:10px;padding:1px 6px;border-radius:4px;font-weight:700;vertical-align:middle">Скрыт</span>`
      : '';
    return `
      <div class="admin-item">
        <div class="admin-item-emoji">${item.emoji||'🍽️'}</div>
        <div class="admin-item-body">
          <div class="admin-item-name">${escHtml(item.name)}${hiddenBadge}</div>
          <div class="admin-item-price">${priceStr}</div>
          ${item.category?`<div class="text-xs text-dim" style="margin-top:2px">${escHtml(item.category)}</div>`:''}
        </div>
        <div class="admin-item-actions">
          <button class="btn btn-icon btn-ghost" onclick="openEditItem('${item.id}')">✏️</button>
          <button class="btn btn-icon btn-danger" onclick="deleteItem('${item.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

function openAddItem() {
  _editItemId=null; _variants=[]; _hasVariants=false;
  document.getElementById('item-sheet-title').textContent='Добавить позицию';
  document.getElementById('it-name').value='';
  document.getElementById('it-emoji').value='';
  document.getElementById('it-desc').value='';
  document.getElementById('it-price').value='';
  _refreshCatSelect();
  document.getElementById('it-cat-custom').style.display='none';
  document.getElementById('variants-check-box').textContent='';
  document.getElementById('simple-price-wrap').style.display='';
  document.getElementById('variants-wrap').style.display='none';
  document.getElementById('variants-list').innerHTML='';
  _openSheet('item-overlay');
}

async function openEditItem(itemId) {
  const item = MENU_ITEMS.find(i=>i.id===itemId);
  if (!item) return;
  _editItemId=itemId; _variants=[...(item.variants||[])]; _hasVariants=_variants.length>0;
  document.getElementById('item-sheet-title').textContent='Редактировать позицию';
  document.getElementById('it-name').value=item.name||'';
  document.getElementById('it-emoji').value=item.emoji||'';
  document.getElementById('it-desc').value=item.description||'';
  document.getElementById('it-price').value=item.price||'';
  _refreshCatSelect(item.category||'');
  if (_hasVariants) {
    document.getElementById('variants-check-box').textContent='✓';
    document.getElementById('simple-price-wrap').style.display='none';
    document.getElementById('variants-wrap').style.display='';
    renderVariants();
  }
  _openSheet('item-overlay');
}

function closeItemSheet(e) {
  if (e && e.target!==document.getElementById('item-overlay')) return;
  document.getElementById('item-overlay').classList.remove('open');
}

function toggleVariants() {
  _hasVariants=!_hasVariants;
  document.getElementById('variants-check-box').textContent=_hasVariants?'✓':'';
  document.getElementById('simple-price-wrap').style.display=_hasVariants?'none':'';
  document.getElementById('variants-wrap').style.display=_hasVariants?'':'none';
  if (_hasVariants && !_variants.length) addVariant();
}

function addVariant() { _variants.push({name:'',price:0}); renderVariants(); }

function renderVariants() {
  document.getElementById('variants-list').innerHTML=_variants.map((v,i)=>`
    <div class="inp-row" style="align-items:flex-end">
      <div class="field"><label>Вариант</label><input class="inp" value="${escHtml(v.name)}" placeholder="Маленький" oninput="_variants[${i}].name=this.value"></div>
      <div class="field"><label>Цена</label><input class="inp" type="number" value="${v.price}" min="0" oninput="_variants[${i}].price=Number(this.value)"></div>
      <button class="btn btn-icon" style="width:34px;height:34px;background:var(--danger-soft);color:var(--danger);border:none;border-radius:8px;cursor:pointer;flex-shrink:0" onclick="removeVariant(${i})">×</button>
    </div>`).join('');
}

function removeVariant(i) { _variants.splice(i,1); renderVariants(); }

async function saveItem() {
  const name  = document.getElementById('it-name').value.trim();
  const cat   = _getCatValue();
  const emoji = document.getElementById('it-emoji').value.trim()||'🍽️';
  const desc  = document.getElementById('it-desc').value.trim();
  if (!name) { showToast('Введите название','warning'); return; }
  let price=0, variants=[];
  if (_hasVariants) {
    variants=_variants.filter(v=>v.name.trim());
    if (!variants.length) { showToast('Добавьте хотя бы один вариант','warning'); return; }
  } else {
    price=parseInt(document.getElementById('it-price').value)||0;
  }
  const btn=document.getElementById('save-item-btn'); btn.disabled=true;
  const itemId=_editItemId||genId();
  const itemData = { id:itemId, venueId:VENUE.id, name, category:cat, emoji, description:desc,
    price, variants, createdAt:new Date().toISOString() };
  await dbSet('menu_items',itemId, itemData);
  // Update localStorage
  if (_editItemId) {
    const idx = MENU_ITEMS.findIndex(i => i.id === itemId);
    if (idx >= 0) MENU_ITEMS[idx] = { ...MENU_ITEMS[idx], ...itemData };
    else MENU_ITEMS.push(itemData);
  } else {
    MENU_ITEMS.push(itemData);
  }
  _saveMenuToStorage(MENU_ITEMS);
  // Дыра №2: bump menu version so clients know to refresh
  bumpVersion('menu_' + VENUE.id);
  document.getElementById('item-overlay').classList.remove('open');
  btn.disabled=false;
  tgHaptic('success');
  showToast(_editItemId?'Позиция обновлена':'Позиция добавлена','success');
  MENU_CATS = [...new Set(MENU_ITEMS.map(i => i.category).filter(Boolean))];
  renderMenuCatTabs(); renderMenuItems(null); _refreshCatSelect();
}

async function deleteItem(itemId) {
  if (!confirm('Удалить позицию из меню?')) return;
  await dbDelete('menu_items',itemId);
  MENU_ITEMS = MENU_ITEMS.filter(i => i.id !== itemId);
  _saveMenuToStorage(MENU_ITEMS);
  bumpVersion('menu_' + VENUE.id); // Дыра №2
  tgHaptic('light');
  MENU_CATS = [...new Set(MENU_ITEMS.map(i => i.category).filter(Boolean))];
  renderMenuCatTabs(); renderMenuItems(null); _refreshCatSelect();
}

// ══════════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════════
const _ACTIVE_STATUSES = ['pending','accepted','cooking','searching_courier','courier_assigned','ready_for_courier','delivering','ready'];

// Дыра №5: Only listen to active orders.
// REQUIRES Firestore composite index: orders — venueId ASC + active ASC
function watchNewOrders() {
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }   // H-5: unsubscribe before re-subscribing
  _ordersUnsub = onQuerySnapWhere('orders', [
    ['venueId', '==', VENUE.id],
    ['active', '==', true]
  ], orders => {
    _allOrders = orders;
    const pending = orders.filter(o => o.status === 'pending').length;
    const badge = document.getElementById('orders-badge');
    badge.textContent = pending; badge.classList.toggle('hidden', pending === 0);
    if (document.getElementById('s-orders').classList.contains('active') && _ordersTab !== 'history')
      loadOrders(_ordersTab);
  });
}

// Дыра №9 helper: fetch history using venueDateKey (day-by-day, max 7 days)
async function _fetchHistoryOrders(from, to) {
  const seenIds = new Set();
  const orders  = [];
  let current   = new Date(from + 'T00:00:00');
  const end     = new Date(to   + 'T00:00:00');
  let days = 0;
  while (current <= end && days < 7) {
    const dateStr = current.toISOString().slice(0, 10);
    try {
      const dayOrds = await dbQuery('orders', 'venueDateKey', '==', VENUE.id + '_' + dateStr);
      for (const o of dayOrds) {
        if (!seenIds.has(o.id)) { seenIds.add(o.id); orders.push(o); }
      }
    } catch {}
    current.setDate(current.getDate() + 1);
    days++;
  }
  return orders
    .filter(o => ['delivered','cancelled','issued'].includes(o.status))
    .sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
}

async function loadOrders(tab, el) {
  _ordersTab = tab;
  if (el) { document.querySelectorAll('#s-orders .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  const rangeEl = document.getElementById('admin-hist-daterange');
  if (rangeEl) rangeEl.style.display = tab === 'history' ? '' : 'none';

  if (tab === 'active') {
    renderOrdersList(_allOrders.filter(o => _ACTIVE_STATUSES.includes(o.status)));
  } else if (tab === 'pending') {
    renderOrdersList(_allOrders.filter(o => o.status === 'pending'));
  } else {
    // History — separate Firestore query per day (Дыра №9)
    const today = new Date().toISOString().slice(0,10);
    const dateEl = document.getElementById('admin-hist-date');
    if (dateEl && !dateEl.value) dateEl.value = today;
    const selectedDate = dateEl?.value || today;

    const list = document.getElementById('admin-orders-list');
    if (list) list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
    _histOrders = await _fetchHistoryOrders(selectedDate, selectedDate);
    renderOrdersList(_histOrders);
  }
}

function renderOrdersList(orders) {
  const list=document.getElementById('admin-orders-list');
  if (!orders.length) { list.innerHTML='<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Заказов нет</div></div>'; return; }
  list.innerHTML=orders.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(o=>`
    <div class="order-card" onclick="openOrderDetail('${o.id}')" style="cursor:pointer">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">${escHtml(o.clientName||'Клиент')}${o.isManual?` <span class="badge badge-accepted" style="font-size:10px">📞</span>`:''}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id||'').slice(-6)}</div></div>
        <div style="text-align:right"><span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span><div style="font-weight:700;font-size:15px;color:var(--primary);margin-top:3px">${fmtPrice((o.total||0)+(o.deliveryPrice||0))}</div></div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items||[]).map(i=>`${i.emoji||'🍽️'} ${escHtml(i.name)} ×${i.qty}`).join(', ')}</div>
        ${o.address?`<div class="text-sm text-dim mt-1">📍 ${escHtml(o.address.street||o.address)} ${escHtml(o.address.house||'')}${o.address.apt?', кв.'+escHtml(o.address.apt):''}</div>`:''}
      </div>
    </div>`).join('');
}

function _patchAllOrders(orderId, patch) {
  const idx = _allOrders.findIndex(o => o.id === orderId);
  if (idx >= 0) _allOrders[idx] = { ..._allOrders[idx], ...patch };
}

async function openOrderDetail(orderId) {
  const order=_allOrders.find(o=>o.id===orderId);
  if (!order) return;
  const addr=order.address;
  const addrStr=typeof addr==='string'?addr:(addr?((`${addr.street||''} ${addr.house||''}${addr.apt?', кв.'+addr.apt:''}`).trim()||'—'):'—');
  const callBtn=order.clientPhone?`<button class="btn-call" onclick="callPhone('${normPhone(order.clientPhone)}')">📞 Позвонить клиенту</button>`:'';
  const callCourierBtn=order.courierPhone?`<button class="btn-call" onclick="callPhone('${normPhone(order.courierPhone)}')">📞 Позвонить курьеру</button>`:'';
  const content=document.getElementById('order-detail-content');
  content.innerHTML=`
    <div class="flex justify-between items-center" style="margin-bottom:12px">
      <div><div class="font-bold" style="font-size:16px">Заказ #${(order.id||'').slice(-6)}</div><div class="order-id">${fmtDate(order.createdAt)}</div></div>
      <span class="${statusBadgeClass(order.status)}">${statusLabel(order.status)}</span>
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span class="font-bold">${escHtml(order.clientName||'—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${escHtml(order.clientPhone||'—')}</span></div>
      ${order.status==='cancelled'&&order.cancelledBy?`<div class="flex justify-between"><span class="text-dim">Отменил</span><span style="color:var(--danger)">${{client:'Клиент',operator:'Оператор',admin:'Администратор'}[order.cancelledBy]||'—'}</span></div>`:''}
      ${callBtn?`<div>${callBtn}</div>`:''}
      ${(order.courierName||order.courierPhone)?`<div class="flex justify-between"><span class="text-dim">Курьер</span><span style="text-align:right;max-width:60%">${escHtml(order.courierName||'—')}${order.courierPhone?' · '+escHtml(order.courierPhone):''}</span></div>`:'' }
      ${callCourierBtn?`<div>${callCourierBtn}</div>`:''}
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${escHtml(addrStr)}</span></div>
      ${order.comment?`<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%">${escHtml(order.comment)}</span></div>`:''}
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав</div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      ${(order.items||[]).map(it=>`<div class="flex justify-between"><span>${it.emoji||'🍽️'} ${escHtml(it.name)}${it.variantName?' ('+escHtml(it.variantName)+')':''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
      <div class="divider"></div>
      ${order.deliveryPrice?`<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(order.deliveryPrice)}</span></div>`:''}
      <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice(order.total+(order.deliveryPrice||0))}</span></div>
    </div>
    ${renderOrderTimeline(order)}
    ${renderAdminOrderActions(order)}`;
  _openSheet('order-overlay');
}

function renderAdminOrderActions(order) {
  const blBtn=order.clientUid?`<button class="btn btn-ghost btn-sm" style="margin-top:8px;color:var(--danger)" onclick="adminBlacklistClient('${order.clientUid}','${(order.clientPhone||'').replace(/'/g,'')}')">🚫 В чёрный список</button>`:'';
  const cancelBtn=`<button class="btn btn-danger btn-sm" onclick="adminCancelOrder('${order.id}')">❌ Отменить</button>`;
  const isPickup = order.deliveryType === 'pickup';
  if (isPickup) {
    if (order.status==='pending') return `<div class="btn-row">${cancelBtn}<button class="btn btn-success btn-sm" onclick="adminAcceptOrder('${order.id}')">✅ Принять</button></div>${blBtn}`;
    if (order.status==='accepted'||order.status==='cooking') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box info" style="font-size:13px">🏪 Самовывоз</div><div class="btn-row">${cancelBtn}<button class="btn btn-primary btn-sm" onclick="adminIssueOrder('${order.id}')">📦 Выдать клиенту</button></div></div>${blBtn}`;
    if (order.status==='ready') return `<div class="alert-box success" style="margin-bottom:8px;font-size:13px">✅ Заказ готов к выдаче</div><button class="btn btn-primary" onclick="adminIssueOrder('${order.id}')">📦 Выдан клиенту</button>${blBtn}`;
    return blBtn;
  }
  if (order.status==='pending') return `<div class="btn-row">${cancelBtn}<button class="btn btn-success btn-sm" onclick="adminAcceptOrder('${order.id}')">✅ Принять</button></div>${blBtn}`;
  if (order.status==='accepted'||order.status==='cooking') return `<div style="display:flex;flex-direction:column;gap:8px"><button class="btn btn-success btn-sm" onclick="adminMarkReadyForCourier('${order.id}')">✅ Заказ готов</button><div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="adminSearchCourier('${order.id}')">🔍 В общий пул</button><button class="btn btn-primary btn-sm" onclick="openHandoffFlow()">📦 Передать</button></div>${cancelBtn}</div>${blBtn}`;
  if (order.status==='ready_for_courier') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box success" style="font-size:13px">⚡ Заказ готов — ждём курьера кафе</div><button class="btn btn-primary btn-sm" onclick="openHandoffFlow()">📦 Передать курьеру</button><button class="btn btn-secondary btn-sm" onclick="adminSearchCourier('${order.id}')">🔍 Выставить в общий пул</button>${cancelBtn}</div>${blBtn}`;
  if (order.status==='searching_courier') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box info" style="font-size:13px">⏳ Ждём курьера из пула…</div><button class="btn btn-primary btn-sm" onclick="openHandoffFlow()">📦 Передать курьеру</button>${cancelBtn}</div>${blBtn}`;
  if (order.status==='courier_assigned') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box info" style="font-size:13px">🏃 <strong>${escHtml(order.courierName||'Курьер')}</strong> едет в кафе</div><button class="btn btn-success btn-sm" onclick="openHandoffFlow()">📦 Передать заказ курьеру</button>${cancelBtn}</div>${blBtn}`;
  if (order.status==='delivering') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box success">🚴 Курьер: <strong>${escHtml(order.courierName||'')}</strong></div>${cancelBtn}</div>${blBtn}`;
  if (order.status==='cancelled') {
    const byLabel = {client:'клиентом',operator:'оператором',admin:'администратором'}[order.cancelledBy]||'';
    return `<div class="alert-box danger">❌ Заказ отменён${byLabel?' '+byLabel:''}</div>${blBtn}`;
  }
  return blBtn;
}

async function adminAcceptOrder(orderId) {
  const mins=VENUE.deliveryTime||60;
  const patch={ status:'accepted', acceptedAt:new Date().toISOString(), operatorUid:STATE.uid, deliveryMinutes:mins, estimatedAt:new Date(Date.now()+mins*60000).toISOString(), clientNotification:{type:'accepted',seen:false} };
  await dbSet('orders',orderId,patch);
  _patchAllOrders(orderId,patch);
  tgHaptic('success'); closeOrderSheet(); showToast('Заказ принят','success'); loadOrders(_ordersTab);
}

async function adminCancelOrder(orderId) {
  const doCancel=async()=>{
    const patch={status:'cancelled',active:false,cancelledAt:new Date().toISOString(),cancelledBy:'admin',cancelledBotNotified:true,clientNotification:{type:'cancelled',seen:false,message:'Ваш заказ отменён администратором.'}};
    await dbSet('orders',orderId,patch); _patchAllOrders(orderId,patch);
    tgHaptic('light'); closeOrderSheet(); showToast('Заказ отменён','info'); loadOrders(_ordersTab);
  };
  if (tg?.showConfirm) tg.showConfirm('Отменить заказ?',ok=>{if(ok)doCancel();});
  else if (confirm('Отменить заказ?')) await doCancel();
}

async function adminSearchCourier(orderId) {
  const patch={status:'searching_courier',courierUid:null,courierName:null,courierBotNotified:false,searchStartedAt:new Date().toISOString()};
  await dbSet('orders',orderId,patch); _patchAllOrders(orderId,patch);
  tgHaptic('success'); showToast('Заказ выставлен в пул курьеров','success'); closeOrderSheet(); loadOrders(_ordersTab);
}

async function adminHandOverCourier(orderId) {
  const order=_allOrders.find(o=>o.id===orderId);
  const courierName=order?.courierName||'Курьер';
  const courierPhone=order?.courierPhone||'';
  // Note: delivering is still active — courier is on the way
  const patch={status:'delivering',handedOverAt:new Date().toISOString(),clientNotification:{type:'delivering',seen:false,message:`Курьер ${courierName}${courierPhone?' · '+courierPhone:''} везёт ваш заказ!`}};
  await dbSet('orders',orderId,patch); _patchAllOrders(orderId,patch);
  closeOrderSheet(); tgHaptic('success'); showToast(`Заказ передан курьеру ${courierName}`,'success'); loadOrders(_ordersTab);
}

async function adminMarkReadyForCourier(orderId) {
  const patch={ status:'ready_for_courier', readyForCourierAt:new Date().toISOString(), courierBotNotified:false };
  await dbSet('orders',orderId,patch); _patchAllOrders(orderId,patch);
  closeOrderSheet(); tgHaptic('success'); showToast('Заказ готов — курьеры заведения уведомлены','success'); loadOrders(_ordersTab);
}

async function adminMarkReady(orderId) {
  const patch={ status:'ready', readyAt:new Date().toISOString(), clientNotification:{type:'ready',seen:false,message:'Ваш заказ готов! Приходите забирать.'} };
  await dbSet('orders',orderId,patch); _patchAllOrders(orderId,patch);
  closeOrderSheet(); tgHaptic('success'); showToast('Заказ готов ✅','success'); loadOrders(_ordersTab);
}

async function adminIssueOrder(orderId) {
  const patch={ status:'issued', active:false, issuedAt:new Date().toISOString(), clientNotification:{type:'issued',seen:false,message:'Заказ выдан. Приятного аппетита!'} };
  await dbSet('orders',orderId,patch); _patchAllOrders(orderId,patch);
  closeOrderSheet(); tgHaptic('success'); showToast('Заказ выдан клиенту 📦','success'); loadOrders(_ordersTab);
}

// ══════════════════════════════════════════════════════════
//  HANDOFF FLOW (QR or manual)
// ══════════════════════════════════════════════════════════
function openHandoffFlow() {
  _handoffCourier=null; _handoffSelectedOrders.clear();
  document.getElementById('handoff-manual-wrap').style.display='none';
  document.getElementById('handoff-courier-found').style.display='none';
  document.getElementById('handoff-orders-section').style.display='none';
  document.getElementById('handoff-phone').value='';
  closeOrderSheet();
  _openSheet('courier-overlay');
}

function handoffEnterManual() {
  document.getElementById('handoff-manual-wrap').style.display='';
}

function handoffScanQr() {
  if (!tg?.showScanQrPopup) { showToast('QR-сканер доступен только в Telegram','warning'); return; }
  tg.showScanQrPopup({text:'Наведите камеру на QR-код телефона курьера'},async data=>{
    tg.closeScanQrPopup();
    const phone=normPhone(data||'');
    if (phone) {
      document.getElementById('handoff-phone').value=phone;
      document.getElementById('handoff-manual-wrap').style.display='';
      await findHandoffCourier();
    }
  });
}

async function findHandoffCourier() {
  if (!checkRateLimit('findHandoffCourier', 1, 3000)) { showToast('Слишком часто', 'warning'); return; }
  const phone=normPhone(document.getElementById('handoff-phone').value.trim());
  if (!phone) { showToast('Введите номер телефона','warning'); return; }
  const phoneKey=phone.replace(/\D/g,'');
  const link=await dbGet('uid_index',phoneKey);
  if (!link?.uid) { showToast('Курьер не найден','error'); return; }
  // Дыра №7: read from single couriers document
  const courier=await getCourier(link.uid);
  if (!courier) { showToast('Этот пользователь не является курьером','error'); return; }
  _handoffCourier={ ...courier, uid: link.uid };
  const foundEl=document.getElementById('handoff-courier-found');
  foundEl.style.display='';
  foundEl.innerHTML=`
    <div class="handoff-courier-found">
      <div class="handoff-courier-avatar">🚴</div>
      <div>
        <div style="font-weight:700;font-size:15px">${escHtml(courier.name||'Курьер')}</div>
        <div style="font-size:13px;color:var(--text-dim)">${escHtml(courier.phone||phone)}</div>
      </div>
    </div>`;

  // Дыра №5: Use already-loaded _allOrders (no extra Firestore query)
  const orders=_allOrders
    .filter(o=>['accepted','cooking','searching_courier','courier_assigned','ready_for_courier'].includes(o.status) && o.deliveryType!=='pickup');
  if (!orders.length) { showToast('Нет активных заказов для передачи','info'); return; }

  document.getElementById('handoff-orders-section').style.display='';
  const ordList=document.getElementById('handoff-orders-list');
  ordList.innerHTML=orders.map(o=>`
    <div class="handoff-order-row" id="ho_${o.id}" onclick="toggleHandoffOrder('${o.id}')">
      <div style="flex:1">
        <div style="font-weight:600;font-size:14px">#${(o.id||'').slice(-6)} — ${escHtml(o.clientName||'Клиент')}</div>
        <div style="font-size:12px;color:var(--text-dim)">${statusLabel(o.status)} · ${fmtPrice((o.total||0)+(o.deliveryPrice||0))}</div>
      </div>
      <div id="ho_chk_${o.id}" style="font-size:20px;color:var(--text-muted)">○</div>
    </div>`).join('');
}

function toggleHandoffOrder(orderId) {
  if (_handoffSelectedOrders.has(orderId)) {
    _handoffSelectedOrders.delete(orderId);
    document.getElementById('ho_'+orderId).classList.remove('selected');
    document.getElementById('ho_chk_'+orderId).textContent='○';
    document.getElementById('ho_chk_'+orderId).style.color='var(--text-muted)';
  } else {
    _handoffSelectedOrders.add(orderId);
    document.getElementById('ho_'+orderId).classList.add('selected');
    document.getElementById('ho_chk_'+orderId).textContent='●';
    document.getElementById('ho_chk_'+orderId).style.color='var(--primary)';
  }
}

async function confirmHandoff() {
  if (!_handoffCourier || !_handoffSelectedOrders.size) { showToast('Выберите заказы для передачи','warning'); return; }
  const cName=_handoffCourier.name||'Курьер';
  const cPhone=_handoffCourier.phone||'';
  for (const orderId of _handoffSelectedOrders) {
    const patch={ status:'delivering', courierUid:_handoffCourier.uid, courierName:cName, courierPhone:cPhone, handedOverAt:new Date().toISOString(), clientNotification:{type:'delivering',seen:false,message:`Курьер ${cName}${cPhone?' · '+cPhone:''} везёт ваш заказ!`} };
    await dbSet('orders',orderId,patch); _patchAllOrders(orderId,patch);
  }
  closeCourierSheet(); tgHaptic('success');
  showToast(`Передано курьеру ${cName}: ${_handoffSelectedOrders.size} заказов`,'success');
  loadOrders(_ordersTab);
}

function closeOrderSheet(e) {
  if (e && e.target!==document.getElementById('order-overlay')) return;
  document.getElementById('order-overlay').classList.remove('open');
}
function closeCourierSheet(e) {
  if (e && e.target!==document.getElementById('courier-overlay')) return;
  document.getElementById('courier-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  MANUAL ORDER
// ══════════════════════════════════════════════════════════
async function openManualOrder() {
  document.getElementById('mo-phone').value='';
  document.getElementById('mo-client-name').value='';
  document.getElementById('mo-street').value='';
  document.getElementById('mo-house').value='';
  document.getElementById('mo-apt').value='';
  document.getElementById('mo-amount').value='';
  document.getElementById('mo-comment').value='';
  document.getElementById('mo-autocomplete').style.display='none';
  _openSheet('manual-order-overlay');
}

// Дыра №11: search user_links only from localStorage — no full-collection Firestore read
function moPhoneInput(input) {
  const val = input.value.trim();
  const dd  = document.getElementById('mo-autocomplete');
  if (val.length < 7) { dd.style.display = 'none'; return; }
  const norm = val.replace(/\D/g, '');
  if (!norm) { dd.style.display = 'none'; return; }

  // Search localStorage keys that were cached by individual dbGet('user_links', uid) calls
  const matches = [];
  for (let i = 0; i < localStorage.length && matches.length < 5; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('vez_user_links_')) continue;
    try {
      const link = JSON.parse(localStorage.getItem(key));
      if (link && link.phone) {
        const ln = link.phone.replace(/\D/g, '');
        if (ln.includes(norm) || norm.includes(ln.slice(-7))) matches.push(link);
      }
    } catch {}
  }

  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.style.display = '';
  // C-2: Use data-* attributes to pass user-controlled values — no onclick injection risk
  dd.innerHTML = matches.map(l =>
    `<div class="autocomplete-item"
      data-phone="${escHtml(l.phone||'')}"
      data-name="${escHtml(l.firstName||'')}"
      data-uid="${escHtml(l.uid||'')}"
      onclick="moSelectClientFromEl(this)">
      <span style="font-family:monospace">${escHtml(l.phone||'')}</span>
      <span style="color:var(--text-dim)">${escHtml((l.firstName||'') + (l.lastName ? ' ' + l.lastName : ''))}</span>
    </div>`
  ).join('');
}

function moSelectClientFromEl(el) {
  moSelectClient(el.dataset.phone, el.dataset.name, el.dataset.uid);
}

async function moSelectClient(phone, name, uid) {
  document.getElementById('mo-phone').value=phone;
  document.getElementById('mo-client-name').value=name||'';
  document.getElementById('mo-autocomplete').style.display='none';
  if (uid) {
    try {
      const userData=await dbGet('users',uid);
      const addr=userData?.savedAddress;
      if (addr) {
        document.getElementById('mo-street').value=addr.street||'';
        document.getElementById('mo-house').value=addr.house||'';
        document.getElementById('mo-apt').value=addr.apt||'';
      }
    } catch {}
  }
}

async function submitManualOrder() {
  const phone=normPhone(document.getElementById('mo-phone').value.trim());
  const clientName=document.getElementById('mo-client-name').value.trim()||'Клиент (телефон)';
  const street=document.getElementById('mo-street').value.trim();
  const house=document.getElementById('mo-house').value.trim();
  const apt=document.getElementById('mo-apt').value.trim();
  const amount=parseInt(document.getElementById('mo-amount').value)||0;
  const payment=document.getElementById('mo-payment').value;
  const comment=document.getElementById('mo-comment').value.trim();
  if (!phone) { showToast('Введите телефон клиента','warning'); return; }
  if (!street||!house) { showToast('Введите улицу и дом','warning'); return; }
  if (!amount) { showToast('Введите сумму заказа','warning'); return; }
  const ordId=genOrderId();
  const _manDate=new Date().toISOString().slice(0,10);
  await dbSet('orders',ordId,{
    id:ordId, venueId:VENUE.id, venueName:VENUE.name,
    clientPhone:phone, clientName, clientUid:'manual_'+genId(),
    address:{street,house,apt}, payment, total:amount,
    deliveryPrice: VENUE.deliveryPrice || 0,
    items:[], comment,
    status:'accepted', isManual:true,
    active:true, venueDateKey:VENUE.id+'_'+_manDate,
    createdAt:new Date().toISOString(),
    acceptedAt:new Date().toISOString(),
    clientNotification:{type:'accepted',seen:false},
    adminBotNotified:true, courierBotNotified:false, cancelledBotNotified:false
  });
  closeManualOrder(); tgHaptic('success'); showToast('Заказ создан','success');
  await loadOrders('active');
}

function closeManualOrder(e) {
  if (e && e.target!==document.getElementById('manual-order-overlay')) return;
  document.getElementById('manual-order-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  QR SCAN FOR COURIER
// ══════════════════════════════════════════════════════════
function scanQrCourier() {
  if (!tg?.showScanQrPopup) { showToast('QR-сканер доступен только в Telegram','warning'); return; }
  tg.showScanQrPopup({text:'Наведите камеру на QR-код курьера'},data=>{
    tg.closeScanQrPopup();
    const phone=normPhone(data||'');
    if (phone) document.getElementById('courier-phone').value=phone;
  });
}

// ══════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════
async function loadStats() {
  const today = new Date().toISOString().slice(0,10);
  // Дыра №9: query only today's orders via venueDateKey — no full-collection scan
  const todayOrd = await dbQuery('orders', 'venueDateKey', '==', VENUE.id + '_' + today);
  const todayOnline    = todayOrd.filter(o=>!o.isManual);
  const todayDelivered = todayOrd.filter(o=>o.status==='delivered'||o.status==='issued');
  const todayCancelled = todayOrd.filter(o=>o.status==='cancelled');
  const todayReturns   = todayOrd.filter(o=>o.returnAt);
  const todayDelSum    = todayDelivered.reduce((s,o)=>s+(o.total||0)+(o.deliveryPrice||0),0);
  document.getElementById('stats-today-grid').innerHTML=`
    <div class="stat-card"><div class="stat-val">${todayOnline.length}</div><div class="stat-lbl">Заказы</div></div>
    <div class="stat-card"><div class="stat-val text-success">${todayDelivered.length}</div><div class="stat-lbl">Доставлено</div></div>
    <div class="stat-card"><div class="stat-val text-danger">${todayCancelled.length}</div><div class="stat-lbl">Отменено</div></div>
    <div class="stat-card"><div class="stat-val text-warning">${todayReturns.length}</div><div class="stat-lbl">Возвраты</div></div>
    <div class="stat-card" style="grid-column:span 2"><div class="stat-val text-primary">${fmtPrice(todayDelSum)}</div><div class="stat-lbl">Сумма доставок</div></div>`;

}

async function generateAdminReport() {
  if (!checkRateLimit('adminReport', 1, 300000)) { showToast('Отчёт можно формировать раз в 5 минут', 'warning'); return; }
  const repDate = document.getElementById('rep-date')?.value;
  if (!repDate) { showToast('Выберите дату','warning'); return; }
  const fromDate = repDate, toDate = repDate;
  const btn = document.querySelector('[onclick="generateAdminReport()"]');
  if (btn) { btn.disabled=true; btn.textContent='⏳ Формирую...'; }
  try {
    // Дыра №10: query only the specific date via venueDateKey — no full-collection scan
    const orders = await dbQuery('orders', 'venueDateKey', '==', VENUE.id + '_' + repDate);

    // Permanent couriers
    const permLinks = await dbQuery('courier_venue_links','venueId','==',VENUE.id);
    const permUids  = new Set(permLinks.filter(l=>l.status==='confirmed').map(l=>l.uid));

    const onlineOrd   = orders.filter(o=>!o.isManual);
    const manualOrd   = orders.filter(o=>o.isManual);
    const cancelled   = orders.filter(o=>o.status==='cancelled');
    const cancelCl    = cancelled.filter(o=>o.cancelledBy==='client');
    const cancelVen   = cancelled.filter(o=>o.cancelledBy==='admin'||o.cancelledBy==='operator');
    const returns     = orders.filter(o=>o.returnAt);
    const delivered   = orders.filter(o=>o.status==='delivered'||o.status==='issued');
    const delivPool   = delivered.filter(o=>o.courierUid&&!permUids.has(o.courierUid));
    const delivPerm   = delivered.filter(o=>o.courierUid&&permUids.has(o.courierUid));
    const delivSum    = delivered.reduce((s,o)=>s+(o.total||0)+(o.deliveryPrice||0),0);

    // Per courier
    const courierMap = {};
    for (const o of delivered) {
      if (!o.courierUid) continue;
      if (!courierMap[o.courierUid]) courierMap[o.courierUid]={ name:o.courierName||'—', phone:o.courierPhone||'', delivered:0, returns:0 };
      courierMap[o.courierUid].delivered++;
    }
    for (const o of returns) {
      const uid = o.returnedByUid; if (!uid) continue;
      if (!courierMap[uid]) courierMap[uid]={ name:o.returnedByName||'—', phone:o.courierPhone||'', delivered:0, returns:0 };
      courierMap[uid].returns++;
    }

    // TOP-10
    const itemFreq = {};
    for (const o of delivered) {
      for (const it of (o.items||[])) {
        const key=`${it.category||''}||${it.name}||${it.variantName||''}`;
        if (!itemFreq[key]) itemFreq[key]={ category:it.category||'', name:it.name, variant:it.variantName||'', count:0 };
        itemFreq[key].count += it.qty||1;
      }
    }
    const top10 = Object.values(itemFreq).sort((a,b)=>b.count-a.count).slice(0,10);

    const fmt = d => d.split('-').reverse().join('.');
    let rep = `Отчёт за: ${fmt(repDate)}\n\n`;
    rep += `Заказы Vezoo: ${onlineOrd.length}\n`;
    rep += `Созданные заведением: ${manualOrd.length}\n`;
    rep += `Отменённые заказы: ${cancelled.length}\n`;
    rep += `-Отменённые клиентами: ${cancelCl.length}\n`;
    rep += `-Отменённые заведением: ${cancelVen.length}\n`;
    rep += `Возвраты курьерами: ${returns.length}\n\n`;
    rep += `Доставлено: ${delivered.length}\n`;
    rep += `-Через поиск курьера: ${delivPool.length}\n`;
    rep += `-Постоянными курьерами: ${delivPerm.length}\n`;
    rep += `Сумма доставок: ${fmtPrice(delivSum)}\n`;
    const entries = Object.entries(courierMap);
    if (entries.length) {
      rep += '\n';
      for (const [,c] of entries) {
        rep += `\n${c.name} (${c.phone||'—'}):\n`;
        rep += `-Доставлено: ${c.delivered}\n`;
        rep += `-Возвраты: ${c.returns}\n`;
      }
    }
    if (top10.length) {
      rep += '\nТОП-10 позиций:\n';
      for (const it of top10) {
        const lbl = (it.category?it.category+' ':'')+it.name+(it.variant?' ('+it.variant+')':'');
        rep += `-${lbl} – ${it.count}\n`;
      }
    }
    document.getElementById('admin-report-text').textContent = rep;
    const out = document.getElementById('admin-report-output');
    out.style.display = 'flex';
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='📊 Сформировать отчёт'; }
  }
}

function copyAdminReport() {
  const text = document.getElementById('admin-report-text')?.textContent||'';
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(()=>showToast('Скопировано','success'));
  else { showToast('Скопировано','success'); }
}

// ══════════════════════════════════════════════════════════
//  SETTINGS SCREEN
// ══════════════════════════════════════════════════════════
async function loadSettingsScreen() {
  if (!VENUE) return;
  await loadPermCouriers();
  await loadBlacklist();
}

async function saveVenueInfo() {
  const name    =document.getElementById('set-name').value.trim();
  const address =document.getElementById('set-address').value.trim();
  const phone   =normPhone(document.getElementById('set-phone').value.trim());
  const desc    =document.getElementById('set-desc').value.trim();
  const cover   =document.getElementById('set-cover').value.trim()||_setCoverDataUrl||VENUE.coverUrl||'';
  if (!name||!address) { showToast('Введите название и адрес','warning'); return; }
  await dbSet('venues',VENUE.id,{ name,address,phone,description:desc,coverUrl:cover });
  VENUE={...VENUE,name,address,phone,description:desc,coverUrl:cover};
  bumpVersion('venues'); // Дыра №4
  tgHaptic('success'); showToast('Сохранено','success');
}

async function saveWorkHours() {
  const open=document.getElementById('set-open').value, close=document.getElementById('set-close').value;
  await dbSet('venues',VENUE.id,{workOpen:open,workClose:close});
  VENUE={...VENUE,workOpen:open,workClose:close};
  bumpVersion('venues'); // Дыра №4
  tgHaptic('success'); showToast('Часы сохранены','success');
}

async function saveDeliverySettings() {
  const delTime = parseInt(document.getElementById('set-delivery-time').value)||30;
  const minOrd  = parseInt(document.getElementById('set-min-order').value)||0;
  await dbSet('venues', VENUE.id, { deliveryTime: delTime, minOrder: minOrd, paymentMethods: _payMethods });
  VENUE = { ...VENUE, deliveryTime: delTime, minOrder: minOrd, paymentMethods: _payMethods };
  bumpVersion('venues'); // Дыра №4
  tgHaptic('success'); showToast('Настройки сохранены', 'success');
}

async function saveOnlineOrdersToggle(enabled) {
  if (!VENUE) return;
  await dbSet('venues', VENUE.id, { onlineOrdersEnabled: enabled });
  VENUE = { ...VENUE, onlineOrdersEnabled: enabled };
  bumpVersion('venues'); // Дыра №4
  tgHaptic('light');
  showToast(enabled ? 'Онлайн заказы включены' : 'Онлайн заказы выключены', 'info');
}

function _normPhone(p) { return String(p||'').replace(/\D/g,''); }
function _findLinkByPhone(links,phone) { const n=_normPhone(phone); return links.find(l=>_normPhone(l.phone)===n); }

async function addPermCourier() {
  // Управление постоянными курьерами — только суперадмин.
  showToast('Назначение курьеров выполняется суперадмином', 'info');
}

async function loadPermCouriers() {
  const links=await dbQuery('courier_venue_links','venueId','==',VENUE.id);
  const listEl=document.getElementById('perm-couriers-list');
  if (!links.length) { listEl.innerHTML='<div class="text-dim text-sm">Нет постоянных курьеров</div>'; return; }
  // Дыра №7: one read for all couriers instead of N individual reads
  const allCouriers=await getCourierAll();
  const rows=links.map(l=>{ const c=allCouriers[l.uid]; return {...l,courierName:c?.name||l.uid,phone:c?.phone||''}; });
  listEl.innerHTML=rows.map(r=>`
    <div class="flex items-center gap-2">
      <div class="li-icon yellow" style="width:34px;height:34px;font-size:16px">🚴</div>
      <div style="flex:1"><div class="font-bold text-sm">${escHtml(r.courierName)}</div><div class="text-xs text-dim">${escHtml(r.phone)} · ${r.status==='confirmed'?'<span class="text-success">Подтвердил</span>':'Ожидает'}</div></div>
      <button class="btn btn-xs" style="background:var(--danger-soft);color:var(--danger);border:none;padding:4px 8px;border-radius:6px;cursor:pointer" onclick="removePermCourier('${r.uid}')">×</button>
    </div>`).join('');
}

async function removePermCourier(uid) {
  // Управление постоянными курьерами — только суперадмин.
  showToast('Удаление курьеров выполняется суперадмином', 'info');
}

// ══════════════════════════════════════════════════════════
//  BLACKLIST
// ══════════════════════════════════════════════════════════
async function adminBlacklistClient(clientUid,clientPhone) {
  if (!confirm(`Добавить клиента (${clientPhone||clientUid}) в чёрный список?`)) return;
  await dbSet('venue_blacklist',VENUE.id+'_'+clientUid,{venueId:VENUE.id,clientUid,clientPhone,addedAt:new Date().toISOString(),adminUid:STATE.uid});
  tgHaptic('success'); showToast('Клиент добавлен в ЧС','success'); closeOrderSheet();
}

async function addToBlacklistByPhone() {
  const phone=document.getElementById('bl-phone').value.trim();
  if (!phone) { showToast('Введите телефон','warning'); return; }
  const phoneKey=normPhone(phone).replace(/\D/g,'');
  const link=await dbGet('uid_index',phoneKey);
  if (!link?.uid) { showToast('Пользователь не найден','error'); return; }
  await dbSet('venue_blacklist',VENUE.id+'_'+link.uid,{venueId:VENUE.id,clientUid:link.uid,clientPhone:link.phone,addedAt:new Date().toISOString(),adminUid:STATE.uid});
  document.getElementById('bl-phone').value='';
  tgHaptic('success'); showToast('Клиент добавлен в ЧС','success'); await loadBlacklist();
}

async function loadBlacklist() {
  const items=await dbQuery('venue_blacklist','venueId','==',VENUE.id);
  const listEl=document.getElementById('blacklist-items'); if (!listEl) return;
  if (!items.length) { listEl.innerHTML='<div class="text-dim text-sm">Чёрный список пуст</div>'; return; }
  listEl.innerHTML=items.map(b=>`
    <div class="flex items-center gap-2">
      <div style="flex:1"><div class="font-bold text-sm">${escHtml(b.clientPhone||b.clientUid)}</div><div class="text-xs text-dim">${fmtDate(b.addedAt)}</div></div>
      <button class="btn btn-xs" style="background:var(--danger-soft);color:var(--danger);border:none;padding:4px 8px;border-radius:6px;cursor:pointer" onclick="removeFromBlacklist('${b.venueId}_${b.clientUid}')">×</button>
    </div>`).join('');
}

async function removeFromBlacklist(blId) {
  await dbDelete('venue_blacklist',blId); showToast('Клиент удалён из ЧС','info'); await loadBlacklist();
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
function _initAdminBackButton() {
  if (!tg?.BackButton) return;
  tg.BackButton.onClick(()=>{
    const open=document.querySelector('.overlay.open');
    if (open) { open.classList.remove('open'); if (!document.querySelector('.overlay.open')) tg.BackButton.hide(); return; }
    tg.BackButton.hide();
  });
}
function _openSheet(id) { document.getElementById(id)?.classList.add('open'); tg?.BackButton?.show(); }
function adminNavTo(screenId) { showScreen(screenId); }
function setNav(el) { document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active')); if (el) el.classList.add('active'); }
