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
let _saEditVenueId    = null;
let _saVenPayMethods  = { cash: true, card: true };
let _saVenCoverDataUrl = null;

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

  const _urlToken = readUidFromUrl();
  await initFirebase();
  if (_urlToken) {
    const _res = await resolveLoginToken(_urlToken);
    if (_res.uid) {
      if (_res.clearStorage) _clearVezCache();
      STATE.uid = _res.uid;
      saveState();
    }
  }
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);

  if (!existing?.agreedSA && !STATE.user?.agreedSA) {
    STATE.user = existing || {};
    saveState();
    showAgreement();
    return;
  }
  STATE.user = existing || STATE.user; saveState();
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
  await dbSet('users', STATE.uid, { agreedSA: true, role: 'superadmin' });
  STATE.user = { ...STATE.user, agreedSA: true, role: 'superadmin' }; saveState();
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
  // Rate limit: 5 attempts per minute
  try { await serverRateLimit(STATE.uid, 'pin'); }
  catch (e) {
    tgHaptic('error');
    document.getElementById('pin-sub-text').textContent = e.message;
    setTimeout(() => { _pinBuffer = ''; updatePinDots(); document.getElementById('pin-sub-text').textContent = 'Введите PIN-код'; }, 2000);
    return;
  }
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
  const pc = await dbQuery('couriers','status','==','pending');
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
      <div class="li-icon yellow" style="font-size:24px">${escHtml(c.icon||'📦')}</div>
      <div class="li-body"><div class="li-title">${escHtml(c.name)}</div><div class="li-sub">Порядок: ${c.order||0}</div></div>
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
            <div class="country-card-name">🏳 ${escHtml(country.name)}</div>
            <div class="country-currency">${escHtml(country.currency)} · ${cities.length} ${pluralCity(cities.length)}</div>
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
              <div class="city-row-name">📍 ${escHtml(city.name)}</div>
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
async function loadAllVenues() {
  const list = document.getElementById('sa-venues-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const venues = await dbGetAll('venues', 'name', 'asc');
  if (!venues.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">Заведений нет.<br>Нажмите «+ Добавить».</div></div>';
    return;
  }
  const cats = await dbGetAll('categories');
  list.innerHTML = venues.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(v => {
    const cat = cats.find(c=>c.id===v.categoryId);
    const badges = [];
    if (v.blocked) badges.push('<span class="badge badge-rejected">Блок</span>');
    if (v.onlineOrdersEnabled === false) badges.push('<span class="badge badge-moderation">Офлайн</span>');
    if (!v.blocked && v.onlineOrdersEnabled !== false) badges.push('<span class="badge badge-approved">Онлайн</span>');
    return `
      <div class="list-item" onclick="openSaVenueEdit('${v.id}')">
        <div class="li-icon yellow" style="font-size:24px">${escHtml(cat?.icon||'🏪')}</div>
        <div class="li-body">
          <div class="li-title">${escHtml(v.name)}${v.blocked?' <span style="color:var(--danger);font-size:11px">BLOCKED</span>':''}</div>
          <div class="li-sub">${escHtml(cat?.name||'Без категории')} · ${escHtml(v.cityName||'—')}</div>
          <div class="li-sub">${escHtml(v.address||'—')}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">${badges.join('')}</div>
      </div>`;
  }).join('');
}

function _renderSaVenueSheetHtml(venue) {
  const isEdit = !!venue;
  const catsOpts = ALL_CATS.map(c => `<option value="${c.id}" ${venue?.categoryId===c.id?'selected':''}>${escHtml(c.icon||'')} ${escHtml(c.name)}</option>`).join('');
  const countryOpts = ALL_COUNTRIES.map(c => `<option value="${c.id}" ${venue?.countryId===c.id?'selected':''}>${escHtml(c.name)}</option>`).join('');
  const filteredCities = venue?.countryId ? ALL_CITIES.filter(c=>c.countryId===venue.countryId) : ALL_CITIES;
  const cityOpts = filteredCities.map(c => `<option value="${c.id}" ${venue?.cityId===c.id?'selected':''}>${escHtml(c.name)}</option>`).join('');
  _saVenPayMethods = { cash: venue?.paymentMethods?.cash!==false, card: venue?.paymentMethods?.card!==false };
  const onlineChecked = venue?.onlineOrdersEnabled !== false ? 'checked' : '';
  const venId = venue?.id || '';
  return `
    <div class="sheet-title">${isEdit ? escHtml(venue.name) : 'Новое заведение'}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="section-title">Основное</div>
      <div class="field"><label>Название *</label><input class="inp" id="sa-ven-name" placeholder="Кафе «Уют»" value="${escHtml(venue?.name||'')}" maxlength="80"></div>
      <div class="field"><label>Категория *</label><select class="inp" id="sa-ven-cat"><option value="">Выберите...</option>${catsOpts}</select></div>
      <div class="field"><label>Описание</label><textarea class="inp" id="sa-ven-desc" rows="2" maxlength="500">${venue?.description||''}</textarea></div>

      <div class="section-title">Расположение</div>
      <div class="field"><label>Страна *</label><select class="inp" id="sa-ven-country" onchange="saVenCountryChange()"><option value="">Выберите страну...</option>${countryOpts}</select></div>
      <div class="field"><label>Город *</label><select class="inp" id="sa-ven-city"><option value="">Выберите город...</option>${cityOpts}</select></div>
      <div class="inp-row">
        <div class="field"><label>Улица *</label><input class="inp" id="sa-ven-street" placeholder="ул. Абая" value="${venue?.addrStreet||''}"></div>
        <div class="field" style="max-width:88px"><label>Дом *</label><input class="inp" id="sa-ven-house" placeholder="10" value="${venue?.addrHouse||''}"></div>
        <div class="field" style="max-width:78px"><label>Офис</label><input class="inp" id="sa-ven-office" placeholder="5" value="${venue?.addrOffice||''}"></div>
      </div>
      <div class="field"><label>Телефон</label><input class="inp" id="sa-ven-phone" type="tel" placeholder="+7 (777) 000-00-00" value="${escHtml(venue?.phone||'')}"></div>

      <div class="section-title">Часы работы</div>
      <div class="inp-row">
        <div class="field"><label>Открытие</label><input class="inp" id="sa-ven-open" type="time" value="${venue?.workOpen||'09:00'}"></div>
        <div class="field"><label>Закрытие</label><input class="inp" id="sa-ven-close" type="time" value="${venue?.workClose||'22:00'}"></div>
      </div>

      <div class="section-title">Доставка и оплата</div>
      <div class="inp-row">
        <div class="field"><label>Время доставки (мин)</label><input class="inp" id="sa-ven-deltime" type="number" value="${venue?.deliveryTime||30}" min="5"></div>
        <div class="field"><label>Стоимость доставки</label><input class="inp" id="sa-ven-delprice" type="number" value="${venue?.deliveryPrice||0}" min="0"></div>
      </div>
      <div class="field"><label>Мин. сумма заказа</label><input class="inp" id="sa-ven-minorder" type="number" value="${venue?.minOrder||0}" min="0"></div>
      <div class="section-title" style="margin-top:4px">Способы оплаты</div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="pay-tag${_saVenPayMethods.cash?' active-cash':''}" id="sa-ven-pay-cash" onclick="toggleSaVenPayTag('cash')">💵 Наличные</button>
        <button class="pay-tag${_saVenPayMethods.card?' active-card':''}" id="sa-ven-pay-card" onclick="toggleSaVenPayTag('card')">💳 Карта</button>
      </div>

      <div class="toggle-row" style="margin-top:8px">
        <div>
          <div style="font-weight:600;font-size:14px">Принимать онлайн заказы</div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:2px">Клиенты видят заведение и могут делать заказы</div>
        </div>
        <label class="toggle"><input type="checkbox" id="sa-ven-online" ${onlineChecked}><span class="toggle-sl"></span></label>
      </div>

      <div class="section-title">Обложка</div>
      <div class="field"><label>Ссылка на фото</label><input class="inp" id="sa-ven-cover-url" placeholder="https://..." type="url" value="${venue?.coverUrl||''}"></div>
      <div class="img-upload" id="sa-ven-cover-upload" onclick="document.getElementById('sa-ven-cover-file').click()" style="position:relative;border-radius:12px;overflow:hidden;height:120px;cursor:pointer;background:var(--card-bg);border:2px dashed var(--border);display:flex;align-items:center;justify-content:center">
        ${venue?.coverUrl?`<img src="${venue.coverUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`:''}<input type="file" id="sa-ven-cover-file" accept="image/*" onchange="previewSaVenCover(this)" style="${venue?.coverUrl?'position:absolute;inset:0;opacity:0;cursor:pointer':'display:none'}">
        ${!venue?.coverUrl?'<span class="img-upload-txt">📷 Загрузить обложку</span>':''}
      </div>

      ${isEdit ? `
      <button class="btn ${venue.blocked?'btn-success':'btn-danger'} btn-sm" style="margin-top:4px" onclick="saToggleVenueBlock('${venId}',${!!venue.blocked})">
        ${venue.blocked?'🟢 Разблокировать':'🚫 Заблокировать'} заведение
      </button>

      <div class="section-title" style="margin-top:4px">Администратор</div>
      <div id="sa-ven-admin-info" class="alert-box info" style="margin-bottom:8px">Загрузка...</div>
      <div class="field">
        <label>Телефон администратора</label>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input class="inp" id="sa-ven-admin-phone" type="tel" placeholder="+7 (777) 000-00-00" style="flex:1">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="saScanQrAdmin('${venId}')" style="height:46px;width:46px;flex-shrink:0;font-size:20px">📷</button>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;width:100%" onclick="saAssignAdminToVenue('${venId}')">Назначить администратора</button>
      </div>
      <button class="btn btn-ghost btn-sm" id="sa-ven-remove-admin-btn" style="display:none;color:var(--danger)" onclick="saRemoveAdminFromVenue('${venId}')">✕ Снять администратора</button>

      <div class="section-title" style="margin-top:4px">Оператор</div>
      <div id="sa-ven-op-info" class="alert-box info" style="margin-bottom:8px">Загрузка...</div>
      <div class="field">
        <label>Телефон оператора</label>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input class="inp" id="sa-ven-op-phone" type="tel" placeholder="+7 (777) 000-00-00" style="flex:1">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="saScanQrOpForVenue('${venId}')" style="height:46px;width:46px;flex-shrink:0;font-size:20px">📷</button>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;width:100%" onclick="saAssignOpToVenue('${venId}')">Назначить оператора</button>
      </div>
      <button class="btn btn-ghost btn-sm" id="sa-ven-remove-op-btn" style="display:none;color:var(--danger)" onclick="saRemoveOpFromVenue('${venId}')">✕ Снять оператора</button>

      <div class="section-title" style="margin-top:4px">Постоянные курьеры</div>
      <div id="sa-ven-couriers-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
      <div class="field">
        <label>Телефон курьера</label>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input class="inp" id="sa-ven-courier-phone" type="tel" placeholder="+7 (777) 000-00-00" style="flex:1">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="saScanQrCourierForVenue('${venId}')" style="height:46px;width:46px;flex-shrink:0;font-size:20px">📷</button>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px;width:100%" onclick="saAddCourierToVenue('${venId}')">Добавить курьера</button>
      </div>` : ''}

      <div class="btn-row" style="margin-top:8px">
        <button class="btn btn-ghost" onclick="closeVenueSheet()">Отмена</button>
        <button class="btn btn-primary" onclick="saveSaVenue(${isEdit?`'${venId}'`:'null'})">
          ${isEdit ? '💾 Сохранить' : 'Создать заведение'}
        </button>
      </div>
    </div>`;
}

async function openSaCreateVenue() {
  _saEditVenueId = null; _saVenCoverDataUrl = null;
  _saVenPayMethods = { cash: true, card: true };
  await _ensureSaVenueData();
  document.getElementById('sa-venue-detail').innerHTML = _renderSaVenueSheetHtml(null);
  document.getElementById('venue-overlay').classList.add('open');
}

async function openSaVenueEdit(venueId) {
  const venue = await dbGet('venues', venueId);
  if (!venue) return;
  _saEditVenueId = venueId; _saVenCoverDataUrl = null;
  _saVenPayMethods = { cash: venue.paymentMethods?.cash!==false, card: venue.paymentMethods?.card!==false };
  await _ensureSaVenueData();
  document.getElementById('sa-venue-detail').innerHTML = _renderSaVenueSheetHtml(venue);
  document.getElementById('venue-overlay').classList.add('open');
  // Load assignees asynchronously after sheet is open
  _loadSaVenueAssignees(venue);
}

async function _ensureSaVenueData() {
  const promises = [];
  if (!ALL_CATS.length)     promises.push(dbGetAll('categories','order','asc').then(d=>ALL_CATS=d));
  if (!ALL_COUNTRIES.length) promises.push(dbGetAll('countries','name','asc').then(d=>{ALL_COUNTRIES=d;}));
  if (!ALL_CITIES.length)    promises.push(dbGetAll('cities','name','asc').then(d=>ALL_CITIES=d));
  if (promises.length) await Promise.all(promises);
}

async function _loadSaVenueAssignees(venue) {
  // Admin info
  const adminEl = document.getElementById('sa-ven-admin-info');
  const removeAdminBtn = document.getElementById('sa-ven-remove-admin-btn');
  if (adminEl) {
    if (venue.adminUid) {
      const admin = await dbGet('users', venue.adminUid);
      adminEl.textContent = `Администратор: ${admin?.name||'—'} (${admin?.phone||'—'})`;
      adminEl.className = 'alert-box success';
      if (removeAdminBtn) removeAdminBtn.style.display = '';
    } else {
      // Check pending invite
      const invite = await dbGet('admin_invites', venue.id);
      if (invite && invite.status === 'pending') {
        adminEl.textContent = 'Приглашение отправлено, ожидает подтверждения';
        adminEl.className = 'alert-box info';
      } else {
        adminEl.textContent = 'Администратор не назначен';
        adminEl.className = 'alert-box info';
      }
    }
  }
  // Operator info
  const opEl = document.getElementById('sa-ven-op-info');
  const removeOpBtn = document.getElementById('sa-ven-remove-op-btn');
  if (opEl) {
    if (venue.operatorUid) {
      const op = await dbGet('users', venue.operatorUid);
      opEl.textContent = `Оператор: ${op?.name||'—'} (${op?.phone||'—'})`;
      opEl.className = 'alert-box success';
      if (removeOpBtn) removeOpBtn.style.display = '';
    } else {
      opEl.textContent = 'Оператор не назначен';
      opEl.className = 'alert-box info';
    }
  }
  // Couriers list
  await _loadSaVenueCouriers(venue.id);
}

async function _loadSaVenueCouriers(venueId) {
  const listEl = document.getElementById('sa-ven-couriers-list');
  if (!listEl) return;
  const links = await dbQuery('courier_venue_links','venueId','==',venueId);
  if (!links.length) { listEl.innerHTML = '<div class="text-dim text-sm">Нет постоянных курьеров</div>'; return; }
  const rows = await Promise.all(links.map(async l => { const c = await dbGet('couriers',l.uid); return {...l, courierName:c?.name||l.uid, phone:c?.phone||''}; }));
  listEl.innerHTML = rows.map(r => `
    <div class="flex items-center gap-2">
      <div class="li-icon yellow" style="width:34px;height:34px;font-size:16px">🚴</div>
      <div style="flex:1"><div class="font-bold text-sm">${escHtml(r.courierName)}</div><div class="text-xs text-dim">${escHtml(r.phone)} · ${r.status==='confirmed'?'<span style="color:var(--success)">Подтвердил</span>':'Ожидает'}</div></div>
      <button class="btn btn-xs" style="background:var(--danger-soft);color:var(--danger);border:none;padding:4px 8px;border-radius:6px;cursor:pointer" onclick="saRemoveCourierFromVenue('${r.uid}','${venueId}')">×</button>
    </div>`).join('');
}

function saVenCountryChange(preselectCityId) {
  const countryId = document.getElementById('sa-ven-country')?.value;
  const citySelect = document.getElementById('sa-ven-city');
  if (!citySelect) return;
  const cities = ALL_CITIES.filter(c => !countryId || c.countryId === countryId);
  citySelect.innerHTML = '<option value="">Выберите город...</option>' + cities.map(c => `<option value="${c.id}" ${c.id === preselectCityId ? 'selected' : ''}>${escHtml(c.name)}</option>`).join('');
}

function toggleSaVenPayTag(method) {
  _saVenPayMethods[method] = !_saVenPayMethods[method];
  const btn = document.getElementById('sa-ven-pay-' + method);
  if (!btn) return;
  if (_saVenPayMethods[method]) btn.className = 'pay-tag ' + (method === 'cash' ? 'active-cash' : 'active-card');
  else btn.className = 'pay-tag';
}

function previewSaVenCover(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    _saVenCoverDataUrl = e.target.result;
    const wrap = document.getElementById('sa-ven-cover-upload');
    wrap.innerHTML = `<img src="${_saVenCoverDataUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><input type="file" id="sa-ven-cover-file" accept="image/*" onchange="previewSaVenCover(this)" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
  };
  reader.readAsDataURL(file);
}

async function saveSaVenue(venueId) {
  const name    = document.getElementById('sa-ven-name').value.trim();
  const catId   = document.getElementById('sa-ven-cat').value;
  const desc    = document.getElementById('sa-ven-desc').value.trim();
  const countryId = document.getElementById('sa-ven-country').value;
  const cityId  = document.getElementById('sa-ven-city').value;
  const street  = document.getElementById('sa-ven-street').value.trim();
  const house   = document.getElementById('sa-ven-house').value.trim();
  const office  = document.getElementById('sa-ven-office').value.trim();
  const phone   = document.getElementById('sa-ven-phone').value.trim();
  const open    = document.getElementById('sa-ven-open').value;
  const close   = document.getElementById('sa-ven-close').value;
  const delTime = parseInt(document.getElementById('sa-ven-deltime').value)||30;
  const delPrice= parseInt(document.getElementById('sa-ven-delprice').value)||0;
  const minOrd  = parseInt(document.getElementById('sa-ven-minorder').value)||0;
  const onlineEnabled = document.getElementById('sa-ven-online').checked;
  const coverUrl = document.getElementById('sa-ven-cover-url').value.trim() || _saVenCoverDataUrl || '';

  if (!name)   { showToast('Введите название', 'warning'); return; }
  if (!catId)  { showToast('Выберите категорию', 'warning'); return; }
  if (!street || !house) { showToast('Введите улицу и дом', 'warning'); return; }

  const city    = ALL_CITIES.find(c => c.id === cityId);
  const country = ALL_COUNTRIES.find(c => c.id === countryId);
  const addrParts = [street, house, office ? 'оф. ' + office : ''].filter(Boolean);
  const address = addrParts.join(', ');

  const isNew = !venueId || venueId === 'null';
  const vId = isNew ? genId() : venueId;
  const data = {
    id: vId, name, categoryId: catId, description: desc,
    addrStreet: street, addrHouse: house, addrOffice: office,
    address, phone,
    countryId: countryId||'', countryName: country?.name||'',
    cityId: cityId||'', cityName: city?.name||'',
    workOpen: open, workClose: close,
    deliveryTime: delTime, deliveryPrice: delPrice, minOrder: minOrd,
    paymentMethods: _saVenPayMethods,
    coverUrl, onlineOrdersEnabled: onlineEnabled,
    status: 'approved', blocked: false,
    ...(isNew ? { rating: 0, reviewCount: 0, createdAt: new Date().toISOString() } : {})
  };
  await dbSet('venues', vId, data);
  closeVenueSheet(); tgHaptic('success');
  showToast(isNew ? 'Заведение создано' : 'Заведение обновлено', 'success');
  await loadAllVenues();
}

async function saToggleVenueBlock(venueId, currentlyBlocked) {
  if (!confirm(currentlyBlocked?'Разблокировать заведение?':'Заблокировать заведение?')) return;
  await dbSet('venues', venueId, { blocked: !currentlyBlocked });
  closeVenueSheet(); tgHaptic('light');
  showToast(currentlyBlocked?'Разблокировано':'Заблокировано', 'info');
  loadAllVenues();
}

async function saAssignAdminToVenue(venueId) {
  const phone = document.getElementById('sa-ven-admin-phone')?.value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  try { await serverRateLimit(STATE.uid, 'qr'); }
  catch (e) { showToast(e.message, 'warning'); return; }
  const links = await dbGetAll('user_links');
  const link  = links.find(l => normPhone(l.phone||'') === normPhone(phone));
  if (!link)  { showToast('Пользователь не найден', 'error'); return; }
  const venue = await dbGet('venues', venueId);
  // Store invite keyed by venueId so multiple admins per venue work; use adminUid field
  await dbSet('admin_invites', link.uid, { uid: link.uid, venueId, venueName: venue?.name||'', venueAddress: venue?.address||'', saUid: STATE.uid, status: 'pending', createdAt: new Date().toISOString() });
  tgHaptic('success'); showToast('Приглашение отправлено', 'success');
  if (document.getElementById('sa-ven-admin-phone')) document.getElementById('sa-ven-admin-phone').value = '';
  const adminEl = document.getElementById('sa-ven-admin-info');
  if (adminEl) { adminEl.textContent = 'Приглашение отправлено, ожидает подтверждения'; adminEl.className = 'alert-box info'; }
}

async function saRemoveAdminFromVenue(venueId) {
  if (!confirm('Снять администратора с заведения?')) return;
  const venue = await dbGet('venues', venueId);
  if (venue?.adminUid) {
    await dbDelete('admin_invites', venue.adminUid);
    await dbSet('venues', venueId, { adminUid: null, adminName: null });
  }
  tgHaptic('light'); showToast('Администратор снят', 'info');
  const adminEl = document.getElementById('sa-ven-admin-info');
  if (adminEl) { adminEl.textContent = 'Администратор не назначен'; adminEl.className = 'alert-box info'; }
  const btn = document.getElementById('sa-ven-remove-admin-btn');
  if (btn) btn.style.display = 'none';
}

function saScanQrAdmin(venueId) {
  if (!tg?.showScanQrPopup) { showToast('QR-сканер доступен только в Telegram', 'warning'); return; }
  tg.showScanQrPopup({ text: 'Наведите камеру на QR-код администратора' }, data => {
    tg.closeScanQrPopup();
    const phone = normPhone(data||'');
    if (phone && document.getElementById('sa-ven-admin-phone')) document.getElementById('sa-ven-admin-phone').value = phone;
  });
}

async function saAssignOpToVenue(venueId) {
  const phone = document.getElementById('sa-ven-op-phone')?.value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  try { await serverRateLimit(STATE.uid, 'qr'); }
  catch (e) { showToast(e.message, 'warning'); return; }
  const links = await dbGetAll('user_links');
  const link  = links.find(l => normPhone(l.phone||'') === normPhone(phone));
  if (!link)  { showToast('Пользователь не найден', 'error'); return; }
  const venue = await dbGet('venues', venueId);
  await dbSet('operator_invites', link.uid, { uid: link.uid, venueId, venueName: venue?.name||'', venueAddress: venue?.address||'', adminUid: STATE.uid, status: 'pending', createdAt: new Date().toISOString() });
  await dbSet('venues', venueId, { operatorUid: link.uid });
  tgHaptic('success'); showToast('Приглашение оператору отправлено', 'success');
  if (document.getElementById('sa-ven-op-phone')) document.getElementById('sa-ven-op-phone').value = '';
  const opEl = document.getElementById('sa-ven-op-info');
  if (opEl) { opEl.textContent = 'Приглашение отправлено, ожидает подтверждения'; opEl.className = 'alert-box info'; }
  const btn = document.getElementById('sa-ven-remove-op-btn');
  if (btn) btn.style.display = '';
}

async function saRemoveOpFromVenue(venueId) {
  if (!confirm('Снять оператора с заведения?')) return;
  const venue = await dbGet('venues', venueId);
  if (venue?.operatorUid) {
    await dbDelete('operator_invites', venue.operatorUid);
    await dbSet('users', venue.operatorUid, { operatorVenueId: null });
  }
  await dbSet('venues', venueId, { operatorUid: null });
  tgHaptic('light'); showToast('Оператор снят', 'info');
  const opEl = document.getElementById('sa-ven-op-info');
  if (opEl) { opEl.textContent = 'Оператор не назначен'; opEl.className = 'alert-box info'; }
  const btn = document.getElementById('sa-ven-remove-op-btn');
  if (btn) btn.style.display = 'none';
}

function saScanQrOpForVenue(venueId) {
  if (!tg?.showScanQrPopup) { showToast('QR-сканер доступен только в Telegram', 'warning'); return; }
  tg.showScanQrPopup({ text: 'Наведите камеру на QR-код оператора' }, data => {
    tg.closeScanQrPopup();
    const phone = normPhone(data||'');
    if (phone && document.getElementById('sa-ven-op-phone')) document.getElementById('sa-ven-op-phone').value = phone;
  });
}

async function saAddCourierToVenue(venueId) {
  const phone = document.getElementById('sa-ven-courier-phone')?.value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  try { await serverRateLimit(STATE.uid, 'qr'); }
  catch (e) { showToast(e.message, 'warning'); return; }
  const links = await dbGetAll('user_links');
  const link  = links.find(l => normPhone(l.phone||'') === normPhone(phone));
  if (!link)  { showToast('Пользователь не найден', 'error'); return; }
  const courier = await dbGet('couriers', link.uid);
  if (!courier) { showToast('Этот пользователь не является курьером', 'error'); return; }
  const venue = await dbGet('venues', venueId);
  await dbSet('courier_venue_links', link.uid, { uid: link.uid, venueId, venueName: venue?.name||'', status: 'pending', invitedAt: new Date().toISOString() });
  tgHaptic('success'); showToast('Приглашение курьеру отправлено', 'success');
  if (document.getElementById('sa-ven-courier-phone')) document.getElementById('sa-ven-courier-phone').value = '';
  await _loadSaVenueCouriers(venueId);
}

async function saRemoveCourierFromVenue(uid, venueId) {
  await dbDelete('courier_venue_links', uid);
  showToast('Курьер удалён', 'info');
  await _loadSaVenueCouriers(venueId);
}

function saScanQrCourierForVenue(venueId) {
  if (!tg?.showScanQrPopup) { showToast('QR-сканер доступен только в Telegram', 'warning'); return; }
  tg.showScanQrPopup({ text: 'Наведите камеру на QR-код курьера' }, data => {
    tg.closeScanQrPopup();
    const phone = normPhone(data||'');
    if (phone && document.getElementById('sa-ven-courier-phone')) document.getElementById('sa-ven-courier-phone').value = phone;
  });
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
          <div class="li-title">${escHtml(c.name||'—')} ${rating}</div>
          <div class="li-sub">${escHtml(c.phone||'—')} · ${fmtDate(c.createdAt)}</div>
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
    <div class="sheet-title">${escHtml(courier.name||'Курьер')}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${escHtml(courier.phone||'—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Статус</span><span>${escHtml(courier.status||'—')}</span></div>
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
      <div class="li-body"><div class="li-title">${escHtml(v.name)}</div><div class="li-sub">${v.delivered} доставлено из ${v.orders}</div></div>
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

  if (role === 'courier') {
    const couriers = await dbGetAll('couriers');
    if (!couriers.length) { list.innerHTML = '<div class="empty" style="padding:30px 24px"><div class="empty-icon">🚴</div><div class="empty-text">Нет курьеров</div></div>'; return; }
    list.innerHTML = couriers.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(c => `
      <div class="list-item" onclick="openSaUser('${c.uid||c.id}')">
        <div class="li-icon yellow" style="font-size:22px">🚴</div>
        <div class="li-body">
          <div class="li-title">${escHtml(c.name||'—')}${c.status==='blocked'?' <span style="color:var(--danger);font-size:11px">BLOCKED</span>':''}</div>
          <div class="li-sub">${escHtml(c.phone||'—')} · <span style="color:${c.status==='active'?'var(--success)':c.status==='blocked'?'var(--danger)':'var(--warning)'}">${c.status==='active'?'Активен':c.status==='blocked'?'Заблокирован':'На проверке'}</span></div>
        </div>
        <div class="chevron">›</div>
      </div>`).join('');
    return;
  }

  // Load all users and filter by agreed* flags (catches multi-role accounts)
  const allUsers = await dbGetAll('users', null, 'asc', 500);
  const filterFn = {
    client:   u => !!(u.agreedClient || u.role === 'client'),
    admin:    u => !!(u.agreedAdmin  || u.role === 'admin'),
    operator: u => !!(u.agreedOperator || (u.role === 'operator')),
  }[role] || (() => false);
  const users = allUsers.filter(filterFn);

  if (!users.length) { list.innerHTML = '<div class="empty" style="padding:30px 24px"><div class="empty-icon">👤</div><div class="empty-text">Нет пользователей</div></div>'; return; }
  list.innerHTML = users.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(u => {
    const roleIcons = [];
    if (u.agreedClient   || u.role==='client')     roleIcons.push('👤');
    if (u.agreedAdmin    || u.role==='admin')       roleIcons.push('🏪');
    if (u.agreedOperator || u.role==='operator')    roleIcons.push('🎧');
    if (u.agreedSA       || u.role==='superadmin')  roleIcons.push('👑');
    return `
      <div class="list-item" onclick="openSaUser('${u.uid||u.id}')">
        <div class="avatar" style="width:36px;height:36px;font-size:14px">${escHtml((u.name||'?')[0].toUpperCase())}</div>
        <div class="li-body">
          <div class="li-title">${escHtml(u.name||'—')}${u.blocked?' <span style="color:var(--danger);font-size:11px">BLOCKED</span>':''}</div>
          <div class="li-sub">${escHtml(u.phone||'—')}${roleIcons.length?' · '+roleIcons.join(' '):''}</div>
        </div>
        <div class="chevron">›</div>
      </div>`;
  }).join('');
}

async function openSaUser(uid) {
  const [user, courierData] = await Promise.all([dbGet('users', uid), dbGet('couriers', uid)]);
  if (!user) return;
  const roleIcons = [];
  if (user.agreedClient   || user.role==='client')     roleIcons.push('👤 Клиент');
  if (user.agreedAdmin    || user.role==='admin')       roleIcons.push('🏪 Администратор');
  if (user.agreedOperator || user.role==='operator')    roleIcons.push('🎧 Оператор');
  if (courierData) roleIcons.push(`🚴 Курьер (${courierData.status==='active'?'активен':courierData.status==='blocked'?'заблокирован':'на проверке'})`);
  if (user.agreedSA || user.role==='superadmin')        roleIcons.push('👑 Суперадмин');
  const content = document.getElementById('sa-user-detail');
  content.innerHTML = `
    <div class="sheet-title">${escHtml(user.name||'—')}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${escHtml(user.phone||'—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Роли</span><span style="text-align:right;font-size:12px;max-width:60%">${roleIcons.join('<br>')||escHtml(user.role||'—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Город</span><span>${escHtml(user.cityName||'—')}</span></div>
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
  // If this user is also a courier, sync courier status
  const courierData = await dbGet('couriers', uid);
  if (courierData) {
    await dbSet('couriers', uid, { status: currentlyBlocked ? 'active' : 'blocked' });
  }
  closeUserSheet(); tgHaptic('light');
  showToast(currentlyBlocked?'Разблокирован':'Заблокирован', 'info');
  // Refresh current user tab
  const activeTab = document.querySelector('#s-sa-settings .cat-tab.active');
  if (activeTab) activeTab.click();
}

function closeUserSheet(e) {
  if (e && e.target !== document.getElementById('user-overlay')) return;
  document.getElementById('user-overlay').classList.remove('open');
}
