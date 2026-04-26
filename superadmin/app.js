'use strict';
/* ============================================================
   VEZOO SUPERADMIN — Global Management Panel
   ============================================================ */

const STATE = { uid: null, user: null };
let ALL_CATS    = [];
let _editCatId  = null;
let _agreedCheck = false;

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') { localStorage.clear(); location.replace(location.pathname); return; }
  tgReady();
  // Back button: close overlay or hide
  if (tg?.BackButton) tg.BackButton.onClick(() => {
    const open = document.querySelector('.overlay.open');
    if (open) { open.classList.remove('open'); return; }
    tg.BackButton.hide();
  });
  const _tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try {
    const s = JSON.parse(localStorage.getItem('vez_sa_state') || '{}');
    if (!_tgUserId || s.tgId === _tgUserId) {
      STATE.uid = s.uid||null; STATE.user = s.user||null;
    }
  } catch {}
  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveState(); }
  await initFirebase();
  if (!STATE.uid) { const tgUid = await resolveUidByTgId(); if (tgUid) { STATE.uid = tgUid; saveState(); } }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  // Чистим localStorage-кэш пользователя чтобы получить свежие данные из Firestore
  try { localStorage.removeItem('vez_users_' + STATE.uid); } catch {}

  // Принудительно выставляем роль superadmin — доступ сюда только через SA-бот
  await dbSet('users', STATE.uid, { role: 'superadmin' });

  // Читаем свежие данные
  const existing = await dbGet('users', STATE.uid);

  if (!existing?.agreedSA) { STATE.user = existing || { uid: STATE.uid, role: 'superadmin' }; saveState(); showScreen('s-agree'); return; }
  STATE.user = existing; saveState();
  initMain();
});

function saveState() {
  const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem('vez_sa_state', JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId: tgUserId })); } catch {}
}

function toggleAgreeCheck() {
  const cb = document.getElementById('agree-cb');
  _agreedCheck = cb ? cb.checked : !_agreedCheck;
  document.getElementById('agree-box').textContent = _agreedCheck ? '✓' : '';
  document.getElementById('agree-check-row').classList.toggle('checked', _agreedCheck);
  document.getElementById('agree-btn').disabled = !_agreedCheck;
}

async function submitAgree() {
  await dbSet('users', STATE.uid, { agreedSA: true });
  STATE.user = { ...STATE.user, agreedSA: true }; saveState();
  initMain();
}

function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  startHeartbeat(STATE.uid);
  loadCategories();
  loadPendingBadges();
  showScreen('s-categories');
  setNav(document.getElementById('nav-cats'));
}

async function loadPendingBadges() {
  const pendingVenues  = await dbQuery('venues','status','==','pending');
  const pendingCouriers = await dbQuery('couriers','status','==','pending');
  const vb = document.getElementById('venues-badge');
  vb.textContent = pendingVenues.length; vb.classList.toggle('hidden', pendingVenues.length===0);
  const cb = document.getElementById('couriers-badge');
  cb.textContent = pendingCouriers.length; cb.classList.toggle('hidden', pendingCouriers.length===0);
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
        <button class="btn-icon btn-ghost" onclick="openEditCategory('${c.id}')">✏️</button>
        <button class="btn-icon btn-danger" onclick="deleteCategory('${c.id}')">🗑</button>
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
  closeCatSheet(); tgHaptic('success'); showToast(_editCatId?'Категория обновлена':'Категория добавлена', 'success');
  await loadCategories();
}

async function deleteCategory(catId) {
  const cat     = ALL_CATS.find(c => c.id === catId);
  const venues  = await dbQuery('venues','categoryId','==',catId);
  const confirm1 = confirm(`Удалить категорию "${cat?.name}"?${venues.length?`\n\n${venues.length} заведений потеряют категорию.`:''}`);
  if (!confirm1) return;
  await dbDelete('categories', catId);
  tgHaptic('light'); showToast('Категория удалена', 'info');
  await loadCategories();
}

function closeCatSheet(e) {
  if (e && e.target !== document.getElementById('cat-overlay')) return;
  document.getElementById('cat-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  VENUES
// ══════════════════════════════════════════════════════════
async function loadVenuesByStatus(status, el) {
  if (el) { document.querySelectorAll('#s-venues .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  const list = document.getElementById('sa-venues-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const venues = await dbQuery('venues','status','==',status);
  if (!venues.length) { list.innerHTML='<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">Нет заведений</div></div>'; return; }
  const cats  = await dbGetAll('categories');
  list.innerHTML = venues.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(v => {
    const cat = cats.find(c=>c.id===v.categoryId);
    return `
      <div class="list-item" onclick="openSaVenue('${v.id}')">
        <div class="li-icon yellow" style="font-size:24px">${cat?.icon||'🏪'}</div>
        <div class="li-body">
          <div class="li-title">${v.name}</div>
          <div class="li-sub">${cat?.name||'Без категории'} · ${v.address||'—'}</div>
          <div class="li-sub">${fmtDate(v.createdAt)}</div>
        </div>
        <span class="badge badge-${status==='pending'?'moderation':status==='approved'?'approved':'rejected'}">${status==='pending'?'Ожидает':status==='approved'?'Активно':'Отклонено'}</span>
      </div>`;
  }).join('');
}

async function openSaVenue(venueId) {
  const venue = await dbGet('venues', venueId);
  if (!venue) return;
  const owner = await dbGet('users', venue.ownerId);
  const cats  = await dbGetAll('categories');
  const cat   = cats.find(c=>c.id===venue.categoryId);
  const content = document.getElementById('sa-venue-detail');
  content.innerHTML = `
    <div class="sheet-title">${venue.name}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Категория</span><span>${cat?.icon||''} ${cat?.name||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${venue.address||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Владелец</span><span>${owner?.name||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${owner?.phone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Статус</span><span class="badge badge-${venue.status==='pending'?'moderation':venue.status==='approved'?'approved':'rejected'}">${venue.status}</span></div>
      <div class="flex justify-between"><span class="text-dim">Заблокировано</span><span>${venue.blocked?'Да':'Нет'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Описание</span><span style="text-align:right;max-width:60%;font-size:12px">${venue.description||'—'}</span></div>
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
      <div class="field"><label>Заметка (только для вас)</label><textarea class="inp" id="sa-venue-note" rows="2" placeholder="Причина отклонения...">${venue.saNote||''}</textarea></div>
      <button class="btn btn-ghost btn-sm" onclick="saveSaVenueNote('${venueId}')">💾 Сохранить заметку</button>
    </div>`;
  document.getElementById('venue-overlay').classList.add('open');
}

async function saApproveVenue(venueId) {
  await dbSet('venues', venueId, { status: 'approved', approvedAt: new Date().toISOString() });
  await dbSet('admin_events', `venue_approved_${venueId}`, { type: 'venue_approved', venueId, ts: new Date().toISOString() });
  closeVenueSheet(); tgHaptic('success'); showToast('Заведение одобрено', 'success');
  loadVenuesByStatus('pending'); loadPendingBadges();
}

async function saRejectVenue(venueId) {
  await dbSet('venues', venueId, { status: 'rejected', rejectedAt: new Date().toISOString() });
  await dbSet('admin_events', `venue_rejected_${venueId}`, { type: 'venue_rejected', venueId, ts: new Date().toISOString() });
  closeVenueSheet(); tgHaptic('light'); showToast('Заведение отклонено', 'info');
  loadVenuesByStatus('pending'); loadPendingBadges();
}

async function saToggleVenueBlock(venueId, currentlyBlocked) {
  if (!confirm(currentlyBlocked?'Разблокировать заведение?':'Заблокировать заведение?')) return;
  await dbSet('venues', venueId, { blocked: !currentlyBlocked });
  closeVenueSheet(); tgHaptic('light'); showToast(currentlyBlocked?'Разблокировано':'Заблокировано', 'info');
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
  if (!couriers.length) { list.innerHTML='<div class="empty"><div class="empty-icon">🚴</div><div class="empty-text">Нет курьеров</div></div>'; return; }
  list.innerHTML = couriers.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(c => `
    <div class="list-item" onclick="openSaCourier('${c.uid}')">
      <div class="li-icon yellow">🚴</div>
      <div class="li-body">
        <div class="li-title">${c.name||'—'}</div>
        <div class="li-sub">${c.phone||'—'} · ${fmtDate(c.createdAt)}</div>
        <div class="li-sub">${c.onShift?'<span style="color:var(--success)">На смене</span>':'Офлайн'}</div>
      </div>
      <span class="badge badge-${status==='pending'?'moderation':status==='active'?'approved':'rejected'}">${status==='pending'?'Проверка':status==='active'?'Активен':'Заблокирован'}</span>
    </div>`).join('');
}

async function openSaCourier(courierUid) {
  const courier = await dbGet('couriers', courierUid);
  if (!courier) return;
  const delivered = (await dbQuery('orders','courierUid','==',courierUid)).filter(o=>o.status==='delivered').length;
  const content = document.getElementById('sa-courier-detail');
  content.innerHTML = `
    <div class="sheet-title">${courier.name||'Курьер'}</div>
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${courier.phone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Статус</span><span>${courier.status}</span></div>
      <div class="flex justify-between"><span class="text-dim">На смене</span><span>${courier.onShift?'Да':'Нет'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Доставлено заказов</span><span class="font-bold">${delivered}</span></div>
      <div class="flex justify-between"><span class="text-dim">Регистрация</span><span>${fmtDate(courier.createdAt)}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${courier.status==='pending'?`
        <div class="btn-row">
          <button class="btn btn-danger btn-sm" onclick="saBlockCourier('${courierUid}')">🚫 Отклонить</button>
          <button class="btn btn-success btn-sm" onclick="saApproveCourier('${courierUid}')">✅ Одобрить</button>
        </div>`:''}
      ${courier.status==='active'?`
        <button class="btn btn-danger btn-sm" onclick="saBlockCourier('${courierUid}')">🚫 Заблокировать</button>`:''}
      ${courier.status==='blocked'?`
        <button class="btn btn-success btn-sm" onclick="saApproveCourier('${courierUid}')">🟢 Разблокировать</button>`:''}
    </div>`;
  document.getElementById('courier-detail-overlay').classList.add('open');
}

async function saApproveCourier(uid) {
  await dbSet('couriers', uid, { status: 'active', approvedAt: new Date().toISOString() });
  await dbSet('users',   uid, { role: 'courier' });
  await dbSet('admin_events', `courier_approved_${uid}`, { type: 'courier_approved', uid, ts: new Date().toISOString() });
  closeCourierDetailSheet(); tgHaptic('success'); showToast('Курьер одобрен', 'success');
  loadCouriersByStatus('pending'); loadPendingBadges();
}

async function saBlockCourier(uid) {
  if (!confirm('Заблокировать / отклонить курьера?')) return;
  await dbSet('couriers', uid, { status: 'blocked', blockedAt: new Date().toISOString(), onShift: false });
  await dbSet('users',   uid, { blocked: true });
  await dbSet('admin_events', `courier_blocked_${uid}`, { type: 'courier_blocked', uid, ts: new Date().toISOString() });
  closeCourierDetailSheet(); tgHaptic('light'); showToast('Курьер заблокирован', 'info');
  loadCouriersByStatus('pending'); loadPendingBadges();
}

function closeCourierDetailSheet(e) {
  if (e && e.target !== document.getElementById('courier-detail-overlay')) return;
  document.getElementById('courier-detail-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════════════════════
async function loadUsersByRole(role, el) {
  if (el) { document.querySelectorAll('#s-users .cat-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }
  const list = document.getElementById('sa-users-list');
  list.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const users = await dbQuery('users','role','==',role);
  if (!users.length) { list.innerHTML='<div class="empty"><div class="empty-icon">👤</div><div class="empty-text">Нет пользователей</div></div>'; return; }
  list.innerHTML = users.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).map(u => `
    <div class="list-item" onclick="openSaUser('${u.uid||u.id}')">
      <div class="avatar" style="width:36px;height:36px;font-size:14px">${(u.name||'?')[0].toUpperCase()}</div>
      <div class="li-body">
        <div class="li-title">${u.name||'—'}${u.blocked?' <span style="color:var(--danger);font-size:11px">BLOCKED</span>':''}</div>
        <div class="li-sub">${u.phone||'—'}</div>
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
    <div class="card card-body" style="margin-bottom:12px;gap:5px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Телефон</span><span>${user.phone||'—'}</span></div>
      <div class="flex justify-between"><span class="text-dim">Роль</span><span>${user.role||'—'}</span></div>
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
  closeUserSheet(); tgHaptic('light'); showToast(currentlyBlocked?'Разблокирован':'Заблокирован', 'info');
}

function closeUserSheet(e) {
  if (e && e.target !== document.getElementById('user-overlay')) return;
  document.getElementById('user-overlay').classList.remove('open');
}

// ══════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════
async function loadSaStats() {
  const [venues, orders, users, couriers] = await Promise.all([
    dbGetAll('venues'), dbGetAll('orders'), dbGetAll('users'), dbGetAll('couriers')
  ]);
  const revenue  = orders.filter(o=>o.status==='delivered').reduce((s,o)=>s+(o.total||0),0);
  const grid = document.getElementById('sa-stats-grid');
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-val">${venues.filter(v=>v.status==='approved').length}</div><div class="stat-lbl">Заведений</div></div>
    <div class="stat-card"><div class="stat-val">${orders.filter(o=>o.status==='delivered').length}</div><div class="stat-lbl">Доставлено</div></div>
    <div class="stat-card"><div class="stat-val">${users.filter(u=>u.role==='client').length}</div><div class="stat-lbl">Клиентов</div></div>
    <div class="stat-card"><div class="stat-val text-primary">${fmtPrice(revenue)}</div><div class="stat-lbl">Оборот</div></div>`;

  const venueStats = venues.filter(v=>v.status==='approved').map(v => {
    const vo  = orders.filter(o=>o.venueId===v.id);
    const rev = vo.filter(o=>o.status==='delivered').reduce((s,o)=>s+(o.total||0),0);
    return { name: v.name, orders: vo.length, delivered: vo.filter(o=>o.status==='delivered').length, revenue: rev };
  }).sort((a,b)=>b.revenue-a.revenue);

  document.getElementById('sa-stats-venues').innerHTML = venueStats.length ? `
    <div class="section-title" style="margin:8px 0 6px">По заведениям</div>
    ${venueStats.map(v=>`
      <div class="list-item" style="cursor:default;margin-bottom:6px">
        <div class="li-icon yellow">🏪</div>
        <div class="li-body"><div class="li-title">${v.name}</div><div class="li-sub">${v.delivered} доставлено из ${v.orders}</div></div>
        <div class="li-price">${fmtPrice(v.revenue)}</div>
      </div>`).join('')}` : '';
}

function setNav(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}
