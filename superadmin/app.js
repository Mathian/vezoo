'use strict';
/* ============================================================
   VEZOO SUPERADMIN — Global Management Panel
   ============================================================ */

const STATE = { uid: null, user: null };
let ALL_CATS = [];
let _pinBuffer   = '';
let _saStatsPeriod = 7; // days; 0 = all time; -1 = custom range
let _saEditVenueId    = null;
let _saVenPayMethods  = { cash: true, card: true };
let _saVenCoverDataUrl = null;
let _saVenuesCache    = null;   // H-3: session-level cache; cleared on venue save/block
let _saClientCount    = null;   // H-3: session-level count; set once per session

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
  await registerFirebaseAuthMapping(STATE.uid);

  try { localStorage.removeItem('vez_users_' + STATE.uid); } catch {}
  const existing = await dbGet('users', STATE.uid);

  if (!existing?.agreedSA) {
    STATE.user = existing || { uid: STATE.uid, role: 'superadmin' };
    saveState();
    showAgreement();
    return;
  }
  STATE.user = existing; saveState();
  // Variant A: SA-triggered per-user cache reset
  if (existing.resetCache === true && !sessionStorage.getItem('_vez_reset_done')) {
    sessionStorage.setItem('_vez_reset_done', '1');
    try { await dbUpdate('users', STATE.uid, { resetCache: false }); } catch {}
    localStorage.clear(); location.reload(); return;
  }
  sessionStorage.removeItem('_vez_reset_done');
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
  ALL_CATS = VENUE_CATEGORIES;
  list.innerHTML = ALL_CATS.map(c => `
    <div class="list-item">
      <div class="li-icon yellow" style="font-size:24px">${c.icon||'📦'}</div>
      <div class="li-body"><div class="li-title">${c.name}</div></div>
    </div>`).join('');
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
  const cats = VENUE_CATEGORIES;
  list.innerHTML = venues.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(v => {
    const cat = cats.find(c=>c.id===v.categoryId);
    const badges = [];
    if (v.blocked) badges.push('<span class="badge badge-rejected">Блок</span>');
    if (v.onlineOrdersEnabled === false) badges.push('<span class="badge badge-moderation">Офлайн</span>');
    if (!v.blocked && v.onlineOrdersEnabled !== false) badges.push('<span class="badge badge-approved">Онлайн</span>');
    return `
      <div class="list-item" onclick="openSaVenueEdit('${v.id}')">
        <div class="li-icon yellow" style="font-size:24px">${cat?.icon||'🏪'}</div>
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
  const catsOpts = ALL_CATS.map(c => `<option value="${c.id}" ${venue?.categoryId===c.id?'selected':''}>${c.icon||''} ${c.name}</option>`).join('');
  _saVenPayMethods = { cash: venue?.paymentMethods?.cash!==false, card: venue?.paymentMethods?.card!==false };
  const onlineChecked = venue?.onlineOrdersEnabled !== false ? 'checked' : '';
  const venId = venue?.id || '';
  return `
    <div class="sheet-title">${isEdit ? venue.name : 'Новое заведение'}</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="section-title">Основное</div>
      <div class="field"><label>Название *</label><input class="inp" id="sa-ven-name" placeholder="Кафе «Уют»" value="${venue?.name||''}" maxlength="80"></div>
      <div class="field"><label>Категория *</label><select class="inp" id="sa-ven-cat"><option value="">Выберите...</option>${catsOpts}</select></div>
      <div class="field"><label>Описание</label><textarea class="inp" id="sa-ven-desc" rows="2" maxlength="500">${venue?.description||''}</textarea></div>

      <div class="section-title">Расположение</div>
      <div class="field"><label>Город</label><input class="inp" id="sa-ven-city" placeholder="Алматы" value="${venue?.cityName||''}" maxlength="60"></div>
      <div class="inp-row">
        <div class="field"><label>Улица *</label><input class="inp" id="sa-ven-street" placeholder="ул. Абая" value="${venue?.addrStreet||''}"></div>
        <div class="field" style="max-width:88px"><label>Дом *</label><input class="inp" id="sa-ven-house" placeholder="10" value="${venue?.addrHouse||''}"></div>
        <div class="field" style="max-width:78px"><label>Офис</label><input class="inp" id="sa-ven-office" placeholder="5" value="${venue?.addrOffice||''}"></div>
      </div>
      <div class="field"><label>Телефон</label><input class="inp" id="sa-ven-phone" type="tel" placeholder="+7 (777) 000-00-00" value="${venue?.phone||''}"></div>

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
  // Categories are now hard-coded — no Firestore read needed
  if (!ALL_CATS.length) ALL_CATS = VENUE_CATEGORIES;
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
      adminEl.textContent = 'Администратор не назначен';
      adminEl.className = 'alert-box info';
      if (removeAdminBtn) removeAdminBtn.style.display = 'none';
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
  // Дыра №7: one read for all couriers (couriers/all batch doc)
  const allCouriers = await getCourierAll();
  const rows = links.map(l => { const c = allCouriers[l.uid]; return {...l, courierName:c?.name||l.uid, phone:c?.phone||''}; });
  listEl.innerHTML = rows.map(r => `
    <div class="flex items-center gap-2">
      <div class="li-icon yellow" style="width:34px;height:34px;font-size:16px">🚴</div>
      <div style="flex:1"><div class="font-bold text-sm">${r.courierName}</div><div class="text-xs text-dim">${r.phone} · <span style="color:var(--success)">Постоянный</span></div></div>
      <button class="btn btn-xs" style="background:var(--danger-soft);color:var(--danger);border:none;padding:4px 8px;border-radius:6px;cursor:pointer" onclick="saRemoveCourierFromVenue('${r.uid}','${venueId}')">×</button>
    </div>`).join('');
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
  const cityName = document.getElementById('sa-ven-city').value.trim();
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

  const addrParts = [street, house, office ? 'оф. ' + office : ''].filter(Boolean);
  const address = addrParts.join(', ');

  const isNew = !venueId || venueId === 'null';
  const vId = isNew ? genId() : venueId;
  const data = {
    id: vId, name, categoryId: catId, description: desc,
    addrStreet: street, addrHouse: house, addrOffice: office,
    address, phone, cityName,
    workOpen: open, workClose: close,
    deliveryTime: delTime, deliveryPrice: delPrice, minOrder: minOrd,
    paymentMethods: _saVenPayMethods,
    coverUrl, onlineOrdersEnabled: onlineEnabled,
    status: 'approved', blocked: false,
    ...(isNew ? { createdAt: new Date().toISOString() } : {})
  };
  await dbSet('venues', vId, data);
  bumpVersion('venues'); // Дыра №4: invalidate client venue cache
  _saVenuesCache = null; // H-3: invalidate SA stats venue cache
  closeVenueSheet(); tgHaptic('success');
  showToast(isNew ? 'Заведение создано' : 'Заведение обновлено', 'success');
  await loadAllVenues();
}

async function saToggleVenueBlock(venueId, currentlyBlocked) {
  if (!confirm(currentlyBlocked?'Разблокировать заведение?':'Заблокировать заведение?')) return;
  await dbSet('venues', venueId, { blocked: !currentlyBlocked });
  bumpVersion('venues'); // Дыра №4
  _saVenuesCache = null; // H-3: invalidate SA stats venue cache
  closeVenueSheet(); tgHaptic('light');
  showToast(currentlyBlocked?'Разблокировано':'Заблокировано', 'info');
  loadAllVenues();
}

async function saAssignAdminToVenue(venueId) {
  const phone = document.getElementById('sa-ven-admin-phone')?.value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  const phoneKey = normPhone(phone).replace(/\D/g, '');
  const link = await dbGet('uid_index', phoneKey);
  if (!link?.uid) { showToast('Пользователь не найден', 'error'); return; }
  const user = await dbGet('users', link.uid);
  if (!user?.agreedAdmin) { showToast('Пользователь не зарегистрирован как администратор', 'error'); return; }
  // Direct assignment — no invite/confirmation needed
  await dbSet('venues', venueId, { adminUid: link.uid, adminName: user.name || '' });
  // Clean up any stale invite document
  try { await dbDelete('admin_invites', link.uid); } catch {}
  tgHaptic('success'); showToast('Администратор назначен', 'success');
  if (document.getElementById('sa-ven-admin-phone')) document.getElementById('sa-ven-admin-phone').value = '';
  const adminEl = document.getElementById('sa-ven-admin-info');
  const removeAdminBtn = document.getElementById('sa-ven-remove-admin-btn');
  if (adminEl) { adminEl.textContent = `Администратор: ${user.name||'—'} (${user.phone||phone})`; adminEl.className = 'alert-box success'; }
  if (removeAdminBtn) removeAdminBtn.style.display = '';
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

async function saAddCourierToVenue(venueId) {
  const phone = document.getElementById('sa-ven-courier-phone')?.value.trim();
  if (!phone) { showToast('Введите телефон', 'warning'); return; }
  const phoneKey = normPhone(phone).replace(/\D/g, '');
  const link = await dbGet('uid_index', phoneKey);
  if (!link?.uid) { showToast('Пользователь не найден', 'error'); return; }
  const courier = await getCourier(link.uid); // Дыра №7
  if (!courier) { showToast('Этот пользователь не является курьером', 'error'); return; }
  const venue = await dbGet('venues', venueId);
  // Direct assignment — confirmed immediately, no invite/confirmation step
  await dbSet('courier_venue_links', link.uid, {
    uid: link.uid, venueId, venueName: venue?.name||'', venueAddress: venue?.address||'',
    status: 'confirmed', assignedAt: new Date().toISOString()
  });
  // Also update courier doc so they see venue orders immediately
  await setCourier(link.uid, { ...courier, primaryVenueId: venueId, primaryVenueName: venue?.name||'' });
  tgHaptic('success'); showToast('Курьер прикреплён к заведению', 'success');
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
        </div>
        <span class="badge badge-${status==='pending'?'moderation':status==='active'?'approved':'rejected'}">${status==='pending'?'Проверка':status==='active'?'Активен':'Заблокирован'}</span>
      </div>`;
  }).join('');
}

async function openSaCourier(courierUid) {
  const courier = await getCourier(courierUid); // Дыра №7
  if (!courier) return;
  const deliveredOrders = (await dbQuery('orders','courierUid','==',courierUid)).filter(o=>o.status==='delivered');
  const totalRev = deliveredOrders.reduce((s,o)=>s+(o.total||0),0);
  const content = document.getElementById('sa-courier-detail');
  content.innerHTML = `
    <div class="sheet-title">${escHtml(courier.name||'Курьер')}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${escHtml(courier.phone||'—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Статус</span><span>${escHtml(courier.status)}</span></div>
      <div class="flex justify-between"><span class="text-dim">Доставлено</span><span class="font-bold">${deliveredOrders.length}</span></div>
      <div class="flex justify-between"><span class="text-dim">Город</span><span>${escHtml(courier.cityName||'—')}</span></div>
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
      <button class="btn btn-secondary btn-sm" onclick="saResetUserCache('${courierUid}')">🔄 Сбросить кэш</button>
    </div>`;
  document.getElementById('courier-detail-overlay').classList.add('open');
}

async function saApproveCourier(uid) {
  await setCourier(uid, { status: 'active', approvedAt: new Date().toISOString() }); // Дыра №7
  await dbSet('users',   uid, { role: 'courier' });
  await dbSet('admin_events', `courier_approved_${uid}`, { type:'courier_approved', uid, ts: new Date().toISOString() });
  closeCourierDetailSheet(); tgHaptic('success'); showToast('Курьер одобрен', 'success');
  loadCouriersByStatus('pending'); loadPendingBadges();
}

async function saBlockCourier(uid) {
  if (!confirm('Заблокировать / отклонить курьера?')) return;
  await setCourier(uid, { status: 'blocked', blockedAt: new Date().toISOString() }); // Дыра №7
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
  await loadSaStats();
  loadUsersByRole('client');
  // Restore active tab highlight
  const tabs = document.querySelectorAll('#sa-users-quick .cat-tab');
  tabs.forEach((t, i) => t.classList.toggle('active', i === 0));
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
  // H-3: Use session-level cache for static data (venues list, client count).
  // Only orders are queried per-period to avoid loading the full collection each time.
  if (!_saVenuesCache)    _saVenuesCache = await dbGetAll('venues');
  if (_saClientCount === null) {
    const clients = await dbQuery('users', 'agreedClient', '==', true);
    _saClientCount = clients.length;
  }
  const venues = _saVenuesCache;

  // Query only the orders that fall within the selected period.
  let orders;
  if (_saStatsPeriod === 0) {
    // All-time: limit to 2000 to avoid excessive reads
    orders = await dbGetAll('orders', 'createdAt', 'desc', 2000);
  } else if (_saStatsPeriod === -1) {
    // Custom date range
    const dfrom = document.getElementById('sa-date-from')?.value;
    const dto   = document.getElementById('sa-date-to')?.value;
    if (dfrom || dto) {
      const conditions = [];
      if (dfrom) conditions.push(['createdAt', '>=', dfrom + 'T00:00:00.000Z']);
      if (dto)   conditions.push(['createdAt', '<=', dto   + 'T23:59:59.999Z']);
      orders = await dbQueryWhere('orders', conditions, 'createdAt', 'desc', 2000);
    } else {
      orders = [];
    }
  } else {
    // Quick period (7/30/90 days): query only from cutoff onwards
    // REQUIRES Firestore index: orders — createdAt ASC (single-field, auto-created)
    const cutoff = new Date(Date.now() - _saStatsPeriod * 86400000).toISOString();
    orders = await dbQueryWhere('orders', [['createdAt', '>=', cutoff]], 'createdAt', 'desc', 2000);
  }

  const revenue = orders.filter(o=>o.status==='delivered').reduce((s,o)=>s+(o.total||0),0);
  const grid    = document.getElementById('sa-stats-grid');
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-val">${venues.filter(v=>v.status==='approved').length}</div><div class="stat-lbl">Заведений</div></div>
    <div class="stat-card"><div class="stat-val">${orders.filter(o=>o.status==='delivered').length}</div><div class="stat-lbl">Доставлено</div></div>
    <div class="stat-card"><div class="stat-val">${_saClientCount}</div><div class="stat-lbl">Клиентов</div></div>
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
let _saUserRoleTab = 'client'; // track active tab for context in user detail

function loadUsersByRole(role, el) {
  if (el) { document.querySelectorAll('#s-sa-settings .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  _saUserRoleTab = role;
  const list = document.getElementById('sa-users-list');
  list.innerHTML = '<div class="empty" style="padding:20px 0"><div class="empty-icon">🔍</div><div class="empty-text">Введите номер телефона для поиска</div></div>';
}

// ── Phone-based user search (within active role tab) ────────────────────────
async function searchSaUsers() {
  const rawInput = (document.getElementById('sa-user-search')?.value || '').trim();
  if (!rawInput) { showToast('Введите номер телефона', 'warning'); return; }
  const digits = rawInput.replace(/\D/g, '');
  if (digits.length < 4) { showToast('Введите минимум 4 цифры', 'warning'); return; }

  const list = document.getElementById('sa-users-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';

  const found = new Map(); // uid → doc
  const prefix = '+' + digits;

  if (_saUserRoleTab === 'courier') {
    // 1. Exact via uid_index → couriers doc
    try {
      const link = await dbGet('uid_index', digits);
      if (link?.uid) { const c = await getCourier(link.uid); if (c) found.set(link.uid, c); }
    } catch {}
    // 2. Prefix range on couriers.phone
    if (!found.size || digits.length < 11) {
      try {
        const results = await dbQueryWhere('couriers',
          [['phone', '>=', prefix], ['phone', '<=', prefix + String.fromCharCode(0xF8FF)]],
          null, 'asc', 20);
        for (const c of results) found.set(c.uid || c.id, c);
      } catch {}
    }
    if (!found.size) {
      list.innerHTML = '<div class="empty" style="padding:20px 0"><div class="empty-icon">🔍</div><div class="empty-text">Курьеры не найдены</div></div>';
      return;
    }
    list.innerHTML = [...found.values()].map(c => {
      const isBlocked = c.status === 'blocked';
      return `
        <div class="list-item" onclick="openSaUser('${c.uid||c.id}')">
          <div class="li-icon yellow" style="font-size:22px">🚴</div>
          <div class="li-body">
            <div class="li-title">${escHtml(c.name||'—')}${isBlocked?' <span style="color:var(--danger);font-size:10px;margin-left:4px">🚴 БЛК</span>':''}</div>
            <div class="li-sub">${escHtml(c.phone||'—')} · <span style="color:${c.status==='active'?'var(--success)':isBlocked?'var(--danger)':'var(--warning)'}">${c.status==='active'?'Активен':isBlocked?'Заблокирован':'На проверке'}</span></div>
          </div>
          <div class="chevron">›</div>
        </div>`;
    }).join('');
    return;
  }

  // Client / Admin — search in users collection
  // 1. Exact via uid_index
  try {
    const link = await dbGet('uid_index', digits);
    if (link?.uid) { const u = await dbGet('users', link.uid); if (u) found.set(link.uid, u); }
  } catch {}
  // 2. Prefix range on users.phone
  if (!found.size || digits.length < 11) {
    try {
      const results = await dbQueryWhere('users',
        [['phone', '>=', prefix], ['phone', '<=', prefix + String.fromCharCode(0xF8FF)]],
        null, 'asc', 20);
      for (const u of results) found.set(u.uid || u.id, u);
    } catch {}
  }
  // Filter by selected role tab
  const roleFilter = {
    client: u => !!(u.agreedClient || u.role === 'client'),
    admin:  u => !!(u.agreedAdmin  || u.role === 'admin'),
  }[_saUserRoleTab] || (() => true);
  for (const [uid, u] of [...found]) { if (!roleFilter(u)) found.delete(uid); }

  if (!found.size) {
    list.innerHTML = '<div class="empty" style="padding:20px 0"><div class="empty-icon">🔍</div><div class="empty-text">Пользователи не найдены</div></div>';
    return;
  }

  list.innerHTML = [...found.values()].map(u => {
    const roleIcons = [];
    if (u.agreedClient || u.role === 'client')    roleIcons.push('👤');
    if (u.agreedAdmin  || u.role === 'admin')      roleIcons.push('🏪');
    if (u.agreedSA     || u.role === 'superadmin') roleIcons.push('👑');
    const isRoleBlocked = _saUserRoleTab === 'client'
      ? !!(u.blocked || u.blockedClient)
      : !!(u.blocked || u.blockedAdmin);
    const blockBadge = isRoleBlocked
      ? `<span style="color:var(--danger);font-size:10px;margin-left:4px">${_saUserRoleTab==='client'?'👤':'🏪'} БЛК</span>`
      : '';
    return `
      <div class="list-item" onclick="openSaUser('${u.uid||u.id}')">
        <div class="avatar" style="width:36px;height:36px;font-size:14px">${(u.name||'?')[0].toUpperCase()}</div>
        <div class="li-body">
          <div class="li-title">${escHtml(u.name||'—')}${blockBadge}</div>
          <div class="li-sub">${escHtml(u.phone||'—')}${roleIcons.length?' · '+roleIcons.join(' '):''}</div>
        </div>
        <div class="chevron">›</div>
      </div>`;
  }).join('');
}

async function openSaUser(uid) {
  const [user, courierData] = await Promise.all([dbGet('users', uid), getCourier(uid)]); // Дыра №7
  if (!user) return;

  const hasClient  = !!(user.agreedClient || user.role === 'client');
  const hasAdmin   = !!(user.agreedAdmin  || user.role === 'admin');
  const hasCourier = !!courierData;
  const hasSA      = !!(user.agreedSA     || user.role === 'superadmin');

  // Per-role block state
  const clientBlocked  = !!(user.blocked || user.blockedClient);
  const adminBlocked   = !!(user.blocked || user.blockedAdmin);
  const courierBlocked = courierData?.status === 'blocked';

  // Role labels with block status
  const roleLines = [];
  if (hasClient)  roleLines.push(`👤 Клиент — <span style="color:${clientBlocked ?'var(--danger)':'var(--success)'};">${clientBlocked ?'заблокирован':'активен'}</span>`);
  if (hasAdmin)   roleLines.push(`🏪 Администратор — <span style="color:${adminBlocked  ?'var(--danger)':'var(--success)'};">${adminBlocked  ?'заблокирован':'активен'}</span>`);
  if (hasCourier) roleLines.push(`🚴 Курьер — <span style="color:${courierBlocked?'var(--danger)':courierData.status==='active'?'var(--success)':'var(--warning)'};">${courierBlocked?'заблокирован':courierData.status==='active'?'активен':'на проверке'}</span>`);
  if (hasSA)      roleLines.push('👑 Суперадмин');

  // Per-role block / unblock buttons
  const blockBtns = [];
  if (hasClient) {
    blockBtns.push(`<button class="btn ${clientBlocked?'btn-success':'btn-danger'} btn-sm" onclick="saToggleRoleBlock('${uid}','client',${clientBlocked})">
      ${clientBlocked?'🟢 Клиент: разблокировать':'🚫 Клиент: заблокировать'}
    </button>`);
  }
  if (hasAdmin) {
    blockBtns.push(`<button class="btn ${adminBlocked?'btn-success':'btn-danger'} btn-sm" onclick="saToggleRoleBlock('${uid}','admin',${adminBlocked})">
      ${adminBlocked?'🟢 Администратор: разблокировать':'🚫 Администратор: заблокировать'}
    </button>`);
  }
  if (hasCourier) {
    blockBtns.push(`<button class="btn ${courierBlocked?'btn-success':'btn-danger'} btn-sm" onclick="saToggleRoleBlock('${uid}','courier',${courierBlocked})">
      ${courierBlocked?'🟢 Курьер: разблокировать':'🚫 Курьер: заблокировать'}
    </button>`);
  }
  // Fallback: user has no roles yet
  if (!blockBtns.length) {
    const gb = !!user.blocked;
    blockBtns.push(`<button class="btn ${gb?'btn-success':'btn-danger'} btn-sm" onclick="saToggleRoleBlock('${uid}','global',${gb})">
      ${gb?'🟢 Разблокировать':'🚫 Заблокировать'}
    </button>`);
  }

  const content = document.getElementById('sa-user-detail');
  content.innerHTML = `
    <div class="sheet-title">${escHtml(user.name||'—')}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span style="font-family:monospace">${escHtml(user.phone||'—')}</span></div>
      <div class="flex justify-between align-start"><span class="text-dim">Роли</span><span style="text-align:right;font-size:12px;max-width:65%;line-height:1.6">${roleLines.join('<br>')||user.role||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Город</span><span>${escHtml(user.cityName||'—')}</span></div>
      <div class="flex justify-between"><span class="text-dim">Регистрация</span><span>${fmtDate(user.createdAt)}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${blockBtns.join('')}
      <button class="btn btn-secondary btn-sm" onclick="saResetUserCache('${uid}')">🔄 Сбросить кэш</button>
    </div>`;
  document.getElementById('user-overlay').classList.add('open');
}

async function saToggleRoleBlock(uid, role, currentlyBlocked) {
  const roleLabel = role === 'client' ? 'клиента' : role === 'admin' ? 'администратора' : role === 'courier' ? 'курьера' : 'пользователя';
  const action    = currentlyBlocked ? 'Разблокировать' : 'Заблокировать';
  if (!confirm(`${action} ${roleLabel}?`)) return;

  if (role === 'client') {
    await dbSet('users', uid, { blockedClient: !currentlyBlocked });
  } else if (role === 'admin') {
    await dbSet('users', uid, { blockedAdmin: !currentlyBlocked });
  } else if (role === 'courier') {
    const newStatus = currentlyBlocked ? 'active' : 'blocked';
    await setCourier(uid, { status: newStatus, ...(currentlyBlocked ? {} : { blockedAt: new Date().toISOString() }) }); // Дыра №7
    await dbSet('users', uid, { blockedCourier: !currentlyBlocked });
  } else {
    // global / no-role user
    await dbSet('users', uid, { blocked: !currentlyBlocked });
  }

  closeUserSheet(); tgHaptic('light');
  showToast(currentlyBlocked ? 'Разблокирован' : 'Заблокирован', 'info');
  // Refresh current user tab
  const activeTab = document.querySelector('#s-sa-settings .cat-tab.active');
  if (activeTab) activeTab.click();
}

async function saResetUserCache(uid) {
  await dbUpdate('users', uid, { resetCache: true });
  tgHaptic('light');
  showToast('Флаг сброса установлен. Сработает при следующем открытии приложения.', 'info');
}

function closeUserSheet(e) {
  if (e && e.target !== document.getElementById('user-overlay')) return;
  document.getElementById('user-overlay').classList.remove('open');
}
