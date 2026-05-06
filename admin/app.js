'use strict';
/* ============================================================
   VEZOO ADMIN — Venue Admin Mini App
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUE           = null;
let MENU_ITEMS      = [];
let MENU_CATS       = [];
let ALL_CATS        = [];
let ALL_CITIES      = [];
let _editItemId     = null;
let _variants       = [];
let _hasVariants    = false;
let _ordersUnsub    = null;
let _coverDataUrl   = null;
let _itemImgDataUrl = null;
let _setCoverDataUrl = null;
let _pinBuffer      = '';
let _ordersTab      = 'active';
let _handoffCourier = null;
let _handoffSelectedOrders = new Set();
let _payMethods     = { cash: true, card: true };
let _cvPayMethods   = { cash: true, card: true };

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

  // Гарантированно скрываем splash в любом исходе
  const _hideSplash = () => {
    const el = document.getElementById('s-splash');
    if (el) el.style.display = 'none';
  };

  try {
    const urlUid = readUidFromUrl();
    if (urlUid) { STATE.uid = urlUid; saveState(); }
    await initFirebase();
    if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
    if (!STATE.uid) { _hideSplash(); showScreen('s-no-uid'); return; }

    const existing = await dbGet('users', STATE.uid);
    if (existing?.blocked) { _hideSplash(); showScreen('s-blocked'); return; }
    if (!existing?.agreedAdmin) { showAgreement(); return; }

    if (existing && !existing.name) {
      const autoName = _getTgName() || existing.firstName || 'Администратор';
      await dbSet('users', STATE.uid, { name: autoName });
      existing.name = autoName;
    }
    STATE.user = existing; saveState();
    showPinScreen();
  } catch (err) {
    console.error('[BOOT]', err);
    _hideSplash();
    showScreen('s-no-uid');
  }
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
  const el = document.getElementById('s-agree');
  if (el) el.style.display = '';   // снимаем inline display:none, дальше управляет showScreen
  showScreen('s-agree');
}

async function submitAgree() {
  const btn = document.getElementById('agree-btn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  try {
    const linkData = await dbGet('user_links', STATE.uid);
    const autoName = _getTgName() || linkData?.firstName || 'Администратор';
    const existing = await dbGet('users', STATE.uid);
    // Сохраняем поля бота (role, status), добавляем agreedAdmin
    STATE.user = {
      uid: STATE.uid,
      name: autoName,
      phone: linkData?.phone || existing?.phone || '',
      tgId: linkData?.tgId || existing?.tgId || '',
      role: existing?.role || 'admin',
      status: existing?.status || 'active',
      agreedAdmin: true,
      createdAt: existing?.createdAt || new Date().toISOString()
    };
    await dbSet('users', STATE.uid, STATE.user);
    saveState();
  } catch (err) {
    console.error('[submitAgree]', err);
    if (!STATE.user) STATE.user = { name: 'Администратор', role: 'admin', agreedAdmin: true };
  }
  if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  document.getElementById('s-agree').style.display = 'none';
  showPinScreen();
}

async function onboardSubmit() { await checkVenueAndInit(); }

// ══════════════════════════════════════════════════════════
//  PIN CODE
// ══════════════════════════════════════════════════════════
function showPinScreen() {
  const pin = document.getElementById('s-pin');
  if (pin) pin.style.display = '';   // снимаем inline display:none
  showScreen('s-pin');
  _pinBuffer = '';
  updatePinDots();
  document.getElementById('pin-sub-text').textContent = 'Введите PIN-код';
}

function pinInput(digit) {
  if (_pinBuffer.length >= 4) return;
  tgHaptic('light');
  _pinBuffer += digit;
  updatePinDots();
  if (_pinBuffer.length === 4) setTimeout(checkPin, 80);
}

function pinDelete() {
  if (!_pinBuffer.length) return;
  _pinBuffer = _pinBuffer.slice(0, -1);
  updatePinDots();
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('pd' + i);
    if (!dot) continue;
    dot.classList.toggle('filled', i < _pinBuffer.length);
    dot.classList.remove('error');
  }
}

async function checkPin() {
  const ok = await verifyPin('admin', _pinBuffer);
  if (ok) {
    await checkVenueAndInit();
  } else {
    tgHaptic('error');
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById('pd' + i);
      if (dot) { dot.classList.add('error'); dot.classList.remove('filled'); }
    }
    document.getElementById('pin-sub-text').textContent = 'Неверный PIN. Попробуйте снова';
    setTimeout(() => { _pinBuffer = ''; updatePinDots(); document.getElementById('pin-sub-text').textContent = 'Введите PIN-код'; }, 900);
  }
}

async function changeAdminPin() {
  const val = (document.getElementById('new-pin-input')?.value || '').trim();
  if (val.length !== 4 || !/^\d{4}$/.test(val)) { showToast('PIN должен быть 4 цифры', 'warning'); return; }
  await savePin('admin', val);
  document.getElementById('new-pin-input').value = '';
  tgHaptic('success'); showToast('PIN изменён', 'success');
}

// ══════════════════════════════════════════════════════════
//  VENUE CHECK
// ══════════════════════════════════════════════════════════
async function checkVenueAndInit() {
  [ALL_CATS, ALL_CITIES] = await Promise.all([
    dbGetAll('categories','order','asc'),
    getAllCities()
  ]);
  const venues = await dbQuery('venues','ownerId','==',STATE.uid);
  VENUE = venues[0] || null;
  if (!VENUE) { showCreateVenueForm(); return; }
  if (VENUE.status === 'pending')  { showScreen('s-pending');  return; }
  if (VENUE.status === 'rejected') { showScreen('s-rejected'); return; }
  initMain();
}

async function checkVenueStatus() { await checkVenueAndInit(); }

function showCreateVenueForm() {
  const sel = document.getElementById('cv-cat');
  sel.innerHTML = '<option value="">Выберите категорию...</option>' + ALL_CATS.map(c=>`<option value="${c.id}">${c.icon||''} ${c.name}</option>`).join('');
  _populateCitySelect('cv-city', '');
  showScreen('s-create-venue');
}

function _populateCitySelect(selId, currentCityId) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  // Group by country
  const byCountry = {};
  ALL_CITIES.forEach(c => {
    if (!byCountry[c.countryId]) byCountry[c.countryId] = [];
    byCountry[c.countryId].push(c);
  });
  let html = '<option value="">Выберите город...</option>';
  Object.entries(byCountry).forEach(([cid, cities]) => {
    const country = cities[0];
    html += `<optgroup label="— ${cities[0]?.countryName||cid} —">`;
    cities.forEach(city => {
      html += `<option value="${city.id}" ${city.id === currentCityId ? 'selected' : ''}>${city.name}</option>`;
    });
    html += '</optgroup>';
  });
  // Fallback if no countries grouping available — just list cities
  if (!html.includes('<option value="')) {
    html = '<option value="">Выберите город...</option>' + ALL_CITIES.map(c => `<option value="${c.id}" ${c.id===currentCityId?'selected':''}>${c.name}</option>`).join('');
  }
  sel.innerHTML = html;
}

function previewCover(input, wrapId) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    if (wrapId === 'cv-cover-upload') _coverDataUrl = dataUrl;
    else _setCoverDataUrl = dataUrl;
    const wrap = document.getElementById(wrapId);
    const fileId = wrapId === 'cv-cover-upload' ? 'cv-cover-file' : 'set-cover-file';
    wrap.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"><input type="file" id="${fileId}" accept="image/*" onchange="previewCover(this,'${wrapId}')" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  };
  reader.readAsDataURL(file);
}

function togglePayTag(btnId, method) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const store = btnId.startsWith('cv-') ? _cvPayMethods : _payMethods;
  store[method] = !store[method];
  btn.classList.toggle('active-cash', method === 'cash' && store[method]);
  btn.classList.toggle('active-card', method === 'card' && store[method]);
  if (!store[method]) btn.className = 'pay-tag';
}

async function submitCreateVenue() {
  const name    = document.getElementById('cv-name').value.trim();
  const catId   = document.getElementById('cv-cat').value;
  const desc    = document.getElementById('cv-desc').value.trim();
  const cityId  = document.getElementById('cv-city').value;
  const address = document.getElementById('cv-address').value.trim();
  const phone   = normPhone(document.getElementById('cv-phone').value.trim());
  const open    = document.getElementById('cv-work-open').value;
  const close   = document.getElementById('cv-work-close').value;
  const delTime = parseInt(document.getElementById('cv-delivery-time').value)||30;
  const cookT   = parseInt(document.getElementById('cv-cooking-time').value)||20;
  const minOrd  = parseInt(document.getElementById('cv-min-order').value)||0;
  const coverUrl = document.getElementById('cv-cover-url').value.trim() || _coverDataUrl || '';
  if (!name || !catId || !address) { showToast('Заполните обязательные поля', 'warning'); return; }

  const city = ALL_CITIES.find(c => c.id === cityId);
  const delPrice = city?.deliveryPrice ?? 1000;

  const btn = document.getElementById('cv-btn');
  btn.disabled = true; btn.textContent = 'Отправляем...';
  const venueId = genId();
  await dbSet('venues', venueId, {
    id: venueId, name, categoryId: catId, description: desc, address, phone,
    cityId: cityId||'', cityName: city?.name||'',
    workOpen: open, workClose: close, deliveryTime: delTime, deliveryPrice: delPrice,
    cookingTime: cookT, minOrder: minOrd, coverUrl,
    paymentMethods: _cvPayMethods,
    ownerId: STATE.uid, ownerName: STATE.user?.name||'',
    status: 'pending', rating: 0, reviewCount: 0, blocked: false,
    createdAt: new Date().toISOString()
  });
  tgHaptic('success');
  showScreen('s-pending');
  btn.disabled = false; btn.textContent = 'Отправить на модерацию';
}

function resetVenueAndCreate() { VENUE = null; showCreateVenueForm(); }

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
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
  MENU_ITEMS = await dbQuery('menu_items','venueId','==',VENUE.id);
  MENU_CATS  = [...new Set(MENU_ITEMS.map(i => i.category).filter(Boolean))];
  renderMenuCatTabs();
  renderMenuItems(null);
  _refreshCatSelect();
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
      ? item.variants.map(v=>`${v.name}: ${fmtPrice(v.price)}`).join('<br>')
      : fmtPrice(item.price);
    const imgEl = item.imageUrl
      ? `<div class="admin-item-img"><img src="${item.imageUrl}" onerror="this.parentElement.innerHTML='<span style=font-size:26px>${item.emoji||'🍽️'}</span>'"></div>`
      : `<div class="admin-item-img"><span style="font-size:26px">${item.emoji||'🍽️'}</span></div>`;
    const ingChips = item.ingredients?.length
      ? `<div class="ingredients-row">${item.ingredients.slice(0,3).map(x=>`<span class="ingredient-chip">${x}</span>`).join('')}${item.ingredients.length>3?`<span class="ingredient-chip">+${item.ingredients.length-3}</span>`:''}</div>` : '';
    return `
      <div class="admin-item">
        ${imgEl}
        <div class="admin-item-body">
          <div class="admin-item-name">${item.name}${item.available===false?' <span class="badge badge-cancelled" style="font-size:10px;padding:2px 6px">Скрыт</span>':''}</div>
          <div class="admin-item-price">${priceStr}</div>
          ${item.category?`<div class="text-xs text-dim" style="margin-top:2px">${item.category}</div>`:''}
          ${ingChips}
        </div>
        <div class="admin-item-actions">
          <button class="btn btn-icon btn-ghost" onclick="openEditItem('${item.id}')">✏️</button>
          <button class="btn btn-icon btn-danger" onclick="deleteItem('${item.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

function openAddItem() {
  _editItemId=null; _variants=[]; _hasVariants=false; _itemImgDataUrl=null;
  document.getElementById('item-sheet-title').textContent='Добавить позицию';
  document.getElementById('it-name').value='';
  document.getElementById('it-emoji').value='';
  document.getElementById('it-desc').value='';
  document.getElementById('it-img-url').value='';
  document.getElementById('it-price').value='';
  document.getElementById('it-ingredients').value='';
  _refreshCatSelect();
  document.getElementById('it-cat-custom').style.display='none';
  document.getElementById('it-available').checked=true;
  document.getElementById('it-img-upload').innerHTML=`<input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)"><span class="img-upload-txt">📷 Загрузить фото</span>`;
  document.getElementById('variants-check-box').textContent='';
  document.getElementById('simple-price-wrap').style.display='';
  document.getElementById('variants-wrap').style.display='none';
  document.getElementById('variants-list').innerHTML='';
  _openSheet('item-overlay');
}

async function openEditItem(itemId) {
  const item = MENU_ITEMS.find(i=>i.id===itemId);
  if (!item) return;
  _editItemId=itemId; _variants=[...(item.variants||[])]; _hasVariants=_variants.length>0; _itemImgDataUrl=null;
  document.getElementById('item-sheet-title').textContent='Редактировать позицию';
  document.getElementById('it-name').value=item.name||'';
  document.getElementById('it-emoji').value=item.emoji||'';
  document.getElementById('it-desc').value=item.description||'';
  document.getElementById('it-img-url').value=item.imageUrl||'';
  document.getElementById('it-price').value=item.price||'';
  document.getElementById('it-ingredients').value=(item.ingredients||[]).join(', ');
  document.getElementById('it-available').checked=item.available!==false;
  _refreshCatSelect(item.category||'');
  if (item.imageUrl) {
    document.getElementById('it-img-upload').innerHTML=`<img src="${item.imageUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  } else {
    document.getElementById('it-img-upload').innerHTML=`<input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)"><span class="img-upload-txt">📷 Загрузить фото</span>`;
  }
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

function previewItemImg(input) {
  const file=input.files[0]; if (!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    _itemImgDataUrl=e.target.result;
    const wrap=document.getElementById('it-img-upload');
    wrap.innerHTML=`<img src="${_itemImgDataUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><input type="file" id="it-img-file" accept="image/*" onchange="previewItemImg(this)" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  };
  reader.readAsDataURL(file);
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
      <div class="field"><label>Вариант</label><input class="inp" value="${v.name}" placeholder="Маленький" oninput="_variants[${i}].name=this.value"></div>
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
  const imgUrl = document.getElementById('it-img-url').value.trim()||_itemImgDataUrl||'';
  const avail = document.getElementById('it-available').checked;
  const ingRaw = document.getElementById('it-ingredients').value.trim();
  const ingredients = ingRaw ? ingRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
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
  await dbSet('menu_items',itemId,{
    id:itemId, venueId:VENUE.id, name, category:cat, emoji, description:desc,
    imageUrl:imgUrl, price, variants, ingredients, available:avail, createdAt:new Date().toISOString()
  });
  document.getElementById('item-overlay').classList.remove('open');
  btn.disabled=false;
  tgHaptic('success');
  showToast(_editItemId?'Позиция обновлена':'Позиция добавлена','success');
  await loadMenuItems();
}

async function deleteItem(itemId) {
  if (!confirm('Удалить позицию из меню?')) return;
  await dbDelete('menu_items',itemId);
  tgHaptic('light');
  await loadMenuItems();
}

// ══════════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════════
function watchNewOrders() {
  _ordersUnsub=onQuerySnap('orders','venueId','==',VENUE.id,orders=>{
    const pending=orders.filter(o=>o.status==='pending').length;
    const badge=document.getElementById('orders-badge');
    badge.textContent=pending; badge.classList.toggle('hidden',pending===0);
    if (_ordersTab==='active' && document.getElementById('s-orders').classList.contains('active'))
      renderOrdersList(orders.filter(o=>['pending','accepted','cooking','searching_courier','courier_assigned','delivering'].includes(o.status)));
  });
}

async function loadOrders(tab,el) {
  _ordersTab=tab;
  if (el) { document.querySelectorAll('#s-orders .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  const list=document.getElementById('admin-orders-list');
  list.innerHTML='<div class="loader"><div class="spinner"></div></div>';
  let orders=await dbQuery('orders','venueId','==',VENUE.id);
  if (tab==='active')
    orders=orders.filter(o=>['pending','accepted','cooking','searching_courier','courier_assigned','delivering'].includes(o.status));
  else if (tab==='pending')
    orders=orders.filter(o=>o.status==='pending');
  else {
    orders=orders.filter(o=>['delivered','cancelled'].includes(o.status));
    orders=orders.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,80);
  }
  renderOrdersList(orders);
}

function renderOrdersList(orders) {
  const list=document.getElementById('admin-orders-list');
  if (!orders.length) { list.innerHTML='<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Заказов нет</div></div>'; return; }
  list.innerHTML=orders.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(o=>`
    <div class="order-card" onclick="openOrderDetail('${o.id}')" style="cursor:pointer">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">${o.clientName||'Клиент'}${o.isManual?` <span class="badge badge-accepted" style="font-size:10px">📞</span>`:''}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id||'').slice(-6)}</div></div>
        <div style="text-align:right"><span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span><div style="font-weight:700;font-size:15px;color:var(--primary);margin-top:3px">${fmtPrice(o.total)}</div></div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items||[]).map(i=>`${i.emoji||'🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
        ${o.address?`<div class="text-sm text-dim mt-1">📍 ${o.address.street||o.address} ${o.address.house||''}${o.address.apt?', кв.'+o.address.apt:''}</div>`:''}
      </div>
    </div>`).join('');
}

async function openOrderDetail(orderId) {
  const orders=await dbQuery('orders','venueId','==',VENUE.id);
  const order=orders.find(o=>o.id===orderId);
  if (!order) return;
  const addr=order.address;
  const addrStr=typeof addr==='string'?addr:(addr?((`${addr.street||''} ${addr.house||''}${addr.apt?', кв.'+addr.apt:''}`).trim()||'—'):'—');
  const callBtn=order.clientPhone?`<a href="tel:${normPhone(order.clientPhone)}" class="btn-call">📞 Позвонить клиенту</a>`:'';
  const content=document.getElementById('order-detail-content');
  content.innerHTML=`
    <div class="flex justify-between items-center" style="margin-bottom:12px">
      <div><div class="font-bold" style="font-size:16px">Заказ #${(order.id||'').slice(-6)}</div><div class="order-id">${fmtDate(order.createdAt)}</div></div>
      <span class="${statusBadgeClass(order.status)}">${statusLabel(order.status)}</span>
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Клиент</span><span class="font-bold">${order.clientName||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${order.clientPhone||'—'}</span></div>
      ${callBtn?`<div>${callBtn}</div>`:''}
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${order.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addrStr}</span></div>
      ${order.comment?`<div class="flex justify-between"><span class="text-dim">Комментарий</span><span style="text-align:right;max-width:60%">${order.comment}</span></div>`:''}
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав</div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      ${(order.items||[]).map(it=>`<div class="flex justify-between"><span>${it.emoji||'🍽️'} ${it.name}${it.variantName?' ('+it.variantName+')':''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
      <div class="divider"></div>
      ${order.deliveryPrice?`<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(order.deliveryPrice)}</span></div>`:''}
      <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice(order.total+(order.deliveryPrice||0))}</span></div>
    </div>
    ${renderAdminOrderActions(order)}`;
  _openSheet('order-overlay');
}

function renderAdminOrderActions(order) {
  const blBtn=order.clientUid?`<button class="btn btn-ghost btn-sm" style="margin-top:8px;color:var(--danger)" onclick="adminBlacklistClient('${order.clientUid}','${(order.clientPhone||'').replace(/'/g,'')}')">🚫 В чёрный список</button>`:'';
  const cancelBtn=`<button class="btn btn-danger btn-sm" onclick="adminCancelOrder('${order.id}')">❌ Отменить</button>`;
  if (order.status==='pending') return `<div class="btn-row">${cancelBtn}<button class="btn btn-success btn-sm" onclick="adminAcceptOrder('${order.id}')">✅ Принять</button></div>${blBtn}`;
  if (order.status==='accepted'||order.status==='cooking') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="adminSearchCourier('${order.id}')">🔍 Искать курьера</button><button class="btn btn-primary btn-sm" onclick="openHandoffFlow()">📦 Передать</button></div>${cancelBtn}</div>${blBtn}`;
  if (order.status==='searching_courier') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box info" style="font-size:13px">⏳ Ждём курьера…</div><button class="btn btn-primary btn-sm" onclick="openHandoffFlow()">📦 Передать курьеру</button>${cancelBtn}</div>${blBtn}`;
  if (order.status==='courier_assigned') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box info" style="font-size:13px">🏃 <strong>${order.courierName||'Курьер'}</strong> едет в кафе</div><button class="btn btn-success btn-sm" onclick="adminHandOverCourier('${order.id}')">📦 Передать заказ курьеру</button>${cancelBtn}</div>${blBtn}`;
  if (order.status==='delivering') return `<div style="display:flex;flex-direction:column;gap:8px"><div class="alert-box success">🚴 Курьер: <strong>${order.courierName||''}</strong></div>${cancelBtn}</div>${blBtn}`;
  return blBtn;
}

async function adminAcceptOrder(orderId) {
  const mins=VENUE.deliveryTime||60;
  await dbSet('orders',orderId,{ status:'accepted', acceptedAt:new Date().toISOString(), operatorUid:STATE.uid, deliveryMinutes:mins, estimatedAt:new Date(Date.now()+mins*60000).toISOString(), clientNotification:{type:'accepted',seen:false} });
  tgHaptic('success'); closeOrderSheet(); showToast('Заказ принят','success');
  await loadOrders(_ordersTab);
}

async function adminCancelOrder(orderId) {
  const doCancel=async()=>{ await dbSet('orders',orderId,{status:'cancelled',cancelledAt:new Date().toISOString(),clientNotification:{type:'cancelled',seen:false}}); tgHaptic('light'); closeOrderSheet(); showToast('Заказ отменён','info'); await loadOrders(_ordersTab); };
  if (tg?.showConfirm) tg.showConfirm('Отменить заказ?',ok=>{if(ok)doCancel();});
  else if (confirm('Отменить заказ?')) await doCancel();
}

async function adminSearchCourier(orderId) {
  await dbSet('orders',orderId,{status:'searching_courier',courierUid:null,courierName:null,searchStartedAt:new Date().toISOString()});
  tgHaptic('success'); showToast('Курьеры уведомлены','success'); closeOrderSheet(); await loadOrders(_ordersTab);
}

async function adminHandOverCourier(orderId) {
  const orders=await dbQuery('orders','venueId','==',VENUE.id);
  const order=orders.find(o=>o.id===orderId);
  const courierName=order?.courierName||'Курьер';
  await dbSet('orders',orderId,{status:'delivering',handedOverAt:new Date().toISOString(),clientNotification:{type:'delivering',seen:false,message:`Курьер ${courierName} везёт ваш заказ!`}});
  closeOrderSheet(); tgHaptic('success'); showToast(`Заказ передан курьеру ${courierName}`,'success');
  await loadOrders(_ordersTab);
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
  document.getElementById('handoff-warn').style.display='none';
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
  const phone=normPhone(document.getElementById('handoff-phone').value.trim());
  if (!phone) { showToast('Введите номер телефона','warning'); return; }
  const links=await dbGetAll('user_links');
  const link=links.find(l=>normPhone(l.phone)===phone);
  if (!link) { showToast('Курьер не найден','error'); return; }
  const courier=await dbGet('couriers',link.uid);
  if (!courier) { showToast('Этот пользователь не является курьером','error'); return; }
  _handoffCourier=courier;
  const foundEl=document.getElementById('handoff-courier-found');
  foundEl.style.display='';
  foundEl.innerHTML=`
    <div class="handoff-courier-found">
      <div class="handoff-courier-avatar">🚴</div>
      <div>
        <div style="font-weight:700;font-size:15px">${courier.name||'Курьер'}</div>
        <div style="font-size:13px;color:var(--text-dim)">${courier.phone||phone}</div>
        <div style="font-size:12px;color:${courier.onShift?'var(--success)':'var(--text-muted)'}">${courier.onShift?'На смене':'Офлайн'}</div>
      </div>
    </div>`;

  // Load active orders
  const orders=(await dbQuery('orders','venueId','==',VENUE.id))
    .filter(o=>['accepted','cooking','searching_courier','courier_assigned'].includes(o.status));
  if (!orders.length) { showToast('Нет активных заказов для передачи','info'); return; }

  document.getElementById('handoff-orders-section').style.display='';
  const ordList=document.getElementById('handoff-orders-list');
  ordList.innerHTML=orders.map(o=>`
    <div class="handoff-order-row" id="ho_${o.id}" onclick="toggleHandoffOrder('${o.id}','${(o.courierUid||'')}')">
      <div style="flex:1">
        <div style="font-weight:600;font-size:14px">#${(o.id||'').slice(-6)} — ${o.clientName||'Клиент'}</div>
        <div style="font-size:12px;color:var(--text-dim)">${statusLabel(o.status)} · ${fmtPrice(o.total)}</div>
      </div>
      <div id="ho_chk_${o.id}" style="font-size:20px;color:var(--text-muted)">○</div>
    </div>`).join('');
}

function toggleHandoffOrder(orderId, existingCourierUid) {
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
    // Warn if order already assigned to different courier
    if (existingCourierUid && existingCourierUid !== _handoffCourier?.uid) {
      const warnEl=document.getElementById('handoff-warn');
      warnEl.style.display=''; warnEl.textContent='⚠️ Один из заказов уже назначен другому курьеру. Переназначение отменит предыдущее назначение.';
    }
  }
}

async function confirmHandoff() {
  if (!_handoffCourier || !_handoffSelectedOrders.size) { showToast('Выберите заказы для передачи','warning'); return; }
  const cName=_handoffCourier.name||'Курьер';
  for (const orderId of _handoffSelectedOrders) {
    await dbSet('orders',orderId,{ status:'delivering', courierUid:_handoffCourier.uid, courierName:cName, handedOverAt:new Date().toISOString(), clientNotification:{type:'delivering',seen:false,message:`Курьер ${cName} везёт ваш заказ!`} });
  }
  closeCourierSheet(); tgHaptic('success');
  showToast(`Передано курьеру ${cName}: ${_handoffSelectedOrders.size} заказов`,'success');
  await loadOrders(_ordersTab);
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
let _moCart = {};

async function openManualOrder() {
  _moCart={};
  document.getElementById('mo-phone').value='';
  document.getElementById('mo-client-name').value='';
  document.getElementById('mo-address').value='';
  document.getElementById('mo-autocomplete').style.display='none';
  document.getElementById('mo-selected-items').innerHTML='';
  document.getElementById('mo-total').textContent=fmtPrice(0);

  // Load menu for this venue
  if (!MENU_ITEMS.length) MENU_ITEMS=await dbQuery('menu_items','venueId','==',VENUE.id);
  const cats=[...new Set(MENU_ITEMS.map(i=>i.category).filter(Boolean))];
  document.getElementById('mo-cats-tabs').innerHTML=
    ['Все',...cats].map((c,i)=>`<button class="cat-tab${i===0?' active':''}" onclick="moFilterItems(this,'${c}')">${c}</button>`).join('');
  moFilterItems(null,'Все');
  _openSheet('manual-order-overlay');
}

function moFilterItems(el,cat) {
  if(el){document.querySelectorAll('#mo-cats-tabs .cat-tab').forEach(b=>b.classList.remove('active'));el.classList.add('active');}
  const items=cat==='Все'?MENU_ITEMS:MENU_ITEMS.filter(i=>i.category===cat);
  document.getElementById('mo-items-list').innerHTML=items.filter(i=>i.available!==false).map(item=>`
    <div class="flex items-center gap-2" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1"><div style="font-weight:600;font-size:13px">${item.emoji||'🍽️'} ${item.name}</div><div style="font-size:12px;color:var(--primary)">${item.variants?.length?item.variants.map(v=>`${v.name}: ${fmtPrice(v.price)}`).join(' / '):fmtPrice(item.price)}</div></div>
      <button class="btn btn-primary btn-xs" onclick="moAddItem('${item.id}')">+</button>
    </div>`).join('');
}

function moAddItem(itemId) {
  const item=MENU_ITEMS.find(i=>i.id===itemId);
  if (!item) return;
  const price=item.variants?.length ? item.variants[0].price : item.price;
  if (_moCart[itemId]) { _moCart[itemId].qty++; }
  else { _moCart[itemId]={...item, qty:1, unitPrice:price}; }
  moRenderCart(); tgHaptic('light');
}

function moRemoveItem(itemId) {
  if (!_moCart[itemId]) return;
  _moCart[itemId].qty--;
  if (_moCart[itemId].qty<=0) delete _moCart[itemId];
  moRenderCart();
}

function moRenderCart() {
  const items=Object.values(_moCart);
  const total=items.reduce((s,i)=>s+i.unitPrice*i.qty,0);
  document.getElementById('mo-total').textContent=fmtPrice(total);
  document.getElementById('mo-selected-items').innerHTML=items.map(it=>`
    <div class="manual-order-item">
      <span class="manual-order-name">${it.emoji||'🍽️'} ${it.name} ×${it.qty}</span>
      <span class="manual-order-price">${fmtPrice(it.unitPrice*it.qty)}</span>
      <button class="btn btn-icon" style="width:28px;height:28px;font-size:14px;background:var(--danger-soft);color:var(--danger);border:none;border-radius:8px;cursor:pointer" onclick="moRemoveItem('${it.id}')">−</button>
    </div>`).join('')||'<div class="text-dim text-sm" style="padding:4px 0">Ничего не добавлено</div>';
}

async function moPhoneInput(input) {
  const val=input.value.trim();
  if (val.length<7) { document.getElementById('mo-autocomplete').style.display='none'; return; }
  // Search known clients
  const norm=normPhone(val);
  const links=await dbGetAll('user_links');
  const matches=links.filter(l=>normPhone(l.phone||'').includes(norm.replace('+',''))).slice(0,5);
  const dd=document.getElementById('mo-autocomplete');
  if (!matches.length) { dd.style.display='none'; return; }
  dd.style.display='';
  dd.innerHTML=matches.map(l=>`<div class="autocomplete-item" onclick="moSelectClient('${(l.phone||'').replace(/'/g,'')}','${(l.firstName||'').replace(/'/g,'')}')"><span style="font-family:monospace">${l.phone}</span> <span style="color:var(--text-dim)">${l.firstName||''} ${l.lastName||''}</span></div>`).join('');
}

function moSelectClient(phone, name) {
  document.getElementById('mo-phone').value=phone;
  document.getElementById('mo-client-name').value=name||'';
  document.getElementById('mo-autocomplete').style.display='none';
}

async function submitManualOrder() {
  const phone=normPhone(document.getElementById('mo-phone').value.trim());
  const clientName=document.getElementById('mo-client-name').value.trim()||'Клиент (телефон)';
  const address=document.getElementById('mo-address').value.trim();
  const payment=document.getElementById('mo-payment').value;
  if (!phone) { showToast('Введите телефон клиента','warning'); return; }
  if (!address) { showToast('Введите адрес','warning'); return; }
  const items=Object.values(_moCart);
  if (!items.length) { showToast('Добавьте хотя бы одну позицию','warning'); return; }
  const total=items.reduce((s,i)=>s+i.unitPrice*i.qty,0);
  const ordId=genOrderId();
  await dbSet('orders',ordId,{
    id:ordId, venueId:VENUE.id, venueName:VENUE.name,
    clientPhone:phone, clientName, clientUid:'manual_'+genId(),
    address:{street:address}, payment, total,
    items:items.map(i=>({id:i.id,name:i.name,emoji:i.emoji||'🍽️',qty:i.qty,price:i.unitPrice})),
    status:'accepted', isManual:true,
    createdAt:new Date().toISOString(),
    acceptedAt:new Date().toISOString(),
    clientNotification:{type:'accepted',seen:false}
  });
  closeManualOrder(); tgHaptic('success'); showToast('Заказ создан','success');
  await loadOrders('active');
}

function closeManualOrder(e) {
  if (e && e.target!==document.getElementById('manual-order-overlay')) return;
  document.getElementById('manual-order-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  QR SCAN FOR OPERATOR / COURIER
// ══════════════════════════════════════════════════════════
function scanQrOperator() {
  if (!tg?.showScanQrPopup) { showToast('QR-сканер доступен только в Telegram','warning'); return; }
  tg.showScanQrPopup({text:'Наведите камеру на QR-код оператора'},data=>{
    tg.closeScanQrPopup();
    const phone=normPhone(data||'');
    if (phone) document.getElementById('op-phone').value=phone;
  });
}

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
  const orders=await dbQuery('orders','venueId','==',VENUE.id);
  const done=orders.filter(o=>o.status==='delivered');
  const revenue=done.reduce((s,o)=>s+(o.total||0),0);
  document.getElementById('stats-grid').innerHTML=`
    <div class="stat-card"><div class="stat-val">${orders.length}</div><div class="stat-lbl">Всего заказов</div></div>
    <div class="stat-card"><div class="stat-val text-success">${done.length}</div><div class="stat-lbl">Доставлено</div></div>
    <div class="stat-card"><div class="stat-val text-danger">${orders.filter(o=>o.status==='cancelled').length}</div><div class="stat-lbl">Отменено</div></div>
    <div class="stat-card"><div class="stat-val text-primary">${fmtPrice(revenue)}</div><div class="stat-lbl">Выручка</div></div>`;
  const itemFreq={};
  done.forEach(o=>(o.items||[]).forEach(it=>{itemFreq[it.name]=(itemFreq[it.name]||0)+it.qty;}));
  const topItems=Object.entries(itemFreq).sort((a,b)=>b[1]-a[1]).slice(0,5);
  document.getElementById('stats-top-items').innerHTML=topItems.length
    ?`<div class="section-title" style="margin-bottom:6px">Топ блюд</div>${topItems.map(([name,qty])=>`<div class="list-item" style="cursor:default"><div class="li-body"><div class="li-title">${name}</div></div><div class="li-price">${qty} шт</div></div>`).join('')}`:'';
}

// ══════════════════════════════════════════════════════════
//  SETTINGS SCREEN
// ══════════════════════════════════════════════════════════
async function loadSettingsScreen() {
  if (!VENUE) return;
  ALL_CITIES=await getAllCities();
  document.getElementById('set-name').value    =VENUE.name||'';
  document.getElementById('set-address').value =VENUE.address||'';
  document.getElementById('set-phone').value   =VENUE.phone||'';
  document.getElementById('set-desc').value    =VENUE.description||'';
  document.getElementById('set-cover').value   =VENUE.coverUrl||'';
  document.getElementById('set-open').value    =VENUE.workOpen||'09:00';
  document.getElementById('set-close').value   =VENUE.workClose||'22:00';
  document.getElementById('set-delivery-time').value =VENUE.deliveryTime||30;
  document.getElementById('set-delivery-price').value=VENUE.deliveryPrice||0;
  document.getElementById('set-cooking-time').value  =VENUE.cookingTime||20;
  document.getElementById('set-min-order').value     =VENUE.minOrder||0;
  _populateCitySelect('set-city', VENUE.cityId||'');

  // Payment methods
  _payMethods={ cash: VENUE.paymentMethods?.cash!==false, card: VENUE.paymentMethods?.card!==false };
  const cashBtn=document.getElementById('set-pay-cash'), cardBtn=document.getElementById('set-pay-card');
  if (cashBtn) { cashBtn.className='pay-tag'+(_payMethods.cash?' active-cash':''); }
  if (cardBtn) { cardBtn.className='pay-tag'+(_payMethods.card?' active-card':''); }

  // Operator
  const op=VENUE.operatorUid?await dbGet('users',VENUE.operatorUid):null;
  const opInfo=document.getElementById('current-operator-info');
  const removeBtn=document.getElementById('remove-op-btn');
  if (op) { opInfo.textContent=`Оператор: ${op.name||'—'} (${op.phone||'—'})`; opInfo.className='alert-box success'; removeBtn.style.display=''; }
  else    { opInfo.textContent='Оператор не назначен'; opInfo.className='alert-box info'; removeBtn.style.display='none'; }

  await loadPermCouriers();
  await loadBlacklist();
}

async function saveVenueInfo() {
  const name    =document.getElementById('set-name').value.trim();
  const address =document.getElementById('set-address').value.trim();
  const phone   =normPhone(document.getElementById('set-phone').value.trim());
  const desc    =document.getElementById('set-desc').value.trim();
  const cover   =document.getElementById('set-cover').value.trim()||_setCoverDataUrl||VENUE.coverUrl||'';
  const cityId  =document.getElementById('set-city').value;
  const city    =ALL_CITIES.find(c=>c.id===cityId);
  if (!name||!address) { showToast('Введите название и адрес','warning'); return; }
  await dbSet('venues',VENUE.id,{ name,address,phone,description:desc,coverUrl:cover,cityId:cityId||'',cityName:city?.name||'' });
  VENUE={...VENUE,name,address,phone,description:desc,coverUrl:cover,cityId,cityName:city?.name||''};
  tgHaptic('success'); showToast('Сохранено','success');
}

async function saveWorkHours() {
  const open=document.getElementById('set-open').value, close=document.getElementById('set-close').value;
  await dbSet('venues',VENUE.id,{workOpen:open,workClose:close});
  VENUE={...VENUE,workOpen:open,workClose:close};
  tgHaptic('success'); showToast('Часы сохранены','success');
}

async function saveDeliverySettings() {
  const delTime =parseInt(document.getElementById('set-delivery-time').value)||30;
  const delPrice=parseInt(document.getElementById('set-delivery-price').value)||0;
  const cookTime=parseInt(document.getElementById('set-cooking-time').value)||20;
  const minOrd  =parseInt(document.getElementById('set-min-order').value)||0;
  await dbSet('venues',VENUE.id,{deliveryTime:delTime,deliveryPrice:delPrice,cookingTime:cookTime,minOrder:minOrd,paymentMethods:_payMethods});
  VENUE={...VENUE,deliveryTime:delTime,deliveryPrice:delPrice,cookingTime:cookTime,minOrder:minOrd,paymentMethods:_payMethods};
  tgHaptic('success'); showToast('Настройки сохранены','success');
}

function _normPhone(p) { return String(p||'').replace(/\D/g,''); }
function _findLinkByPhone(links,phone) { const n=_normPhone(phone); return links.find(l=>_normPhone(l.phone)===n); }

async function assignOperator() {
  const phone=document.getElementById('op-phone').value.trim();
  if (!phone) { showToast('Введите телефон','warning'); return; }
  const links=await dbGetAll('user_links');
  const link=_findLinkByPhone(links,phone);
  if (!link) { showToast('Пользователь с таким номером не найден','error'); return; }
  const uid=link.uid;
  await dbSet('operator_invites',uid,{uid,venueId:VENUE.id,venueName:VENUE.name,venueAddress:VENUE.address||'',adminUid:STATE.uid,status:'pending',createdAt:new Date().toISOString()});
  await dbSet('venues',VENUE.id,{operatorUid:uid});
  VENUE.operatorUid=uid;
  tgHaptic('success'); showToast('Приглашение отправлено оператору','success');
  document.getElementById('op-phone').value='';
  await loadSettingsScreen();
}

async function removeOperator() {
  if (!confirm('Снять оператора с заведения?')) return;
  if (VENUE.operatorUid) { await dbDelete('operator_invites',VENUE.operatorUid); await dbSet('users',VENUE.operatorUid,{operatorVenueId:null}); }
  await dbSet('venues',VENUE.id,{operatorUid:null}); VENUE.operatorUid=null;
  showToast('Оператор снят','info'); await loadSettingsScreen();
}

async function addPermCourier() {
  const phone=document.getElementById('courier-phone').value.trim();
  if (!phone) { showToast('Введите телефон','warning'); return; }
  const links=await dbGetAll('user_links');
  const link=_findLinkByPhone(links,phone);
  if (!link) { showToast('Курьер с таким номером не найден','error'); return; }
  const courier=await dbGet('couriers',link.uid);
  if (!courier) { showToast('Этот пользователь не является курьером','error'); return; }
  await dbSet('courier_venue_links',link.uid,{uid:link.uid,venueId:VENUE.id,venueName:VENUE.name,status:'pending',invitedAt:new Date().toISOString()});
  tgHaptic('success'); showToast('Приглашение отправлено курьеру','success');
  document.getElementById('courier-phone').value='';
  await loadPermCouriers();
}

async function loadPermCouriers() {
  const links=await dbQuery('courier_venue_links','venueId','==',VENUE.id);
  const listEl=document.getElementById('perm-couriers-list');
  if (!links.length) { listEl.innerHTML='<div class="text-dim text-sm">Нет постоянных курьеров</div>'; return; }
  const rows=await Promise.all(links.map(async l=>{ const c=await dbGet('couriers',l.uid); return {...l,courierName:c?.name||l.uid,phone:c?.phone||}; }));
  listEl.innerHTML=rows.map(r=>`
    <div class="flex items-center gap-2">
      <div class="li-icon yellow" style="width:34px;height:34px;font-size:16px">🚴</div>
      <div style="flex:1"><div class="font-bold text-sm">${r.courierName}</div><div class="text-xs text-dim">${r.phone} · ${r.status==='confirmed'?'<span class="text-success">Подтвердил</span>':'Ожидает'}</div></div>
      <button class="btn btn-xs" style="background:var(--danger-soft);color:var(--danger);border:none;padding:4px 8px;border-radius:6px;cursor:pointer" onclick="removePermCourier('${r.uid}')">×</button>
    </div>`).join('');
}

async function removePermCourier(uid) {
  await dbDelete('courier_venue_links',uid);
  showToast('Курьер удалён','info'); await loadPermCouriers();
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
  const links=await dbGetAll('user_links');
  const link=_findLinkByPhone(links,phone);
  if (!link) { showToast('Пользователь не найден','error'); return; }
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
      <div style="flex:1"><div class="font-bold text-sm">${b.clientPhone||b.clientUid}</div><div class="text-xs text-dim">${fmtDate(b.addedAt)}</div></div>
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
