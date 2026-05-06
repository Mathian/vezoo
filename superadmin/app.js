'use strict';
/* ============================================================
   VEZOO SUPERADMIN — Global Management Panel
   ============================================================ */

const STATE = { uid: null, user: null };
let ALL_CATS     = [];
let ALL_COUNTRIES = [];
let ALL_CITIES   = [];
let _editCatId   = null;
let _editCountryId = null;
let _editCityId  = null;
let _pinBuffer   = '';
let _saStatsPeriod = 7; // days; 0 = all time; -1 = custom range

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') { localStorage.clear(); location.replace(location.pathname); return; }
  tgReady();
  if (tg?.BackButton) tg.BackButton.onClick(() => {
    const open = document.querySelector('.overlay.open');
    if (open) { open.classList.remove('open'); return; }
    tg.BackButton.hide();
  });

  const _tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try {
    const s = JSON.parse(localStorage.getItem('vez_sa_state') || '{}');
    if (!_tgUserId || s.tgId === _tgUserId) { STATE.uid = s.uid||null; STATE.user = s.user||null; }
  } catch {}

  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }

  await initFirebase();
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  try { localStorage.removeItem('vez_users_' + STATE.uid); } catch {}
  await dbSet('users', STATE.uid, { role: 'superadmin' });
  const existing = await dbGet('users', STATE.uid);

  if (!existing?.agreedSA) {
    STATE.user = existing || { uid: STATE.uid, role: 'superadmin' };
    saveState();
    showAgreement();
    return;
  }
  STATE.user = existing; saveState();
  showPinScreen();
});

function saveState() {
  const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem('vez_sa_state', JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId: tgUserId })); } catch {}
}

// ══════════════════════════════════════════════════════════
//  AGREEMENT
// ══════════════════════════════════════════════════════════
function showAgreement() {
  document.getElementById('s-splash').style.display = 'none';
  document.getElementById('s-agree').style.display  = 'flex';
}

async function submitAgree() {
  await dbSet('users', STATE.uid, { agreedSA: true });
  STATE.user = { ...STATE.user, agreedSA: true }; saveState();
  document.getElementById('s-agree').style.display = 'none';
  showPinScreen();
}

// ══════════════════════════════════════════════════════════
//  PIN CODE
// ══════════════════════════════════════════════════════════
function showPinScreen() {
  document.getElementById('s-splash').style.display = 'none';
  document.getElementById('s-agree').style.display  = 'none';
  document.getElementById('s-pin').style.display    = 'flex';
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
  tgHaptic('light');
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
  const ok = await verifyPin('superadmin', _pinBuffer);
  if (ok) {
    document.getElementById('s-pin').style.display = 'none';
    initMain();
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

async function changePinSa() {
  const val = (document.getElementById('new-pin-input').value || '').trim();
  if (val.length !== 4 || !/^\d{4}$/.test(val)) { showToast('PIN должен быть 4 цифры', 'warning'); return; }
  await savePin('superadmin', val);
  document.getElementById('new-pin-input').value = '';
  tgHaptic('success'); showToast('PIN изменён', 'success');
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  startHeartbeat(STATE.uid);
  loadCategories();
  loadPendingBadges();
  showScreen('s-categories');
  setNav(document.getElementById('nav-cats'));
}

async function loadPendingBadges() {
  const [pv, pc] = await Promise.all([
    dbQuery('venues','status','==','pending'),
    dbQuery('couriers','status','==','pending')
  ]);
  const vb = document.getElementById('venues-badge');
  vb.textContent = pv.length; vb.classList.toggle('hidden', pv.length === 0);
  const cb = document.getElementById('couriers-badge');
  cb.textContent = pc.length; cb.classList.toggle('hidden', pc.length === 0);
}

function setNav(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}

// ══════════════════════════════════════════════════════════
//  CATEGORIES
// ══════════════════════════════════════════════════════════
async function loadCategories() {
  const list = document.getElementById('categories-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  ALL_CATS = await dbGetAll('categories','order','asc');
  if (!ALL_CATS.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📂</div><div class="empty-text">Категорий нет.<br>Добавьте первую.</div></div>';
    return;
  }
  list.innerHTML = ALL_CATS.map(c => `
    <div class="list-item">
      <div class="li-icon yellow" style="font-size:24px">${c.icon||'📦'}</div>
      <div class="li-body"><div class="li-title">${c.name}</div><div class="li-sub">Порядок: ${c.order||0}</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-icon btn-ghost" onclick="openEditCategory('${c.id}')">✏️</button>
        <button class="btn btn-icon btn-danger" onclick="deleteCategory('${c.id}')">🗑</button>
      </div>
    </div>`).join('');
}

function openAddCategory() {
  _editCatId = null;
  document.getElementById('cat-sheet-title').textContent = 'Новая категория';
  document.getElementById('cat-name').value  = '';
  document.getElementById('cat-icon').value  = '';
  document.getElementById('cat-order').value = '10';
  document.getElementById('cat-overlay').classList.add('open');
}

function openEditCategory(catId) {
  const c = ALL_CATS.find(x => x.id === catId);
  if (!c) return;
  _editCatId = catId;
  document.getElementById('cat-sheet-title').textContent = 'Редактировать категорию';
  document.getElementById('cat-name').value  = c.name||'';
  document.getElementById('cat-icon').value  = c.icon||'';
  document.getElementById('cat-order').value = c.order||10;
  document.getElementById('cat-overlay').classList.add('open');
}

async function saveCategory() {
  const name  = document.getElementById('cat-name').value.trim();
  const icon  = document.getElementById('cat-icon').value.trim();
  const order = parseInt(document.getElementById('cat-order').value)||10;
  if (!name) { showToast('Введите название', 'warning'); return; }
  const catId = _editCatId || genId();
  await dbSet('categories', catId, { id: catId, name, icon, order });
  closeCatSheet(); tgHaptic('success');
  showToast(_editCatId ? 'Категория обновлена' : 'Категория добавлена', 'success');
  await loadCategories();
}

async function deleteCategory(catId) {
  const cat    = ALL_CATS.find(c => c.id === catId);
  const venues = await dbQuery('venues','categoryId','==',catId);
  if (!confirm(`Удалить категорию "${cat?.name}"?${venues.length ? `\n\n${venues.length} заведений потеряют категорию.` : ''}`)) return;
  await dbDelete('categories', catId);
  tgHaptic('light'); showToast('Категория удалена', 'info');
  await loadCategories();
}

function closeCatSheet(e) {
  if (e && e.target !== document.getElementById('cat-overlay')) return;
  document.getElementById('cat-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  GEOGRAPHY — COUNTRIES & CITIES
// ══════════════════════════════════════════════════════════
async function loadGeo() {
  const list = document.getElementById('geo-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  ALL_COUNTRIES = await dbGetAll('countries','name','asc');
  ALL_CITIES    = await dbGetAll('cities','name','asc');
  _countriesCache = ALL_COUNTRIES; // sync shared cache

  if (!ALL_COUNTRIES.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🌍</div><div class="empty-text">Стран нет.<br>Добавьте первую страну.</div></div>';
    return;
  }

  list.innerHTML = ALL_COUNTRIES.map(country => {
    const cities = ALL_CITIES.filter(c => c.countryId === country.id);
    return `
      <div class="country-card">
        <div class="country-card-hdr">
          <div>
            <div class="country-card-name">🏳 ${country.name}</div>
            <div class="country-currency">${country.currency} · ${cities.length} ${pluralCity(cities.length)}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-xs btn-outline" onclick="openAddCity('${country.id}')">+ Город</button>
            <button class="btn btn-icon btn-ghost" style="width:32px;height:32px;font-size:14px" onclick="openEditCountry('${country.id}')">✏️</button>
            <button class="btn btn-icon" style="width:32px;height:32px;font-size:14px;background:var(--danger-soft);color:var(--danger);border:none;border-radius:8px;cursor:pointer" onclick="deleteCountry('${country.id}')">🗑</button>
          </div>
        </div>
        ${cities.length ? cities.map(city => `
          <div class="city-row">
            <div>
              <div class="city-row-name">📍 ${city.name}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="city-row-price">${fmtPrice(city.deliveryPrice, country.currency)}</div>
              <button class="btn btn-icon btn-ghost" style="width:28px;height:28px;font-size:13px" onclick="openEditCity('${city.id}','${country.id}')">✏️</button>
              <button class="btn btn-icon" style="width:28px;height:28px;font-size:13px;background:var(--danger-soft);color:var(--danger);border:none;border-radius:8px;cursor:pointer" onclick="deleteCity('${city.id}')">🗑</button>
            </div>
          </div>`).join('') : `<div style="padding:12px 15px;font-size:13px;color:var(--text-muted)">Городов нет — добавьте первый</div>`}
      </div>`;
  }).join('');
}

function pluralCity(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'город';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'города';
  return 'городов';
}

// COUNTRY CRUD
function openAddCountry() {
  _editCountryId = null;
  document.getElementById('country-sheet-title').textContent = 'Новая страна';
  document.getElementById('country-name').value     = '';
  document.getElementById('country-currency').value = '';
  document.getElementById('country-overlay').classList.add('open');
}

function openEditCountry(countryId) {
  const c = ALL_COUNTRIES.find(x => x.id === countryId);
  if (!c) return;
  _editCountryId = countryId;
  document.getElementById('country-sheet-title').textContent = 'Редактировать страну';
  document.getElementById('country-name').value     = c.name||'';
  document.getElementById('country-currency').value = c.currency||'';
  document.getElementById('country-overlay').classList.add('open');
}

async function saveCountry() {
  const name     = document.getElementById('country-name').value.trim();
  const currency = document.getElementById('country-currency').value.trim();
  if (!name)     { showToast('Введите название страны', 'warning'); return; }
  if (!currency) { showToast('Введите символ валюты', 'warning'); return; }
  const countryId = _editCountryId || genId();
  await dbSet('countries', countryId, { id: countryId, name, currency });
  closeCountrySheet(); tgHaptic('success');
  showToast(_editCountryId ? 'Страна обновлена' : 'Страна добавлена', 'success');
  await loadGeo();
}

async function deleteCountry(countryId) {
  const c = ALL_COUNTRIES.find(x => x.id === countryId);
  const cities = ALL_CITIES.filter(x => x.countryId === countryId);
  if (!confirm(`Удалить страну "${c?.name}"?${cities.length ? `\n\n${cities.length} городов также будут удалены.` : ''}`)) return;
  await dbDelete('countries', countryId);
  for (const city of cities) await dbDelete('cities', city.id);
  tgHaptic('light'); showToast('Страна удалена', 'info');
  await loadGeo();
}

function closeCountrySheet(e) {
  if (e && e.target !== document.getElementById('country-overlay')) return;
  document.getElementById('country-overlay').classList.remove('open');
}

// CITY CRUD
function openAddCity(countryId) {
  _editCityId = null;
  document.getElementById('city-sheet-title').textContent = 'Новый город';
  document.getElementById('city-name').value           = '';
  document.getElementById('city-delivery-price').value = '1000';
  document.getElementById('city-country-id').value    = countryId;
  document.getElementById('city-overlay').classList.add('open');
}

function openEditCity(cityId, countryId) {
  const c = ALL_CITIES.find(x => x.id === cityId);
  if (!c) return;
  _editCityId = cityId;
  document.getElementById('city-sheet-title').textContent = 'Редактировать город';
  document.getElementById('city-name').value           = c.name||'';
  document.getElementById('city-delivery-price').value = c.deliveryPrice||1000;
  document.getElementById('city-country-id').value    = countryId || c.countryId || '';
  document.getElementById('city-overlay').classList.add('open');
}

async function saveCity() {
  const name          = document.getElementById('city-name').value.trim();
  const deliveryPrice = parseInt(document.getElementById('city-delivery-price').value)||1000;
  const countryId     = document.getElementById('city-country-id').value;
  if (!name)      { showToast('Введите название города', 'warning'); return; }
  if (!countryId) { showToast('Не выбрана страна', 'warning'); return; }
  const cityId = _editCityId || genId();
  await dbSet('cities', cityId, { id: cityId, name, countryId, deliveryPrice });
  closeCitySheet(); tgHaptic('success');
  showToast(_editCityId ? 'Город обновлён' : 'Город добавлен', 'success');
  await loadGeo();
}

async function deleteCity(cityId) {
  const c = ALL_CITIES.find(x => x.id === cityId);
  if (!confirm(`Удалить город "${c?.name}"?`)) return;
  await dbDelete('cities', cityId);
  tgHaptic('light'); showToast('Город удалён', 'info');
  await loadGeo();
}

function closeCitySheet(e) {
  if (e && e.target !== document.getElementById('city-overlay')) return;
  document.getElementById('city-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  VENUES
// ══════════════════════════════════════════════════════════
async function loadVenuesByStatus(status, el) {
  if (el) { document.querySelectorAll('#s-venues .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  const list = document.getElementById('sa-venues-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const venues = await dbQuery('venues','status','==',status);
  if (!venues.length) { list.innerHTML = '<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">Нет заведений</div></div>'; return; }
  const cats = await dbGetAll('categories');
  list.innerHTML = venues.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(v => {
    const cat = cats.find(c=>c.id===v.categoryId);
    const statusBadge = {pending:'badge-moderation',approved:'badge-approved',rejected:'badge-rejected'}[status];
    const statusText  = {pending:'Ожидает',approved:'Активно',rejected:'Отклонено'}[status];
    return `
      <div class="list-item" onclick="openSaVenue('${v.id}')">
        <div class="li-icon yellow" style="font-size:24px">${cat?.icon||'🏪'}</div>
        <div class="li-body">
          <div class="li-title">${v.name}</div>
          <div class="li-sub">${cat?.name||'Без категории'} · ${v.address||'—'}</div>
          <div class="li-sub">${fmtDate(v.createdAt)}</div>
        </div>
        <span class="badge ${statusBadge}">${statusText}</span>
      </div>`;
  }).join('');
}

async function openSaVenue(venueId) {
  const venue = await dbGet('venues', venueId);
  if (!venue) return;
  const [owner, cats] = await Promise.all([dbGet('users', venue.ownerId), dbGetAll('categories')]);
  const cat = cats.find(c=>c.id===venue.categoryId);
  const content = document.getElementById('sa-venue-detail');
  content.innerHTML = `
    <div class="sheet-title">${venue.name}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Категория</span><span>${cat?.icon||''} ${cat?.name||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${venue.address||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Город</span><span>${venue.cityName||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Владелец</span><span>${owner?.name||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${owner?.phone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Статус</span><span class="badge badge-${venue.status==='approved'?'approved':venue.status==='rejected'?'rejected':'moderation'}">${venue.status}</span></div>
      <div class="flex justify-between"><span class="text-dim">Заблокировано</span><span>${venue.blocked?'<span style="color:var(--danger)">Да</span>':'Нет'}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${venue.status==='pending'?`
        <div class="btn-row">
          <button class="btn btn-danger btn-sm" onclick="saRejectVenue('${venueId}')">❌ Отклонить</button>
          <button class="btn btn-success btn-sm" onclick="saApproveVenue('${venueId}')">✅ Одобрить</button>
        </div>`:''}
      ${venue.status==='approved'?`
        <button class="btn ${venue.blocked?'btn-success':'btn-danger'} btn-sm" onclick="saToggleVenueBlock('${venueId}',${venue.blocked})">
          ${venue.blocked?'🟢 Разблокировать':'🚫 Заблокировать'} заведение
        </button>`:''}
      ${venue.status==='rejected'?`
        <button class="btn btn-outline btn-sm" onclick="saApproveVenue('${venueId}')">↩ Одобрить всё же</button>`:''}
      <div class="field"><label>Заметка</label><textarea class="inp" id="sa-venue-note" rows="2" placeholder="Причина...">${venue.saNote||''}</textarea></div>
      <button class="btn btn-ghost btn-sm" onclick="saveSaVenueNote('${venueId}')">💾 Сохранить заметку</button>
    </div>`;
  document.getElementById('venue-overlay').classList.add('open');
}

async function saApproveVenue(venueId) {
  await dbSet('venues', venueId, { status: 'approved', approvedAt: new Date().toISOString() });
  await dbSet('admin_events', `venue_approved_${venueId}`, { type:'venue_approved', venueId, ts: new Date().toISOString() });
  closeVenueSheet(); tgHaptic('success'); showToast('Заведение одобрено', 'success');
  loadVenuesByStatus('pending'); loadPendingBadges();
}

async function saRejectVenue(venueId) {
  await dbSet('venues', venueId, { status: 'rejected', rejectedAt: new Date().toISOString() });
  await dbSet('admin_events', `venue_rejected_${venueId}`, { type:'venue_rejected', venueId, ts: new Date().toISOString() });
  closeVenueSheet(); tgHaptic('light'); showToast('Заведение отклонено', 'info');
  loadVenuesByStatus('pending'); loadPendingBadges();
}

async function saToggleVenueBlock(venueId, currentlyBlocked) {
  if (!confirm(currentlyBlocked?'Разблокировать заведение?':'Заблокировать заведение?')) return;
  await dbSet('venues', venueId, { blocked: !currentlyBlocked });
  closeVenueSheet(); tgHaptic('light');
  showToast(currentlyBlocked?'Разблокировано':'Заблокировано', 'info');
  loadVenuesByStatus('approved');
}

async function saveSaVenueNote(venueId) {
  const note = document.getElementById('sa-venue-note').value.trim();
  await dbSet('venues', venueId, { saNote: note });
  tgHaptic('light'); showToast('Заметка сохранена', 'success');
}

function closeVenueSheet(e) {
  if (e && e.target !== document.getElementById('venue-overlay')) return;
  document.getElementById('venue-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  COURIERS
// ══════════════════════════════════════════════════════════
async function loadCouriersByStatus(status, el) {
  if (el) { document.querySelectorAll('#s-couriers .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  const list = document.getElementById('sa-couriers-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const couriers = await dbQuery('couriers','status','==',status);
  if (!couriers.length) { list.innerHTML = '<div class="empty"><div class="empty-icon">🚴</div><div class="empty-text">Нет курьеров</div></div>'; return; }
  list.innerHTML = couriers.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(c => {
    const rating = c.rating ? `⭐ ${Number(c.rating).toFixed(1)}` : '';
    return `
      <div class="list-item" onclick="openSaCourier('${c.uid||c.id}')">
        <div class="li-icon yellow">🚴</div>
        <div class="li-body">
          <div class="li-title">${c.name||'—'} ${rating}</div>
          <div class="li-sub">${c.phone||'—'} · ${fmtDate(c.createdAt)}</div>
          <div class="li-sub">${c.onShift?'<span style="color:var(--success)">На смене</span>':'Офлайн'}</div>
        </div>
        <span class="badge badge-${status==='pending'?'moderation':status==='active'?'approved':'rejected'}">${status==='pending'?'Проверка':status==='active'?'Активен':'Заблокирован'}</span>
      </div>`;
  }).join('');
}

async function openSaCourier(courierUid) {
  const courier = await dbGet('couriers', courierUid);
  if (!courier) return;
  const deliveredOrders = (await dbQuery('orders','courierUid','==',courierUid)).filter(o=>o.status==='delivered');
  const totalRev = deliveredOrders.reduce((s,o)=>s+(o.total||0),0);
  const content = document.getElementById('sa-courier-detail');
  content.innerHTML = `
    <div class="sheet-title">${courier.name||'Курьер'}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${courier.phone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Статус</span><span>${courier.status}</span></div>
      <div class="flex justify-between"><span class="text-dim">На смене</span><span>${courier.onShift?'<span style="color:var(--success)">Да</span>':'Нет'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Рейтинг</span><span>${courier.rating?'⭐ '+Number(courier.rating).toFixed(1):'Нет оценок'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Доставлено</span><span class="font-bold">${deliveredOrders.length}</span></div>
      <div class="flex justify-between"><span class="text-dim">Город</span><span>${courier.cityName||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Регистрация</span><span>${fmtDate(courier.createdAt)}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${courier.status==='pending'?`
        <div class="btn-row">
          <button class="btn btn-danger btn-sm" onclick="saBlockCourier('${courierUid}')">🚫 Отклонить</button>
          <button class="btn btn-success btn-sm" onclick="saApproveCourier('${courierUid}')">✅ Одобрить</button>
        </div>`:''}
      ${courier.status==='active'?`<button class="btn btn-danger btn-sm" onclick="saBlockCourier('${courierUid}')">🚫 Заблокировать</button>`:''}
      ${courier.status==='blocked'?`<button class="btn btn-success btn-sm" onclick="saApproveCourier('${courierUid}')">🟢 Разблокировать</button>`:''}
    </div>`;
  document.getElementById('courier-detail-overlay').classList.add('open');
}

async function saApproveCourier(uid) {
  await dbSet('couriers', uid, { status: 'active', approvedAt: new Date().toISOString() });
  await dbSet('users',   uid, { role: 'courier' });
  await dbSet('admin_events', `courier_approved_${uid}`, { type:'courier_approved', uid, ts: new Date().toISOString() });
  closeCourierDetailSheet(); tgHaptic('success'); showToast('Курьер одобрен', 'success');
  loadCouriersByStatus('pending'); loadPendingBadges();
}

async function saBlockCourier(uid) {
  if (!confirm('Заблокировать / отклонить курьера?')) return;
  await dbSet('couriers', uid, { status: 'blocked', blockedAt: new Date().toISOString(), onShift: false });
  await dbSet('users',   uid, { blocked: true });
  await dbSet('admin_events', `courier_blocked_${uid}`, { type:'courier_blocked', uid, ts: new Date().toISOString() });
  closeCourierDetailSheet(); tgHaptic('light'); showToast('Курьер заблокирован', 'info');
  loadCouriersByStatus('pending'); loadPendingBadges();
}

function closeCourierDetailSheet(e) {
  if (e && e.target !== document.getElementById('courier-detail-overlay')) return;
  document.getElementById('courier-detail-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  SETTINGS / STATS
// ══════════════════════════════════════════════════════════
async function loadSaSettings() {
  // Load allergy toggle state
  const cfg = await dbGet('settings', 'global');
  document.getElementById('toggle-allergy').checked = cfg?.allergyEnabled !== false;

  // Load stats
  await loadSaStats();

  // Load users
  loadUsersByRole('client');
}

async function saveAllergyToggle(enabled) {
  await dbSet('settings', 'global', { allergyEnabled: enabled });
  tgHaptic('light');
  showToast(enabled ? 'Система аллергий включена' : 'Система аллергий выключена', 'info');
}

function setSaPeriod(days, el) {
  document.querySelectorAll('.period-tab').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  _saStatsPeriod = days;
  // Clear custom date inputs when using quick tabs
  const dfrom = document.getElementById('sa-date-from');
  const dto   = document.getElementById('sa-date-to');
  if (dfrom) dfrom.value = '';
  if (dto)   dto.value   = '';
  loadSaStats();
}

function loadSaStatsCustom() {
  // Deactivate period tabs when using custom range
  document.querySelectorAll('.period-tab').forEach(b=>b.classList.remove('active'));
  _saStatsPeriod = -1; // -1 = custom range
  loadSaStats();
}

async function loadSaStats() {
  const [venues, allOrders, users, couriers] = await Promise.all([
    dbGetAll('venues'), dbGetAll('orders'), dbGetAll('users'), dbGetAll('couriers')
  ]);

  // Filter by period
  let orders = allOrders;
  if (_saStatsPeriod === -1) {
    // Custom date range
    const dfrom = document.getElementById('sa-date-from')?.value;
    const dto   = document.getElementById('sa-date-to')?.value;
    if (dfrom || dto) {
      orders = allOrders.filter(o => {
        const d = (o.createdAt||'').slice(0,10);
        if (dfrom && d < dfrom) return false;
        if (dto   && d > dto)   return false;
        return true;
      });
    }
  } else if (_saStatsPeriod > 0) {
    const cutoff = new Date(Date.now() - _saStatsPeriod * 86400000).toISOString();
    orders = allOrders.filter(o => (o.createdAt||'') >= cutoff);
  }

  const revenue = orders.filter(o=>o.status==='delivered').reduce((s,o)=>s+(o.total||0),0);
  const grid    = document.getElementById('sa-stats-grid');
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-val">${venues.filter(v=>v.status==='approved').length}</div><div class="stat-lbl">Заведений</div></div>
    <div class="stat-card"><div class="stat-val">${orders.filter(o=>o.status==='delivered').length}</div><div class="stat-lbl">Доставлено</div></div>
    <div class="stat-card"><div class="stat-val">${users.filter(u=>u.role==='client').length}</div><div class="stat-lbl">Клиентов</div></div>
    <div class="stat-card"><div class="stat-val text-primary">${fmtPrice(revenue)}</div><div class="stat-lbl">Оборот</div></div>`;

  const venueStats = venues.filter(v=>v.status==='approved').map(v => {
    const vo  = orders.filter(o=>o.venueId===v.id);
    const del = vo.filter(o=>o.status==='delivered');
    const rev = del.reduce((s,o)=>s+(o.total||0),0);
    return { id: v.id, name: v.name, orders: vo.length, delivered: del.length, revenue: rev };
  }).sort((a,b)=>b.revenue-a.revenue);

  document.getElementById('sa-stats-venues').innerHTML = venueStats.filter(v=>v.orders>0).map(v=>`
    <div class="list-item" style="cursor:default">
      <div class="li-icon yellow">🏪</div>
      <div class="li-body"><div class="li-title">${v.name}</div><div class="li-sub">${v.delivered} доставлено из ${v.orders}</div></div>
      <div class="li-price">${fmtPrice(v.revenue)}</div>
    </div>`).join('') || '<div class="empty" style="padding:30px 24px"><div class="empty-icon">📊</div><div class="empty-text">Нет данных за период</div></div>';
}

// ══════════════════════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════════════════════
async function loadUsersByRole(role, el) {
  if (el) { document.querySelectorAll('#s-sa-settings .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  const list = document.getElementById('sa-users-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const users = await dbQuery('users','role','==',role);
  if (!users.length) { list.innerHTML = '<div class="empty" style="padding:30px 24px"><div class="empty-icon">👤</div><div class="empty-text">Нет пользователей</div></div>'; return; }
  list.innerHTML = users.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(u => `
    <div class="list-item" onclick="openSaUser('${u.uid||u.id}')">
      <div class="avatar" style="width:36px;height:36px;font-size:14px">${(u.name||'?')[0].toUpperCase()}</div>
      <div class="li-body">
        <div class="li-title">${u.name||'—'}${u.blocked?' <span style="color:var(--danger);font-size:11px">BLOCKED</span>':''}</div>
        <div class="li-sub">${u.phone||'—'} · ${u.cityName||'—'}</div>
      </div>
      <div class="chevron">›</div>
    </div>`).join('');
}

async function openSaUser(uid) {
  const user = await dbGet('users', uid);
  if (!user) return;
  const content = document.getElementById('sa-user-detail');
  content.innerHTML = `
    <div class="sheet-title">${user.name||'—'}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${user.phone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Роль</span><span>${user.role||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Город</span><span>${user.cityName||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Статус</span><span>${user.blocked?'<span style="color:var(--danger)">Заблокирован</span>':'Активен'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Регистрация</span><span>${fmtDate(user.createdAt)}</span></div>
    </div>
    <button class="btn ${user.blocked?'btn-success':'btn-danger'} btn-sm" onclick="saToggleUserBlock('${uid}',${!!user.blocked})">
      ${user.blocked?'🟢 Разблокировать':'🚫 Заблокировать'}
    </button>`;
  document.getElementById('user-overlay').classList.add('open');
}

async function saToggleUserBlock(uid, currentlyBlocked) {
  if (!confirm(currentlyBlocked?'Разблокировать пользователя?':'Заблокировать пользователя?')) return;
  await dbSet('users', uid, { blocked: !currentlyBlocked });
  closeUserSheet(); tgHaptic('light');
  showToast(currentlyBlocked?'Разблокирован':'Заблокирован', 'info');
}

function closeUserSheet(e) {
  if (e && e.target !== document.getElementById('user-overlay')) return;
  document.getElementById('user-overlay').classList.remove('open');
}
