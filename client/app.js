'use strict';
/* ============================================================
   VEZOO CLIENT — Customer Mini App
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUES        = [];
let CATEGORIES    = [];
let CURRENT_VENUE = null;
let VENUE_MENU    = [];
let CART          = {};
let ACTIVE_ORDERS = [];
let _ordersUnsub  = null;
let _shownNotifs      = new Set();
// Tracks which notification overlay is currently open for each orderId.
// When a newer notification arrives for the same order, the old one is
// closed automatically so only one notification per order is ever visible.
const _openNotifByOrder = {};
let _cdIntervals  = {};
let _paymentMethod   = 'cash';
let _deliveryType    = 'delivery';
let _intercomChecked = false;
let _cartOpenedFrom  = 'venue';
const _selectedCurrency = '₸';

// ── App version cache (Дыры №2, №3, №4) ──
// Версии хранятся в: versions/main → { venues: N, menu_venueId: N, ... }
let _appVersions    = {};
let _appVersionsTs  = 0;
async function _getAppVersions() {
  const now = Date.now();
  if (_appVersionsTs > 0 && now - _appVersionsTs < 5 * 60 * 1000) return _appVersions;
  try { _appVersions = await dbGet('versions', 'main') || {}; } catch {}
  _appVersionsTs = now;
  return _appVersions;
}

// ── Venue cache helpers (Дыра №4) ──
function _loadVenuesCache()        { try { return JSON.parse(localStorage.getItem('vez_venues_data') || '[]'); } catch { return []; } }
function _saveVenuesCache(arr, v)  { try { localStorage.setItem('vez_venues_data', JSON.stringify(arr)); localStorage.setItem('vez_local_venues_v', String(v)); } catch {} }
function _getLocalVenuesVersion()  { return parseInt(localStorage.getItem('vez_local_venues_v') || '0'); }

// ── Menu cache helpers (Дыры №2, №3) ──
function _loadMenuCache(venueId)       { try { return JSON.parse(localStorage.getItem('vez_menu_data_' + venueId) || '[]'); } catch { return []; } }
function _saveMenuCache(venueId, arr, v) { try { localStorage.setItem('vez_menu_data_' + venueId, JSON.stringify(arr)); localStorage.setItem('vez_local_menu_v_' + venueId, String(v)); } catch {} }
function _getLocalMenuVersion(venueId) { return parseInt(localStorage.getItem('vez_local_menu_v_' + venueId) || '0'); }

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') {
    localStorage.clear(); location.replace(location.pathname); return;
  }
  tgReady();
  _initBackButton();

  // Telegram ID — единственный ключ аутентификации
  const tgId = getTgId();

  try {
    const s = JSON.parse(localStorage.getItem('vez_client_state') || '{}');
    if (s.tgId === tgId) STATE.user = s.user || null;
    CART      = JSON.parse(localStorage.getItem('vez_cart') || '{}');
  } catch {}

  await initFirebase();

  // Открыто не через Telegram — доступ запрещён
  if (!tgId) {
    try {
      const el = document.querySelector('#s-no-uid .splash-sub');
      if (el) el.innerHTML = 'Откройте приложение через Telegram-бота Vezoo.<br><small style="font-size:9px;opacity:0.6;word-break:break-all;white-space:pre-wrap">' + escHtml(_tgDiag()) + '</small>';
    } catch {}
    showScreen('s-no-uid'); return;
  }

  STATE.uid = tgId;
  _saveClientState();
  const _authOk = await signInWithTelegramId(tgId, 'client');
  if (!_authOk) {
    const _ae = typeof _lastAuthError !== 'undefined' ? _lastAuthError : 'unknown';
    if (_ae === 'auth/credential-mismatch')
      showToast('🔑 Удалите пользователя в Firebase Console → Authentication → Users и перезайдите', 'error', 30000);
    else if (_ae === 'auth/too-many-requests')
      showToast('⏳ Firebase: слишком много попыток. Подождите 30–60 мин или смените сеть.', 'error', 30000);
    else
      showToast(`⚠️ Firebase auth: ${_ae}`, 'error', 15000);
  }

  const existing = await dbGet('clients', tgId);
  if (!existing) {
    if (_fbR) {
      // New user — register directly from MiniApp via tg.requestContact()
      try { localStorage.removeItem('vez_client_state'); } catch {}
      try { localStorage.removeItem('vez_client_orders_' + tgId); } catch {}
      try { localStorage.removeItem('vez_cart'); } catch {}
      _requestContactAndRegister();
    } else {
      // Offline + no local record — can't proceed
      const sub = document.getElementById('no-account-sub');
      if (sub) sub.innerHTML = 'Нет соединения.<br>Проверьте интернет и попробуйте снова.';
      const btn = document.getElementById('no-account-btn');
      if (btn) btn.style.display = 'none';
      showScreen('s-no-account');
    }
    return;
  }

  if (existing.blocked) { showScreen('s-blocked'); return; }

  // ── Всегда устанавливаем STATE.user сразу — чтобы телефон был доступен
  //    в submitAgree() и в профиле уже при первом открытии (Q2 fix)
  STATE.user = existing; _saveClientState();

  if (!existing.agreed) {
    document.getElementById('s-agree').style.display = 'flex';
    return;
  }

  if (!existing.name) {
    const autoName = _getTgName() || existing.firstName || 'Пользователь';
    await dbSet('clients', tgId, { name: autoName });
    existing.name = autoName;
    STATE.user = existing; _saveClientState();
  }

  // SA-triggered per-user cache reset
  if (existing.resetCache === true && !sessionStorage.getItem('_vez_reset_done')) {
    sessionStorage.setItem('_vez_reset_done', '1');
    try { await dbUpdate('clients', tgId, { resetCache: false }); } catch {}
    localStorage.clear(); location.reload(); return;
  }
  sessionStorage.removeItem('_vez_reset_done');
  initMain();
});

function _getTgName() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return null;
  return (u.first_name + (u.last_name ? ' ' + u.last_name : '')).trim() || null;
}

function _saveClientState() {
  try { localStorage.setItem('vez_client_state', JSON.stringify({ tgId: STATE.uid, user: STATE.user })); } catch {}
}
function _saveCart()      { try { localStorage.setItem('vez_cart', JSON.stringify(CART)); } catch {} }

// ══════════════════════════════════════════════════════════
//  REGISTRATION VIA MINIAPP (tg.requestContact)
// ══════════════════════════════════════════════════════════

// Запрашивает номер телефона через нативный Telegram-диалог.
// Telegram гарантирует, что это номер самого пользователя — нельзя отправить чужой.
// Доступно с Bot API 7.2 (большинство Telegram-клиентов поддерживают).
function _requestContactAndRegister() {
  if (!tg?.requestContact) {
    // Старая версия Telegram — показываем экран с просьбой обновить
    const sub = document.getElementById('no-account-sub');
    if (sub) sub.innerHTML = 'Обновите Telegram до последней версии<br>для автоматической регистрации.';
    showScreen('s-no-account');
    return;
  }

  // callback(isSent: boolean, event: { status, responseUnsafe: { phone_number, first_name, ... } })
  // Телефон находится в event.responseUnsafe, НЕ в event.contact
  tg.requestContact(async (isSent, event) => {
    if (!isSent) { showScreen('s-no-account'); return; }

    // responseUnsafe — плоский объект с данными контакта
    const rd           = event?.responseUnsafe || {};
    const phone_number = rd.phone_number || rd.contact?.phone_number || '';
    const ev_firstName = rd.first_name   || rd.contact?.first_name   || '';

    if (!phone_number) { showScreen('s-no-account'); return; }

    try {
      const raw   = String(phone_number).replace(/\D/g, '');
      const phone = '+' + (raw.startsWith('8') && raw.length === 11 ? '7' + raw.slice(1) : raw);

      const tgUser    = tg?.initDataUnsafe?.user;
      const firstName = tgUser?.first_name || ev_firstName || '';
      const lastName  = tgUser?.last_name  || '';
      const name      = [firstName, lastName].filter(Boolean).join(' ').trim() || firstName || 'Пользователь';

      const newUser = {
        phone,
        tgId:      String(STATE.uid),
        firstName,
        name,
        agreed:    false,
        createdAt: new Date().toISOString()
      };

      const ok = await dbSet('clients', STATE.uid, newUser);
      if (!ok) { showToast('Ошибка сохранения аккаунта. Проверьте подключение.', 'error', 6000); showScreen('s-no-account'); return; }
      STATE.user = newUser;
      _saveClientState();

      // Показываем соглашение
      document.getElementById('s-agree').style.display = 'flex';
    } catch (err) {
      showToast('Ошибка регистрации: ' + (err.message || err), 'error', 6000);
      showScreen('s-no-account');
    }
  });
}

// Кнопка «Поделиться номером» на экране s-no-account
function retryRequestContact() {
  // Возвращаем сплэш и повторяем запрос
  document.getElementById('s-no-account').classList.remove('active');
  document.getElementById('s-splash').classList.add('active');
  _requestContactAndRegister();
}

// ── Agreement ──
async function submitAgree() {
  const btn = document.getElementById('agree-btn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  // Бот уже создал документ — только помечаем agreed и устанавливаем имя
  const existingDoc = STATE.user || {};
  const autoName = _getTgName() || existingDoc.firstName || existingDoc.name || 'Пользователь';
  const patch = { agreed: true, name: autoName };
  await dbSet('clients', STATE.uid, patch);
  STATE.user = { ...existingDoc, ...patch };
  _saveClientState();
  if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  document.getElementById('s-agree').style.display = 'none';
  initMain();
}

// ── Boot history sync — reads ONLY orders that were in-flight when app closed ──
// Key scenario: app was closed while order was 'delivering' → localStorage has stale status.
// On next open, Firestore has 'delivered'/'cancelled' but docChanges() never fired.
//
// Optimisation: final-state orders (delivered/cancelled/issued) never change — no need to
// re-read them every session. We read only the IDs that were still active (non-final) in
// localStorage. Typically 0–2 docs instead of a full 50-doc query.
async function _ensureOrderHistory() {
  const FINAL = ['delivered', 'cancelled', 'issued'];
  const stored = _loadOrdersFromStorage();

  // Only orders that could have changed while the app was closed
  const needsSync = stored.filter(o => !FINAL.includes(o.status));
  if (!needsSync.length) return; // Everything already final — nothing to read

  try {
    const freshDocs = await Promise.all(
      needsSync.map(o => dbGet('orders', o.id))
    );

    const byId = {};
    for (const o of stored) byId[o.id] = o;

    let changed = false;
    for (let i = 0; i < needsSync.length; i++) {
      const fresh   = freshDocs[i];
      const orderId = needsSync[i].id;
      if (!fresh) continue; // order no longer exists — keep local copy as-is
      if ((byId[orderId]?.status ?? '') !== fresh.status) {
        byId[orderId] = { id: orderId, ...fresh };
        changed = true;
      }
    }

    if (changed) {
      _saveOrdersToStorage(Object.values(byId));
    }
  } catch (e) { console.warn('[boot] ensureOrderHistory:', e.message); }
}

// ── Init main ──
async function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  // Pre-load app versions for cache validation
  await _getAppVersions();
  // Point 3: recover history from Firestore if localStorage was cleared
  await _ensureOrderHistory();
  loadVenues();
  watchActiveOrders();
  showScreen('s-home');
}

// ══════════════════════════════════════════════════════════
//  HOME — Venue list
// ══════════════════════════════════════════════════════════
async function loadVenues() {
  // Дыра №4: version-based localStorage cache
  const versions  = await _getAppVersions();
  const remoteV   = versions.venues || 0;
  const localV    = _getLocalVenuesVersion();

  let allVenues;
  if (remoteV > 0 && remoteV === localV) {
    // Use localStorage cache — no Firestore read
    allVenues = _loadVenuesCache();
    if (!allVenues.length) {
      // Cache corrupt/empty — force refresh
      allVenues = await dbGetAll('venues', 'name', 'asc');
      _saveVenuesCache(allVenues, remoteV);
    }
  } else {
    // Fetch fresh from Firestore and update cache
    allVenues = await dbGetAll('venues', 'name', 'asc');
    _saveVenuesCache(allVenues, remoteV);
  }

  VENUES     = allVenues.filter(v => v.status === 'approved' && !v.blocked && v.onlineOrdersEnabled !== false);
  const usedCatIds = new Set(VENUES.map(v => v.categoryId).filter(Boolean));
  CATEGORIES = VENUE_CATEGORIES.filter(c => usedCatIds.has(c.id));
  renderCatTabs();
  renderVenues(null);
}

function renderCatTabs() {
  const container = document.getElementById('home-cat-tabs');
  const tabs = [{ id: null, name: 'Все', icon: '🏪' }, ...CATEGORIES.map(c => ({ id: c.id, name: c.name, icon: c.icon || '📦' }))];
  container.innerHTML = tabs.map((c, i) =>
    `<button class="cat-tab${i === 0 ? ' active' : ''}" onclick="filterVenues(this,'${c.id || ''}')">${c.icon} ${c.name}</button>`
  ).join('');
}

function filterVenues(el, catId) {
  document.querySelectorAll('#home-cat-tabs .cat-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderVenues(catId || null);
}

function renderVenues(catId) {
  let list = VENUES;
  if (catId) list = list.filter(v => v.categoryId === catId);
  const container = document.getElementById('home-venues');
  if (!list.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">Заведений пока нет</div></div>`;
    return;
  }
  container.innerHTML = list.map(v => {
    const cat    = CATEGORIES.find(c => c.id === v.categoryId);
    const open   = isVenueOpen(v);
    const cover  = v.coverUrl
      ? `<img src="${v.coverUrl}" onerror="this.style.display='none'" style="width:100%;height:100%;object-fit:cover">`
      : `<span style="font-size:48px">${cat?.icon || '🏪'}</span>`;
    const venueCartCount = (CART[v.id] || []).reduce((s, c) => s + c.qty, 0);
    const cartBadge = venueCartCount > 0
      ? `<span style="background:var(--primary);color:#000;border-radius:999px;font-size:11px;font-weight:700;padding:2px 8px;margin-left:6px">${venueCartCount} в корзине</span>`
      : '';
    return `
      <div class="venue-card" onclick="openVenue('${v.id}')">
        <div class="venue-card-img">${cover}</div>
        <div class="venue-card-body">
          <div class="flex justify-between items-center">
            <div class="venue-card-name">${escHtml(v.name)}${cartBadge}</div>
          </div>
          <div class="venue-card-meta">
            ${cat ? `<span class="cat-pill">${cat.icon || ''} ${cat.name}</span>` : ''}
          </div>
          <div class="venue-card-foot">
            <span class="${open ? 'venue-open' : 'venue-closed'}">${open ? '● Открыто' : '● Закрыто'}</span>
            <span class="venue-delivery-info">🚴 ${v.deliveryTime || '?'} мин · ${fmtPrice(v.deliveryPrice || 0, _selectedCurrency)}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function isVenueOpen(v) {
  if (!v.workOpen || !v.workClose) return true;
  const now  = new Date();
  const [oh, om] = v.workOpen.split(':').map(Number);
  const [ch, cm] = v.workClose.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= oh * 60 + om && mins < ch * 60 + cm;
}

// ══════════════════════════════════════════════════════════
//  VENUE DETAIL
// ══════════════════════════════════════════════════════════
async function openVenue(venueId) {
  const venue = VENUES.find(v => v.id === venueId);
  if (!venue) return;
  CURRENT_VENUE = venue;

  const imgEl   = document.getElementById('venue-cover-img');
  const emojiEl = document.getElementById('venue-cover-emoji');
  const cat     = CATEGORIES.find(c => c.id === venue.categoryId);
  if (venue.coverUrl) {
    imgEl.src = venue.coverUrl; imgEl.style.display = 'block'; emojiEl.style.display = 'none';
  } else {
    imgEl.style.display = 'none'; emojiEl.textContent = cat?.icon || '🏪'; emojiEl.style.display = '';
  }

  document.getElementById('venue-name-el').textContent = venue.name;
  const open = isVenueOpen(venue);
  const openEl = document.getElementById('venue-open-el');
  openEl.textContent = open ? '● Открыто' : '● Закрыто';
  openEl.className   = open ? 'venue-open' : 'venue-closed';
  document.getElementById('venue-closed-banner').classList.toggle('hidden', open);

  document.getElementById('venue-meta-el').innerHTML = `
    ${cat ? `<span class="cat-pill">${cat.icon || ''} ${cat.name}</span>` : ''}
    ${venue.workOpen ? `<span class="venue-delivery-info">🕐 ${venue.workOpen}–${venue.workClose}</span>` : ''}
    ${venue.address  ? `<span class="venue-delivery-info">📍 ${escHtml(venue.address)}</span>` : ''}
    ${venue.phone    ? `<a class="venue-delivery-info venue-phone-link" href="tel:${escHtml(venue.phone)}" onclick="event.preventDefault();callPhone('${escHtml(venue.phone)}')" >${escHtml(venue.phone)}</a>` : ''}`;

  showScreen('s-venue');
  await loadVenueMenu(venueId);
}

function backToHome() { showScreen('s-home'); setNav(document.getElementById('nav-home')); }

async function loadVenueMenu(venueId) {
  const grid = document.getElementById('venue-menu-grid');
  grid.innerHTML = '<div class="loader" style="grid-column:1/-1"><div class="spinner"></div></div>';

  // Дыры №2 и №3: version-based localStorage cache
  const versions = await _getAppVersions();
  const remoteV  = versions['menu_' + venueId] || 0;
  const localV   = _getLocalMenuVersion(venueId);

  let allItems;
  if (remoteV > 0 && remoteV === localV) {
    // Версия совпадает — берём из localStorage (0 читов Firestore)
    allItems = _loadMenuCache(venueId);
    if (!allItems.length) {
      const bundle = await dbGet('menu_bundles', venueId);
      allItems = bundle?.items || [];
      _saveMenuCache(venueId, allItems, remoteV);
    }
  } else {
    // Версия устарела — читаем бандл (1 чит вместо N)
    const bundle = await dbGet('menu_bundles', venueId);
    allItems = bundle?.items || [];
    _saveMenuCache(venueId, allItems, remoteV);
  }

  VENUE_MENU = allItems.filter(i => i.available !== false);

  // Auto-clean cart: remove positions that were deleted or hidden since last visit
  const _pruned = _pruneCartForVenue(venueId);
  if (_pruned > 0) showToast(`${_pruned} позиц. удалено из корзины (недоступны)`, 'warning', 4000);

  const menuCats = ['Все', ...new Set(VENUE_MENU.map(i => i.category).filter(Boolean))];
  document.getElementById('venue-cat-tabs').innerHTML = menuCats.map((c, i) =>
    `<button class="cat-tab${i === 0 ? ' active' : ''}" onclick="filterVenueMenu(this,'${c}')">${c}</button>`
  ).join('');
  renderVenueMenuGrid(null);
}

function filterVenueMenu(el, cat) {
  document.querySelectorAll('#venue-cat-tabs .cat-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderVenueMenuGrid(cat === 'Все' ? null : cat);
}

function renderVenueMenuGrid(cat) {
  const items = cat ? VENUE_MENU.filter(i => i.category === cat) : VENUE_MENU;
  const grid  = document.getElementById('venue-menu-grid');
  if (!items.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-icon">🍽️</div><div class="empty-text">Нет позиций</div></div>';
    return;
  }
  const venueId   = CURRENT_VENUE?.id;
  const venueCart = CART[venueId] || [];

  grid.innerHTML = items.map(item => {
    const imgHtml = item.imageUrl
      ? `<div class="menu-card-img"><img src="${item.imageUrl}" alt="${escHtml(item.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<span style=font-size:44px>${item.emoji || '🍽️'}</span>'"></div>`
      : `<div class="menu-card-img"><span style="font-size:44px">${item.emoji || '🍽️'}</span></div>`;
    // В карточке — только первая строка описания (до первого переноса)
    const descFirst = item.description ? escHtml(item.description.split('\n')[0]) : '';

    if (item.variants && item.variants.length > 0) {
      const minPrice = Math.min(...item.variants.map(v => v.price));
      const maxPrice = Math.max(...item.variants.map(v => v.price));
      const priceLabel = minPrice === maxPrice
        ? fmtPrice(minPrice, _selectedCurrency)
        : `от ${fmtPrice(minPrice, _selectedCurrency)}`;
      const totalQty = item.variants.reduce((s, v) => {
        const key = `${item.id}::${v.name}`;
        return s + (venueCart.find(c => c.cartKey === key)?.qty || 0);
      }, 0);
      const badge = totalQty > 0 ? `<div class="menu-card-badge">${totalQty}</div>` : '';
      // Вся карточка кликабельна; stopPropagation на + чтобы не открылся дважды
      return `<div class="menu-card" id="mc-${item.id}" onclick="openVariantModal('${item.id}')"><div class="menu-card-img-wrap">${imgHtml}${badge}</div><div class="menu-card-body"><div class="menu-card-name">${escHtml(item.name)}</div>${descFirst ? `<div class="menu-card-desc">${descFirst}</div>` : ''}<div class="qty-row"><div class="menu-card-price">${priceLabel}</div><div class="qty-ctrl"><div class="qty-btn add" onclick="event.stopPropagation();openVariantModal('${item.id}')">+</div></div></div></div></div>`;
    } else {
      const cartItem = venueCart.find(c => c.cartKey === item.id);
      const qty = cartItem ? cartItem.qty : 0;
      // Карточка открывает модал; +/- работают inline (stopPropagation)
      return `<div class="menu-card" id="mc-${item.id}" onclick="openVariantModal('${item.id}')">${imgHtml}<div class="menu-card-body"><div class="menu-card-name">${escHtml(item.name)}</div>${descFirst ? `<div class="menu-card-desc">${descFirst}</div>` : ''}<div class="qty-row"><div class="menu-card-price">${fmtPrice(item.price, _selectedCurrency)}</div><div class="qty-ctrl">${qty > 0 ? `<div class="qty-btn" onclick="event.stopPropagation();changeQty('${item.id}',-1)">−</div><div class="qty-num" id="qn-${item.id}">${qty}</div>` : ''}<div class="qty-btn add" onclick="event.stopPropagation();changeQty('${item.id}',1)">+</div></div></div></div></div>`;
    }
  }).join('');
}

// ── Cart management ──

// Removes cart items for venueId that are no longer in VENUE_MENU
// (deleted or hidden by admin). Returns the count of removed items.
function _pruneCartForVenue(venueId) {
  const cart = CART[venueId];
  if (!cart?.length) return 0;
  const validIds = new Set(VENUE_MENU.map(i => i.id));
  const before = cart.length;
  CART[venueId] = cart.filter(c => validIds.has(c.id));
  if (!CART[venueId].length) delete CART[venueId];
  const removed = before - (CART[venueId]?.length ?? 0);
  if (removed > 0) { _saveCart(); updateCartNavBadge(); }
  return removed;
}

// Clears the entire cart for a given venue (user-initiated)
function clearVenueCart(venueId) {
  delete CART[venueId];
  _saveCart(); updateCartNavBadge();
  renderCartOverview(); tgHaptic('light');
  showToast('Корзина очищена', 'info');
}

function changeQty(itemId, delta, variantName = null) {
  tgHaptic('light');
  const menuItem = VENUE_MENU.find(i => i.id === itemId);
  if (!menuItem) return;
  const venueId = CURRENT_VENUE?.id;
  if (!venueId) return;
  if (!CART[venueId]) CART[venueId] = [];
  const key = variantName ? `${itemId}::${variantName}` : itemId;
  let cartItem = CART[venueId].find(c => c.cartKey === key);
  if (!cartItem) {
    if (delta < 0) return;
    const price = variantName
      ? (menuItem.variants?.find(v => v.name === variantName)?.price ?? menuItem.price)
      : menuItem.price;
    const name = variantName ? `${menuItem.name} (${variantName})` : menuItem.name;
    cartItem = { cartKey: key, id: itemId, variantName: variantName || null, name, price, qty: 0, emoji: menuItem.emoji || '🍽️' };
    CART[venueId].push(cartItem);
  }
  cartItem.qty = Math.max(0, cartItem.qty + delta);
  if (cartItem.qty === 0) CART[venueId] = CART[venueId].filter(c => c.cartKey !== key);
  if (!CART[venueId]?.length) delete CART[venueId];
  _saveCart();
  updateMenuItemUI(itemId);
  updateCartNavBadge();
}

function updateMenuItemUI(itemId) {
  const menuItem = VENUE_MENU.find(i => i.id === itemId);
  if (!menuItem) return;
  const venueId   = CURRENT_VENUE?.id;
  const venueCart = CART[venueId] || [];
  if (menuItem.variants?.length > 0) {
    // Обновляем бейдж (суммарное кол-во) на компактной карточке
    const totalQty = menuItem.variants.reduce((s, v) => {
      const key = `${itemId}::${v.name}`;
      return s + (venueCart.find(c => c.cartKey === key)?.qty || 0);
    }, 0);
    const card = document.getElementById(`mc-${itemId}`);
    if (card) {
      let badge = card.querySelector('.menu-card-badge');
      if (totalQty > 0) {
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'menu-card-badge';
          (card.querySelector('.menu-card-img-wrap') || card).appendChild(badge);
        }
        badge.textContent = totalQty;
      } else if (badge) {
        badge.remove();
      }
    }
    // Обновляем строки в модалке, если она сейчас открыта для этого товара
    menuItem.variants.forEach(v => {
      const key    = `${itemId}::${v.name}`;
      const qty    = (venueCart.find(c => c.cartKey === key) || { qty: 0 }).qty;
      const safeId = CSS.escape(key);
      const row    = document.getElementById(`vmr-${safeId}`);
      if (!row) return;
      const ctrl = row.querySelector('.qty-ctrl');
      if (!ctrl) return;
      ctrl.innerHTML = qty > 0
        ? `<div class="qty-btn" onclick="changeQty('${itemId}',-1,'${v.name}')">−</div><div class="qty-num">${qty}</div><div class="qty-btn add" onclick="changeQty('${itemId}',1,'${v.name}')">+</div>`
        : `<div class="qty-btn add" onclick="changeQty('${itemId}',1,'${v.name}')">+</div>`;
    });
  } else {
    const qty  = (venueCart.find(c => c.cartKey === itemId) || { qty: 0 }).qty;
    // Обновляем кнопки в карточке (stopPropagation — карточка сама открывает модал)
    const ctrl = document.querySelector(`#mc-${itemId} .qty-ctrl`);
    if (ctrl) {
      ctrl.innerHTML = qty > 0
        ? `<div class="qty-btn" onclick="event.stopPropagation();changeQty('${itemId}',-1)">−</div><div class="qty-num" id="qn-${itemId}">${qty}</div><div class="qty-btn add" onclick="event.stopPropagation();changeQty('${itemId}',1)">+</div>`
        : `<div class="qty-btn add" onclick="event.stopPropagation();changeQty('${itemId}',1)">+</div>`;
    }
    // Обновляем строку в модале, если модал сейчас открыт для этого товара
    const modalRow = document.getElementById(`vmr-${CSS.escape(itemId)}`);
    if (modalRow) {
      const modalCtrl = modalRow.querySelector('.qty-ctrl');
      if (modalCtrl) {
        modalCtrl.innerHTML = qty > 0
          ? `<div class="qty-btn" onclick="changeQty('${itemId}',-1)">−</div><div class="qty-num">${qty}</div><div class="qty-btn add" onclick="changeQty('${itemId}',1)">+</div>`
          : `<div class="qty-btn add" onclick="changeQty('${itemId}',1)">+</div>`;
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
//  VARIANT MODAL
// ══════════════════════════════════════════════════════════
function openVariantModal(itemId) {
  tgHaptic('light');
  const item = VENUE_MENU.find(i => i.id === itemId);
  if (!item) return;

  const modal = document.getElementById('variant-modal');
  modal.dataset.itemId = itemId;

  // Изображение
  document.getElementById('vm-img').innerHTML = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="" style="width:100%;height:210px;object-fit:cover" onerror="this.parentElement.innerHTML='<div style=height:120px;background:var(--card-2);display:flex;align-items:center;justify-content:center;font-size:64px>${item.emoji || '🍽️'}</div>'">`
    : `<div style="height:120px;background:var(--card-2);display:flex;align-items:center;justify-content:center;font-size:64px">${item.emoji || '🍽️'}</div>`;

  document.getElementById('vm-name').textContent = item.name;
  const descEl = document.getElementById('vm-desc');
  descEl.textContent = item.description || '';
  descEl.style.whiteSpace = 'pre-line'; // переносы строк как у администратора
  descEl.style.display = item.description ? '' : 'none';

  _renderVariantModalRows(item);

  modal.classList.remove('hidden');
  requestAnimationFrame(() => modal.classList.add('vm-open'));
}

function _renderVariantModalRows(item) {
  const venueId   = CURRENT_VENUE?.id;
  const venueCart = CART[venueId] || [];

  if (!item.variants || item.variants.length === 0) {
    // Одиночный товар — одна строка с ценой и кнопками +/-
    const qty = (venueCart.find(c => c.cartKey === item.id) || { qty: 0 }).qty;
    document.getElementById('vm-variants').innerHTML = `
      <div class="vm-variant-row" id="vmr-${CSS.escape(item.id)}">
        <div>
          <div class="variant-price">${fmtPrice(item.price, _selectedCurrency)}</div>
        </div>
        <div class="qty-ctrl">
          ${qty > 0 ? `<div class="qty-btn" onclick="changeQty('${item.id}',-1)">−</div><div class="qty-num">${qty}</div>` : ''}
          <div class="qty-btn add" onclick="changeQty('${item.id}',1)">+</div>
        </div>
      </div>`;
    return;
  }

  document.getElementById('vm-variants').innerHTML = item.variants.map(v => {
    const key = `${item.id}::${v.name}`;
    const qty = (venueCart.find(c => c.cartKey === key) || { qty: 0 }).qty;
    return `<div class="vm-variant-row" id="vmr-${CSS.escape(key)}">
      <div>
        <div class="variant-name">${escHtml(v.name)}</div>
        <div class="variant-price">${fmtPrice(v.price, _selectedCurrency)}</div>
      </div>
      <div class="qty-ctrl">
        ${qty > 0 ? `<div class="qty-btn" onclick="changeQty('${item.id}',-1,'${v.name}')">−</div><div class="qty-num">${qty}</div>` : ''}
        <div class="qty-btn add" onclick="changeQty('${item.id}',1,'${v.name}')">+</div>
      </div>
    </div>`;
  }).join('');
}

function closeVariantModal() {
  const modal = document.getElementById('variant-modal');
  modal.classList.remove('vm-open');
  setTimeout(() => modal.classList.add('hidden'), 290);
}

function updateCartNavBadge() {
  const cnt   = Object.keys(CART).filter(id => CART[id]?.length > 0).length;
  const badge = document.getElementById('cart-nav-badge');
  if (!badge) return;
  badge.textContent = cnt;
  badge.classList.toggle('hidden', cnt === 0);
}


function venueCartTotal(venueId) {
  return (CART[venueId] || []).reduce((s, c) => s + c.price * c.qty, 0);
}

// ══════════════════════════════════════════════════════════
//  CART OVERVIEW
// ══════════════════════════════════════════════════════════
function navToCart() { showScreen('s-cart-overview'); renderCartOverview(); }

function renderCartOverview() {
  const container = document.getElementById('cart-overview-content');
  const venueIds  = Object.keys(CART).filter(id => CART[id]?.length > 0);
  if (!venueIds.length) {
    container.innerHTML = `<div class="empty" style="padding-top:40px"><div class="empty-icon">🛒</div><div class="empty-text">Корзина пуста</div><button class="btn btn-primary" style="margin-top:20px" onclick="navTo('s-home');setNav(document.getElementById('nav-home'))">🏪 К заведениям</button></div>`;
    return;
  }
  container.innerHTML = venueIds.map(venueId => {
    const venue    = VENUES.find(v => v.id === venueId);
    const items    = CART[venueId];
    const totalQty = items.reduce((s, c) => s + c.qty, 0);
    const totPrc   = items.reduce((s, c) => s + c.price * c.qty, 0);
    const cat      = venue ? CATEGORIES.find(c => c.id === venue.categoryId) : null;
    const open     = venue ? isVenueOpen(venue) : true;
    return `
      <div class="card card-body" style="gap:12px">
        <div class="flex justify-between items-center">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:22px">${cat?.icon || '🏪'}</span>
            <div class="font-bold">${venue?.name || venueId}</div>
          </div>
          <span class="${open ? 'venue-open' : 'venue-closed'}" style="font-size:12px">${open ? '● Открыто' : '● Закрыто'}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${items.slice(0, 3).map(c => `<div class="flex justify-between" style="font-size:13px"><span>${c.emoji} ${c.name}</span><span class="text-dim">${c.qty} × ${fmtPrice(c.price, _selectedCurrency)}</span></div>`).join('')}
          ${items.length > 3 ? `<div class="text-dim text-sm">и ещё ${items.length - 3} позиц.</div>` : ''}
        </div>
        <div class="flex justify-between items-center" style="padding-top:4px;border-top:1px solid var(--border)">
          <span class="text-dim text-sm">Всего ${totalQty} позиций</span>
          <span class="font-bold text-primary">${fmtPrice(totPrc, _selectedCurrency)}</span>
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="clearVenueCart('${venueId}')">🗑️ Удалить</button>
          <button class="btn btn-secondary btn-sm" onclick="openVenueFromCart('${venueId}')">➕ Добавить</button>
          <button class="btn btn-primary btn-sm" onclick="openCartFromOverview('${venueId}')">Оформить →</button>
        </div>
      </div>`;
  }).join('');
}

async function openVenueFromCart(venueId) {
  const venue = VENUES.find(v => v.id === venueId);
  if (!venue) { showToast('Заведение не найдено', 'warning'); return; }
  await openVenue(venueId); setNav(document.getElementById('nav-home'));
}

async function openCartFromOverview(venueId) {
  const venue = VENUES.find(v => v.id === venueId);
  if (!venue) { showToast('Заведение не найдено', 'warning'); return; }
  CURRENT_VENUE = venue;
  if (!VENUE_MENU.length || VENUE_MENU[0]?.venueId !== venueId) {
    const cached = _loadMenuCache(venueId);
    if (cached.length) {
      VENUE_MENU = cached.filter(i => i.available !== false);
    } else {
      const bundle = await dbGet('menu_bundles', venueId);
      VENUE_MENU = (bundle?.items || []).filter(i => i.available !== false);
    }
    // Prune cart in case items were hidden/deleted since the menu was cached
    const _pruned = _pruneCartForVenue(venueId);
    if (_pruned > 0) showToast(`${_pruned} позиц. удалено из корзины (недоступны)`, 'warning', 4000);
  }
  _cartOpenedFrom = 'overview';
  renderCartScreen();
  showScreen('s-cart');
  document.getElementById('cart-venue-name').textContent = venue.name;
  _renderPaymentOpts(venue);
}

function openCart() {
  if (!CURRENT_VENUE) return;
  _cartOpenedFrom = 'venue';
  renderCartScreen();
  showScreen('s-cart');
  document.getElementById('cart-venue-name').textContent = CURRENT_VENUE.name;
  _renderPaymentOpts(CURRENT_VENUE);
}

function _renderPaymentOpts(venue) {
  const row = document.getElementById('payment-opts-row');
  const pm  = venue?.paymentMethods || {};
  // cash is default-on unless explicitly disabled; kaspi_* are opt-in
  const hasCash        = pm.cash        !== false;
  const hasKaspiQr     = pm.kaspi_qr    === true;
  const hasKaspiRemote = pm.kaspi_remote === true;
  // legacy card support
  const hasCard        = pm.card        === true;

  const opts = [];
  if (hasCash)        opts.push('cash');
  if (hasKaspiQr)     opts.push('kaspi_qr');
  if (hasKaspiRemote) opts.push('kaspi_remote');
  if (hasCard)        opts.push('card');
  if (!opts.length)   opts.push('cash'); // fallback

  // If current selection not available → pick first
  if (!opts.includes(_paymentMethod)) _paymentMethod = opts[0];

  const labels = { cash:'💵 Наличные', kaspi_qr:'📱 Kaspi QR', kaspi_remote:'📲 Kaspi Remote', card:'💳 Карта' };
  row.innerHTML = opts.map(v =>
    `<button class="btn ${_paymentMethod === v ? 'btn-primary' : 'btn-secondary'} payment-opt" data-val="${v}" onclick="selectPayment(this)">${labels[v]}</button>`
  ).join('');

  _toggleKaspiPhoneField();
}

function cartGoBack() {
  if (_cartOpenedFrom === 'overview') { showScreen('s-cart-overview'); renderCartOverview(); }
  else { showScreen('s-venue'); }
}

function renderCartScreen() {
  const venueId   = CURRENT_VENUE?.id;
  const venueCart = (venueId && CART[venueId]) || [];
  const wrap      = document.getElementById('cart-items-wrap');
  if (!venueCart.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">🛒</div><div class="empty-text">Корзина пуста</div></div>';
    document.getElementById('order-btn').disabled = true;
    return;
  }
  document.getElementById('order-btn').disabled = false;
  const itemsHtml = venueCart.map(c => `
    <div class="flex items-center gap-2" style="justify-content:space-between;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:22px">${c.emoji}</span>
        <div><div style="font-weight:600;font-size:13px">${c.name}</div><div style="font-size:12px;color:var(--text-dim)">${fmtPrice(c.price, _selectedCurrency)} × ${c.qty}</div></div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <div style="font-weight:700;font-size:14px">${fmtPrice(c.price * c.qty, _selectedCurrency)}</div>
        <button class="btn-xs btn-ghost" onclick="changeQtyCart('${c.cartKey}',-1)">−</button>
        <span style="font-weight:700;min-width:16px;text-align:center">${c.qty}</span>
        <button class="btn-xs btn-ghost" onclick="changeQtyCart('${c.cartKey}',1)">+</button>
      </div>
    </div>`).join('');
  wrap.innerHTML = `<div class="card card-body" style="display:flex;flex-direction:column">${itemsHtml}</div>`;

  const itemsTotal     = venueCartTotal(venueId);
  const rawDelivery    = CURRENT_VENUE?.deliveryPrice || 0;
  const isPickupNow    = _deliveryType === 'pickup';

  // Free delivery logic (delivery orders only; pickup is always free)
  const freeDelEnabled = !isPickupNow && (CURRENT_VENUE?.freeDeliveryEnabled || false);
  const freeDelFrom    = freeDelEnabled ? (CURRENT_VENUE?.freeDeliveryFrom || 0) : 0;
  const isFree         = freeDelEnabled && freeDelFrom > 0 && itemsTotal >= freeDelFrom;
  const clientDelivery = isPickupNow ? 0 : (isFree ? 0 : rawDelivery);

  document.getElementById('cart-items-sum').textContent      = fmtPrice(itemsTotal, _selectedCurrency);
  document.getElementById('cart-delivery-price').textContent = (isPickupNow || isFree) ? '🎁 Бесплатно' : fmtPrice(rawDelivery, _selectedCurrency);
  document.getElementById('cart-total-final').textContent    = fmtPrice(itemsTotal + clientDelivery, _selectedCurrency);

  // Free delivery progress hint
  const hintEl = document.getElementById('cart-free-del-hint');
  if (hintEl) {
    if (!isPickupNow && freeDelEnabled && freeDelFrom > 0 && !isFree) {
      const diff = freeDelFrom - itemsTotal;
      hintEl.textContent = `Ещё ${fmtPrice(diff, _selectedCurrency)} — и доставка бесплатна 🎁`;
      hintEl.style.display = '';
    } else {
      hintEl.style.display = 'none';
    }
  }

  const saved = STATE.user?.savedAddress;
  if (saved) {
    if (!document.getElementById('addr-street').value) document.getElementById('addr-street').value = saved.street || '';
    if (!document.getElementById('addr-house').value)  document.getElementById('addr-house').value  = saved.house || '';
    if (!document.getElementById('addr-apt').value)    document.getElementById('addr-apt').value    = saved.apt   || '';
  }
}

function changeQtyCart(key, delta) {
  const venueId = CURRENT_VENUE?.id;
  const c = (CART[venueId] || []).find(x => x.cartKey === key);
  if (!c) return;
  changeQty(c.id, delta, c.variantName || null);
  renderCartScreen(); updateCartNavBadge();
}

function toggleIntercom() {
  _intercomChecked = !_intercomChecked;
  document.getElementById('intercom-box').textContent = _intercomChecked ? '✓' : '🔔';
  document.getElementById('intercom-row').classList.toggle('checked', _intercomChecked);
}

function selectDeliveryType(el) {
  _deliveryType = el.dataset.val;
  document.querySelectorAll('.delivery-type-btn').forEach(b => {
    b.classList.toggle('btn-primary',   b.dataset.val === _deliveryType);
    b.classList.toggle('btn-secondary', b.dataset.val !== _deliveryType);
  });
  const isPickup = _deliveryType === 'pickup';
  document.getElementById('address-section').classList.toggle('hidden', isPickup);
  document.getElementById('pickup-info').classList.toggle('hidden', !isPickup);
  renderCartScreen();
}

function selectPayment(el) {
  _paymentMethod = el.dataset.val;
  document.querySelectorAll('.payment-opt').forEach(b => {
    b.classList.toggle('btn-primary',   b.dataset.val === _paymentMethod);
    b.classList.toggle('btn-secondary', b.dataset.val !== _paymentMethod);
  });
  _toggleKaspiPhoneField();
}

function _toggleKaspiPhoneField() {
  const sec = document.getElementById('kaspi-phone-section');
  if (!sec) return;
  const show = _paymentMethod === 'kaspi_remote';
  sec.classList.toggle('hidden', !show);
  if (show) {
    // Auto-fill with user phone if available
    const ph = document.getElementById('kaspi-phone-inp');
    if (ph && !ph.value && STATE.user?.phone) ph.value = STATE.user.phone;
  }
  // Плашка "Сдача" — только при наличных
  const hint = document.getElementById('cash-change-hint');
  if (hint) hint.style.display = _paymentMethod === 'cash' ? 'inline-flex' : 'none';
}

// ── Submit order ──
async function submitOrder() {
  const venueId   = CURRENT_VENUE?.id;
  const venueCart = CART[venueId] || [];
  if (!venueCart.length)           { showToast('Корзина пуста', 'warning'); return; }
  if (!isVenueOpen(CURRENT_VENUE)) { showToast('Заведение сейчас закрыто', 'warning'); return; }

  // Rate limits: max 1 active order per venue, max 3 total active orders
  const activeOrders = _allClientOrders.filter(o => !['delivered','cancelled','issued'].includes(o.status));
  const activeAtVenue = activeOrders.filter(o => o.venueId === venueId);
  if (activeAtVenue.length > 0) { showToast('У вас уже есть активный заказ в этом заведении', 'warning'); return; }
  if (activeOrders.length >= 3) { showToast('Максимум 3 одновременных заказа', 'warning'); return; }

  const isPickup = _deliveryType === 'pickup';
  const street   = document.getElementById('addr-street').value.trim();
  const house    = document.getElementById('addr-house').value.trim();
  const apt      = document.getElementById('addr-apt').value.trim();
  const comment  = document.getElementById('order-comment').value.trim();
  if (!isPickup && (!street || !house)) { showToast('Укажите улицу и дом', 'warning'); return; }
  // kaspi_remote: phone required
  const kaspiPhone = _paymentMethod === 'kaspi_remote'
    ? (document.getElementById('kaspi-phone-inp')?.value.trim() || STATE.user?.phone || '')
    : null;
  if (_paymentMethod === 'kaspi_remote' && !kaspiPhone) { showToast('Введите номер телефона для Kaspi', 'warning'); return; }

  const blEntry = await dbGet('venue_blacklist', venueId + '_' + STATE.uid);
  if (blEntry) { showToast('Вы не можете оформить заказ в этом заведении', 'error'); return; }

  const btn = document.getElementById('order-btn');
  btn.disabled = true; btn.textContent = 'Оформляем...';

  // Re-fetch fresh prices from DB to prevent manipulation (1 чит вместо N)
  const _freshBundle = await dbGet('menu_bundles', venueId);
  const freshMenuItems = _freshBundle?.items || [];
  const recalcItems = venueCart.map(c => {
    const menuItem = freshMenuItems.find(m => m.id === c.id && m.available !== false);
    if (!menuItem) return null;
    let price = menuItem.price;
    if (c.variantName && menuItem.variants?.length) {
      const variant = menuItem.variants.find(v => v.name === c.variantName);
      if (variant) price = variant.price;
    }
    return { ...c, price };
  }).filter(Boolean);
  if (!recalcItems.length) { showToast('Товары недоступны', 'error'); btn.disabled = false; btn.textContent = 'Оформить заказ'; return; }
  const freshTotal = recalcItems.reduce((s, c) => s + c.price * c.qty, 0);

  const orderId = genOrderId();
  const rawDeliveryPrice    = CURRENT_VENUE.deliveryPrice || 0;
  const _freeDelEnabled     = !isPickup && (CURRENT_VENUE.freeDeliveryEnabled || false);
  const _freeDelFrom        = _freeDelEnabled ? (CURRENT_VENUE.freeDeliveryFrom || 0) : 0;
  const _freeDeliveryApplied = _freeDelEnabled && _freeDelFrom > 0 && freshTotal >= _freeDelFrom;
  const deliveryPrice       = isPickup ? 0 : (_freeDeliveryApplied ? 0 : rawDeliveryPrice);
  const _orderDate = new Date().toISOString().slice(0, 10);
  const order = {
    id: orderId, venueId, venueName: CURRENT_VENUE.name,
    clientUid: STATE.uid, clientName: STATE.user?.name || '', clientPhone: STATE.user?.phone || '',
    clientTgId: STATE.user?.tgId || '',
    currency: _selectedCurrency,
    items: recalcItems.map(c => ({ id: c.id, name: c.name, price: c.price, qty: c.qty, emoji: c.emoji, variantName: c.variantName || null })),
    total: freshTotal, deliveryPrice,
    // courierDeliveryPrice: only stored when free delivery hides the real price from client.
    // Courier always earns the full rawDeliveryPrice regardless of client-side discount.
    ...(_freeDeliveryApplied ? { courierDeliveryPrice: rawDeliveryPrice } : {}),
    address: isPickup ? null : { street, house, apt, hasIntercom: _intercomChecked },
    payment: _paymentMethod, deliveryType: _deliveryType, comment,
    ...(kaspiPhone ? { kaspiPhone } : {}),
    status: 'pending', createdAt: new Date().toISOString(),
    // Дыры №5, №9, №10: index fields
    active: true,                               // false when delivered/cancelled/issued
    venueDateKey: venueId + '_' + _orderDate,   // for date-specific queries
    clientNotification: { type: '', seen: true },
    adminBotNotified: false, courierBotNotified: false, cancelledBotNotified: false
  };

  try {
    const ok = await dbSet('orders', orderId, order);
    if (!ok) {
      showToast('Ошибка при оформлении. Попробуйте ещё раз.', 'error');
      btn.disabled = false; btn.textContent = 'Оформить заказ';
      return;
    }
    // Add to in-memory list for immediate display only if the Firestore snapshot
    // hasn't already done so (snapshot fires optimistically inside dbSet).
    if (!_allClientOrders.some(o => o.id === orderId)) {
      _allClientOrders.unshift(order);
      _saveOrdersToStorage(_allClientOrders);
    }
    CART[venueId] = []; delete CART[venueId];
    _saveCart(); updateCartNavBadge();
    tgHaptic('success'); showToast('Заказ оформлен!', 'success');
    navToAllOrders();
  } catch (e) {
    showToast('Ошибка при оформлении', 'error');
  }
  btn.disabled = false; btn.textContent = 'Оформить заказ';
}

// ══════════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════════
let _allClientOrders = [];

const _CLIENT_HIST_MAX = 7;
// Key is per-user so two different clients on the same device don't share history
function _ordersStorageKey() { return 'vez_client_orders_' + (STATE.uid || 'anon'); }
function _loadOrdersFromStorage() {
  try { return JSON.parse(localStorage.getItem(_ordersStorageKey()) || '[]'); } catch { return []; }
}
function _saveOrdersToStorage(orders) {
  try {
    const DONE = ['delivered', 'cancelled', 'issued'];
    const active    = orders.filter(o => !DONE.includes(o.status));
    // Cap history at _CLIENT_HIST_MAX entries (keep the most recent ones)
    const completed = orders.filter(o =>  DONE.includes(o.status)).slice(0, _CLIENT_HIST_MAX);
    localStorage.setItem(_ordersStorageKey(), JSON.stringify([...active, ...completed]));
  } catch {}
}

// H-2: Subscribe only to active client orders (not full history).
// Completed orders are captured via docChanges() type='removed' and merged into localStorage.
// REQUIRES Firestore composite index: orders — clientUid ASC + active ASC
function watchActiveOrders() {
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }

  // Show stored orders immediately while waiting for Firestore
  const stored = _loadOrdersFromStorage();
  if (stored.length) {
    _allClientOrders = stored;
    ACTIVE_ORDERS = stored.filter(o => !['delivered', 'cancelled', 'issued'].includes(o.status))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    document.getElementById('order-nav-badge').classList.toggle('hidden', ACTIVE_ORDERS.length === 0);
    renderAllOrders();
  }

  const _applyActiveOrders = (active, justFinished) => {
    // Merge active orders with locally stored completed orders
    const storedAll = _loadOrdersFromStorage();
    const fsIds = new Set(active.map(o => o.id));
    // Any stored order absent from the Firestore active set has left it —
    // either it properly completed (delivered/cancelled/issued) OR the app was
    // closed while it was completing and its cached status is stale (e.g. 'pending').
    // In both cases we keep it as history rather than silently discarding it.
    const localCompleted = storedAll.filter(o => !fsIds.has(o.id));
    // Merge, then deduplicate by id (Firestore snapshot + submitOrder can both add an order)
    const _merged = [...active, ...localCompleted];
    const _seen = new Set();
    _allClientOrders = _merged.filter(o => _seen.has(o.id) ? false : _seen.add(o.id));
    _saveOrdersToStorage(_allClientOrders);

    ACTIVE_ORDERS = active
      .filter(o => !['delivered', 'cancelled', 'issued'].includes(o.status))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    document.getElementById('order-nav-badge').classList.toggle('hidden', ACTIVE_ORDERS.length === 0);

    // Notification priority: only show notification if it matches the current
    // order stage. Stale notifications (e.g. 'accepted' when order is already
    // 'delivered') are silently dismissed — this prevents showing 3 popups
    // when client opens the app after missing several status changes.
    const _notifLevel  = { accepted: 1, ready: 2, delivering: 3, delivered: 4, cancelled: 4, issued: 4 };
    const _statusLevel = {
      pending: 0, accepted: 1, cooking: 1, ready: 2,
      searching_courier: 2, courier_assigned: 2, ready_for_courier: 2,
      delivering: 3, delivered: 4, cancelled: 4, issued: 4
    };
    // Check notifications on active orders
    active.forEach(o => {
      const n = o.clientNotification;
      if (!n || n.seen) return;
      const notifLvl  = _notifLevel[n.type]    || 0;
      const statusLvl = _statusLevel[o.status] || 0;
      if (notifLvl < statusLvl) {
        dbSet('orders', o.id, { clientNotification: { ...n, seen: true } });
        return;
      }
      const key = `${o.id}:${n.type}`;
      if (!_shownNotifs.has(key)) {
        _shownNotifs.add(key);
        _showClientNotification(o);
      }
    });
    // Also show notifications for orders that just finished (removed from active query).
    // Apply the same priority check as the active loop — defensive guard against
    // stale clientNotification that wasn't updated before active became false.
    justFinished.forEach(o => {
      const n = o.clientNotification;
      if (!n || n.seen) return;
      const notifLvl  = _notifLevel[n.type]    || 0;
      const statusLvl = _statusLevel[o.status] || 0;
      if (notifLvl < statusLvl) {
        dbSet('orders', o.id, { clientNotification: { ...n, seen: true } });
        return;
      }
      const key = `${o.id}:${n.type}`;
      if (!_shownNotifs.has(key)) {
        _shownNotifs.add(key);
        _showClientNotification(o);
      }
    });

    // Always re-render — even if the user is on a different screen the DOM update
    // is cheap and ensures the orders list is current when they navigate back.
    renderAllOrders();
  };

  if (!_fbR) {
    // Offline fallback: poll active orders only
    const t = setInterval(async () => {
      const orders = await dbQueryWhere('orders', [['clientUid','==',STATE.uid],['active','==',true]]);
      _applyActiveOrders(orders, []);
    }, 15000);
    _ordersUnsub = () => clearInterval(t);
    return;
  }

  _ordersUnsub = db.collection('orders')
    .where('clientUid', '==', STATE.uid)
    .where('active', '==', true)
    .onSnapshot(async snap => {
      // Detect orders that just left the active set (delivered/cancelled/issued).
      // IMPORTANT: change.doc.data() on 'removed' events may return the document's
      // state BEFORE the write that made it leave the query set (stale snapshot).
      // For example, admin cancels → active becomes false, but the removed-event
      // snapshot still carries status:'pending'. This causes duplicates / stuck UI.
      // Fix: always re-fetch the final document state directly from Firestore.
      const removedChanges = snap.docChanges().filter(c => c.type === 'removed');

      let justFinished = [];
      if (removedChanges.length) {
        // MUST use { source: 'server' } here — the Firestore cache at the time of a
        // 'removed' event still holds the PRE-WRITE document snapshot (e.g. status:'accepted'
        // with clientNotification.seen:true). A plain get() would return that stale cache
        // and the cancellation notification would never fire. Server fetch guarantees
        // the post-write state (status:'cancelled', clientNotification.seen:false).
        const freshDocs = await Promise.all(
          removedChanges.map(c =>
            db.collection('orders').doc(c.doc.id).get({ source: 'server' })
              .then(doc => doc.exists ? { id: doc.id, ...doc.data() } : { id: c.doc.id, ...c.doc.data() })
              .catch(() =>
                // Server unreachable — fall back to cache
                db.collection('orders').doc(c.doc.id).get()
                  .then(doc => doc.exists ? { id: doc.id, ...doc.data() } : { id: c.doc.id, ...c.doc.data() })
                  .catch(() => ({ id: c.doc.id, ...c.doc.data() }))
              )
          )
        );
        justFinished = freshDocs;

        const storedAll = _loadOrdersFromStorage();
        for (const fin of justFinished) {
          const idx = storedAll.findIndex(o => o.id === fin.id);
          if (idx >= 0) storedAll[idx] = fin;
          else storedAll.unshift(fin);
        }
        _saveOrdersToStorage(storedAll);
      }

      _applyActiveOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })), justFinished);
    }, e => console.warn('[DB] activeOrders snap:', e.message));
}

function _showClientNotification(order) {
  const type  = order.clientNotification?.type;
  const notifMap = { accepted: 'notif-accepted', ready: 'notif-accepted', cancelled: 'notif-cancelled', delivering: 'notif-delivering', delivered: 'notif-delivered', issued: 'notif-delivered' };
  const notifId  = notifMap[type];
  if (!notifId) return;

  // Close the previous notification for THIS order if it's a different overlay.
  // This prevents stacking when the admin rapidly moves through statuses while
  // the client has the app open in the background.
  const prevId = _openNotifByOrder[order.id];
  if (prevId && prevId !== notifId) {
    document.getElementById(prevId)?.classList.remove('open');
  }
  _openNotifByOrder[order.id] = notifId;
  if (type === 'accepted') {
    const mins = order.deliveryMinutes || 60;
    const h = Math.floor(mins / 60), m = mins % 60;
    const ts = h > 0 ? `${h} ч ${m > 0 ? m + ' мин' : ''}` : `${m} мин`;
    const el = document.getElementById('notif-accepted-text');
    if (el) el.textContent = order.deliveryType === 'pickup'
      ? `Заказ принят! Будет готов через ${ts}.`
      : `Заказ принят! Ожидайте доставку в течение ${ts}.`;
  }
  if (type === 'ready') {
    const el = document.getElementById('notif-accepted-text');
    if (el) el.textContent = order.clientNotification?.message || 'Ваш заказ готов! Приходите забирать.';
  }
  if (type === 'issued') {
    const el = document.getElementById('notif-delivered-op-text') || document.getElementById('notif-accepted-text');
    // Use delivered notification element for issued pickup
  }
  if (type === 'delivering') {
    const el = document.getElementById('notif-delivering-text');
    if (el) el.textContent = order.clientNotification?.message || 'Курьер везёт ваш заказ!';
  }
  tgHaptic('heavy'); playAlert();
  const el = document.getElementById(notifId);
  if (el) el.classList.add('open');
  dbSet('orders', order.id, { clientNotification: { ...order.clientNotification, seen: true } });
}

function closeNotif(id) {
  document.getElementById(id)?.classList.remove('open');
  // Remove order tracking for this overlay so stale entries don't accumulate
  for (const orderId of Object.keys(_openNotifByOrder)) {
    if (_openNotifByOrder[orderId] === id) delete _openNotifByOrder[orderId];
  }
  tgHaptic('light');
}

function onDeliveredClose() {
  closeNotif('notif-delivered');
}

// ══════════════════════════════════════════════════════════
//  ORDER LIST RENDERING
// ══════════════════════════════════════════════════════════
function renderAllOrders() {
  const container = document.getElementById('orders-content');
  const active  = _allClientOrders
    .filter(o => !['delivered', 'cancelled', 'issued'].includes(o.status))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const history = _allClientOrders
    .filter(o => ['delivered', 'cancelled', 'issued'].includes(o.status))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 60);

  if (!active.length && !history.length) {
    container.innerHTML = `<div class="empty" style="padding-top:40px"><div class="empty-icon">📦</div><div class="empty-text">Заказов пока нет</div><button class="btn btn-primary" style="margin-top:20px" onclick="navTo('s-home');setNav(document.getElementById('nav-home'))">🏪 К заведениям</button></div>`;
    return;
  }
  let html = '';
  if (active.length) {
    html += `<div class="section-title" style="padding:0 4px;margin-bottom:4px">Активные (${active.length})</div>`;
    html += active.map(renderOrderCard).join('');
  }
  if (history.length) {
    html += `<div class="section-title" style="padding:0 4px;margin:12px 0 4px">История</div>`;
    html += history.map(renderHistoryCard).join('');
  }
  container.innerHTML = html;
}

function renderHistoryCard(o) {
  return `
    <div class="order-card" style="cursor:pointer;border-left:3px solid ${(o.status === 'delivered' || o.status === 'issued') ? 'var(--success)' : 'var(--danger)'}" onclick="openHistoryOrder('${o.id}')">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">📍 ${escHtml(o.venueName || 'Заведение')}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id || '').slice(-6)}</div></div>
        <div style="text-align:right">
          <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
          <div class="order-total" style="font-size:15px;margin-top:3px">${fmtPrice((o.total||0)+(o.deliveryPrice||0), o.currency || _selectedCurrency)}</div>
        </div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items || []).map(i => `${i.emoji || '🍽️'} ${escHtml(i.name)} ×${i.qty}`).join(', ')}</div>
        <div class="text-xs text-dim" style="margin-top:4px">Нажмите для деталей →</div>
      </div>
    </div>`;
}

function openHistoryOrder(orderId) {
  const o = _allClientOrders.find(x => x.id === orderId);
  if (!o) return;
  const cur = o.currency || _selectedCurrency;
  const addr = o.address;
  const content = document.getElementById('history-detail-content');
  content.innerHTML = `
    <div class="sheet-title">Заказ #${(o.id||'').slice(-6)}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span class="text-dim text-sm">${fmtDate(o.createdAt)}</span>
      <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
    </div>
    <div class="card card-body" style="margin-bottom:12px;gap:6px;display:flex;flex-direction:column">
      <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${escHtml(o.venueName||'—')}</span></div>
      ${addr?`<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt?', кв.'+escHtml(addr.apt):''}</span></div>`:'<div class="flex justify-between"><span class="text-dim">Получение</span><span>🏪 Самовывоз</span></div>'}
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${paymentLabel(o.payment)}</span></div>
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав</div>
    <div class="card card-body" style="margin-bottom:12px;gap:4px;display:flex;flex-direction:column">
      ${(o.items||[]).map(it=>`<div class="flex justify-between text-sm"><span>${it.emoji||'🍽️'} ${escHtml(it.name)}${it.variantName?' ('+escHtml(it.variantName)+')':''} ×${it.qty}</span><span>${fmtPrice(it.price*it.qty, cur)}</span></div>`).join('')}
      <div class="divider" style="margin:4px 0"></div>
      ${o.deliveryPrice?`<div class="flex justify-between text-sm"><span class="text-dim">Доставка</span><span>${fmtPrice(o.deliveryPrice, cur)}</span></div>`:''}
      <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice((o.total||0)+(o.deliveryPrice||0), cur)}</span></div>
    </div>
    ${o.status==='cancelled'?`<div class="alert-box danger" style="margin-bottom:12px">❌ Заказ отменён ${{ client:'вами', operator:'оператором', admin:'администратором' }[o.cancelledBy]||''}</div>`:''}
    ${['delivered','issued'].includes(o.status)?`<button class="btn btn-primary" onclick="reorderFromHistory('${o.id}')">🔄 Заказать повторно</button>`:''}
  `;
  document.getElementById('history-detail-overlay').classList.add('open');
  tg?.BackButton?.show();
}

function closeHistoryDetail(e) {
  if (e && e.target !== document.getElementById('history-detail-overlay')) return;
  document.getElementById('history-detail-overlay').classList.remove('open');
  if (!document.querySelector('.overlay.open')) tg?.BackButton?.hide();
}

async function reorderFromHistory(orderId) {
  const o = _allClientOrders.find(x => x.id === orderId);
  if (!o) return;
  const venue = VENUES.find(v => v.id === o.venueId);
  if (!venue) { showToast('Заведение недоступно', 'warning'); return; }

  const btn = document.querySelector('#history-detail-content .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Загружаем меню...'; }

  // Use localStorage menu cache (Дыра №2)
  const cachedMenu = _loadMenuCache(o.venueId);
  let menuItems;
  if (cachedMenu.length) {
    menuItems = cachedMenu.filter(i => i.available !== false);
  } else {
    const _rb = await dbGet('menu_bundles', o.venueId);
    menuItems = (_rb?.items || []).filter(i => i.available !== false);
  }

  CART[o.venueId] = [];
  let addedCount = 0;
  const unavailable = [];

  for (const histItem of (o.items || [])) {
    let menuItem = menuItems.find(m => m.id === histItem.id) || menuItems.find(m => m.name === histItem.name);
    if (!menuItem) { unavailable.push(histItem.name); continue; }
    let price = menuItem.price;
    let cartKey = menuItem.id;
    let name = menuItem.name;
    if (histItem.variantName && menuItem.variants?.length) {
      const variant = menuItem.variants.find(v => v.name === histItem.variantName);
      if (variant) { price = variant.price; cartKey = `${menuItem.id}::${variant.name}`; name = `${menuItem.name} (${variant.name})`; }
    }
    CART[o.venueId].push({ cartKey, id: menuItem.id, variantName: histItem.variantName || null, name, price, qty: histItem.qty, emoji: menuItem.emoji || histItem.emoji || '🍽️' });
    addedCount++;
  }

  if (!CART[o.venueId].length) {
    delete CART[o.venueId];
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Заказать повторно'; }
    showToast('Ни один товар недоступен в текущем меню', 'warning');
    return;
  }

  _saveCart(); updateCartNavBadge();
  CURRENT_VENUE = venue;
  VENUE_MENU = menuItems;

  document.getElementById('history-detail-overlay').classList.remove('open');
  tg?.BackButton?.hide();

  if (unavailable.length) showToast(`Добавлено ${addedCount} поз. Недоступно: ${unavailable.join(', ')}`, 'info');
  else showToast(`${addedCount} позиций добавлено в корзину`, 'success');
  tgHaptic('success');

  navToCart();
  setNav(document.getElementById('nav-cart'));
}

function renderOrderCard(o) {
  const isPickup = o.deliveryType === 'pickup';
  const steps = isPickup
    ? [{ icon: '📋', label: 'Создан' }, { icon: '👨‍🍳', label: 'Готовится' }, { icon: '✅', label: 'Готово' }, { icon: '📦', label: 'Выдан' }]
    : [
        { icon: '📋', label: 'Создан' },
        { icon: '👨‍🍳', label: 'Готовится' },
        {
          icon:  o.status === 'searching_courier' ? '🔍' : o.status === 'delivering' ? '🚴' : '⏳',
          label: o.status === 'searching_courier' ? 'Поиск курьера' : o.status === 'delivering' ? 'В пути' : 'Ожидает курьера'
        },
        { icon: '✅', label: 'Доставлен' }
      ];
  const stepIdx = isPickup
    ? { pending: 0, accepted: 1, cooking: 1, ready: 2, issued: 3, cancelled: 0 }
    : { pending: 0, accepted: 1, cooking: 1, searching_courier: 2, ready_for_courier: 2, courier_assigned: 2, delivering: 2, delivered: 3, cancelled: 0 };
  const si = stepIdx[o.status] ?? 0;
  const track = o.status === 'cancelled'
    ? '<div style="color:var(--danger);font-weight:600;font-size:14px;text-align:center">❌ Заказ отменён</div>'
    : steps.map((s, i) => {
        const cls = i < si ? 'done' : i === si ? 'active' : '';
        return `<div class="st-step ${cls}"><div class="st-dot">${cls === 'done' ? '✓' : s.icon}</div><div style="margin-top:4px;font-size:11px">${s.label}</div></div>${i < steps.length - 1 ? `<div class="st-line ${i < si ? 'done' : ''}"></div>` : ''}`;
      }).join('');
  const addr   = o.address;
  const cur    = o.currency || _selectedCurrency;
  return `
    <div class="order-card" style="margin-bottom:2px">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">📍 ${escHtml(o.venueName || 'Заведение')}</div><div class="order-id">#${(o.id || '').slice(-6)} · ${fmtDate(o.createdAt)}</div></div>
        <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
      </div>
      <div class="order-card-body">
        <div class="status-track" style="margin-bottom:12px">${track}</div>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:13px;margin-bottom:8px">
          ${(o.items || []).map(it => `<div class="flex justify-between"><span>${it.emoji || '🍽️'} ${escHtml(it.name)}${it.variantName ? ' (' + escHtml(it.variantName) + ')' : ''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price * it.qty, cur)}</span></div>`).join('')}
        </div>
        <div class="divider" style="margin:6px 0"></div>
        <div class="flex justify-between"><span class="text-dim">Товары</span><span>${fmtPrice(o.total, cur)}</span></div>
        ${o.deliveryPrice ? `<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(o.deliveryPrice, cur)}</span></div>` : ''}
        <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice((o.total||0)+(o.deliveryPrice||0), cur)}</span></div>
        <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${paymentLabel(o.payment)}</span></div>
        ${addr ? `<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:58%">${escHtml(addr.street)} ${escHtml(addr.house)}${addr.apt ? ', кв.' + escHtml(addr.apt) : ''}</span></div>` : ''}
        ${o.courierName ? `<div class="flex justify-between"><span class="text-dim">Курьер</span><span>${escHtml(o.courierName)}</span></div>` : ''}
        ${o.status === 'pending' ? `<div style="margin-top:10px;text-align:right"><button class="btn btn-danger btn-sm" onclick="clientCancelOrder('${o.id}')">❌ Отменить заказ</button></div>` : ''}
      </div>
    </div>`;
}

async function clientCancelOrder(orderId) {
  const doCancel = async () => {
    await dbSet('orders', orderId, {
      status: 'cancelled', active: false,
      cancelledAt: new Date().toISOString(),
      cancelledBy: 'client',
      clientNotification: { type: 'cancelled', seen: true, message: 'Вы отменили заказ.' }
    });
    // Optimistic local update — don't wait for onSnapshot to re-render.
    // onSnapshot will fire too but will find the state already correct.
    const now = new Date().toISOString();
    _allClientOrders = _allClientOrders.map(o =>
      o.id === orderId ? { ...o, status: 'cancelled', active: false, cancelledAt: now, cancelledBy: 'client' } : o
    );
    _saveOrdersToStorage(_allClientOrders);
    renderAllOrders();
    tgHaptic('light');
    showToast('Заказ отменён', 'info');
  };
  if (tg?.showConfirm) tg.showConfirm('Отменить заказ?', ok => { if (ok) doCancel(); });
  else if (confirm('Отменить заказ?')) await doCancel();
}


// ══════════════════════════════════════════════════════════
//  SETTINGS / PROFILE
// ══════════════════════════════════════════════════════════
function loadSettings2() {
  const u = STATE.user;
  if (!u) return;
  document.getElementById('profile-name').textContent   = u.name   || '—';
  document.getElementById('profile-phone').textContent  = u.phone  || '—';
  document.getElementById('profile-avatar').textContent = (u.name || '?')[0].toUpperCase();
  const saved = u.savedAddress;
  if (saved) {
    document.getElementById('saved-street').value = saved.street || '';
    document.getElementById('saved-house').value  = saved.house  || '';
    document.getElementById('saved-apt').value    = saved.apt    || '';
  }

}

// ── Rate limit для сохранения адреса ──────────────────────
const _ADDR_RL_KEY   = 'vez_addr_rl';
const _ADDR_FREEZE_KEY = 'vez_addr_freeze';
const _ADDR_COOLDOWN = 3000;   // 3 сек между нажатиями
const _ADDR_MAX_SAVES = 3;     // после 3 сохранений — заморозка
const _ADDR_FREEZE_MS = 3600000; // 1 час

function _checkAddrRateLimit() {
  const now = Date.now();
  // Проверяем заморозку
  try {
    const freeze = parseInt(localStorage.getItem(_ADDR_FREEZE_KEY) || '0');
    if (freeze > now) {
      const mins = Math.ceil((freeze - now) / 60000);
      showToast(`Подождите ${mins} мин. перед следующим сохранением`, 'warning');
      return false;
    }
  } catch {}
  // Проверяем cooldown и счётчик
  try {
    const rl = JSON.parse(localStorage.getItem(_ADDR_RL_KEY) || '{"last":0,"count":0}');
    if (now - rl.last < _ADDR_COOLDOWN) {
      const secs = Math.ceil((_ADDR_COOLDOWN - (now - rl.last)) / 1000);
      showToast(`Подождите ${secs} сек.`, 'warning');
      return false;
    }
    const newCount = rl.count + 1;
    if (newCount > _ADDR_MAX_SAVES) {
      // Замораживаем на час
      localStorage.setItem(_ADDR_FREEZE_KEY, String(now + _ADDR_FREEZE_MS));
      localStorage.setItem(_ADDR_RL_KEY, JSON.stringify({ last: now, count: 0 }));
      showToast('Слишком много попыток. Повторите через 1 час.', 'error');
      return false;
    }
    localStorage.setItem(_ADDR_RL_KEY, JSON.stringify({ last: now, count: newCount }));
  } catch {}
  return true;
}

async function saveAddress() {
  if (!_checkAddrRateLimit()) return;
  const street = document.getElementById('saved-street').value.trim();
  const house  = document.getElementById('saved-house').value.trim();
  const apt    = document.getElementById('saved-apt').value.trim();
  if (!street || !house) { showToast('Введите улицу и дом', 'warning'); return; }
  const savedAddress = { street, house, apt };
  STATE.user = { ...STATE.user, savedAddress };
  _saveClientState();
  await dbSet('clients', STATE.uid, { savedAddress });
  tgHaptic('success'); showToast('Адрес сохранён', 'success');
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
const _navHistory = [];
const _NO_HISTORY_SCREENS = ['s-splash', 's-blocked', 's-no-uid', 's-no-account', 's-agree'];
const _rawShowScreen = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
};

function _initBackButton() {
  if (!tg?.BackButton) return;
  tg.BackButton.onClick(() => {
    const open = document.querySelector('.overlay.open');
    if (open) { open.classList.remove('open'); if (!_navHistory.length) tg.BackButton.hide(); return; }
    if (_navHistory.length > 0) {
      const prev = _navHistory.pop();
      _rawShowScreen(prev);
      if (!_navHistory.length) tg.BackButton.hide();
      return;
    }
    tg.BackButton.hide();
  });
}

function navTo(screenId) {
  const cur = document.querySelector('.screen.active')?.id;
  if (cur && cur !== screenId && !_NO_HISTORY_SCREENS.includes(cur)) {
    _navHistory.push(cur); tg?.BackButton?.show();
  }
  showScreen(screenId);

  if (screenId === 's-home')   loadVenues();
  if (screenId === 's-orders') renderAllOrders();
}

function navToAllOrders() { navTo('s-orders'); setNav(document.getElementById('nav-orders')); renderAllOrders(); }

function setNav(el) {
  _navHistory.length = 0; tg?.BackButton?.hide();
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}
