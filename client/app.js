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
let FAVORITES     = [];
let _ordersUnsub  = null;
let _shownNotifs  = new Set();
let _cdIntervals  = {};
let _paymentMethod   = 'cash';
let _deliveryType    = 'delivery';
let _intercomChecked = false;
let _favFilter       = false;
let _cartOpenedFrom  = 'venue';
const _selectedCurrency = '₸';

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') {
    localStorage.clear(); location.replace(location.pathname); return;
  }
  tgReady();
  _initBackButton();

  const _tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try {
    const s = JSON.parse(localStorage.getItem('vez_client_state') || '{}');
    if (!_tgUserId || s.tgId === _tgUserId) {
      STATE.uid  = s.uid  || null;
      STATE.user = s.user || null;
    }
    CART      = JSON.parse(localStorage.getItem('vez_cart') || '{}');
    FAVORITES = JSON.parse(localStorage.getItem('vez_favorites') || '[]');
  } catch {}

  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; _saveClientState(); }

  await initFirebase();

  if (!STATE.uid) {
    const tgUid = await resolveUidByTgId();
    if (tgUid) { STATE.uid = tgUid; _saveClientState(); }
  }
  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing?.blocked) { showScreen('s-blocked'); return; }

  if (!existing?.agreedClient) {
    document.getElementById('s-agree').style.display = 'flex';
    return;
  }

  if (!existing.name) {
    const autoName = _getTgName() || existing.firstName || 'Пользователь';
    await dbSet('users', STATE.uid, { name: autoName });
    existing.name = autoName;
  }
  STATE.user = existing; _saveClientState();
  initMain();
});

function _getTgName() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return null;
  return (u.first_name + (u.last_name ? ' ' + u.last_name : '')).trim() || null;
}

function _saveClientState() {
  const tgId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : null;
  try { localStorage.setItem('vez_client_state', JSON.stringify({ uid: STATE.uid, user: STATE.user, tgId })); } catch {}
}
function _saveCart()      { try { localStorage.setItem('vez_cart', JSON.stringify(CART)); } catch {} }
function _saveFavorites() { try { localStorage.setItem('vez_favorites', JSON.stringify(FAVORITES)); } catch {} }

// ── Agreement ──
async function submitAgree() {
  const btn = document.getElementById('agree-btn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  const linkData = await dbGet('user_links', STATE.uid);
  const autoName = _getTgName() || linkData?.firstName || 'Пользователь';
  STATE.user = {
    name: autoName, phone: linkData?.phone || '', tgId: linkData?.tgId || '',
    role: 'client', agreedClient: true, createdAt: new Date().toISOString()
  };
  await dbSet('users', STATE.uid, STATE.user);
  _saveClientState();
  if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  document.getElementById('s-agree').style.display = 'none';
  initMain();
}

// ── Init main ──
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  FAVORITES = JSON.parse(localStorage.getItem('vez_favorites') || '[]');
  loadVenues();
  watchActiveOrders();
  showScreen('s-home');
}

// ══════════════════════════════════════════════════════════
//  HOME — Venue list
// ══════════════════════════════════════════════════════════
async function loadVenues() {
  const venues = await dbGetAll('venues', 'name', 'asc');
  VENUES     = venues.filter(v => v.status === 'approved' && !v.blocked && v.onlineOrdersEnabled !== false);
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
  let list = _favFilter ? VENUES.filter(v => FAVORITES.includes(v.id)) : VENUES;
  if (catId) list = list.filter(v => v.categoryId === catId);
  const container = document.getElementById('home-venues');
  if (!list.length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">${_favFilter ? 'Нет избранных' : 'Заведений пока нет'}</div></div>`;
    return;
  }
  container.innerHTML = list.map(v => {
    const isFav  = FAVORITES.includes(v.id);
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
            <div class="venue-card-name">${v.name}${cartBadge}</div>
            <button class="venue-fav${isFav ? ' active' : ''}" onclick="event.stopPropagation();toggleFav('${v.id}',this)">${isFav ? '❤️' : '🤍'}</button>
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

function toggleFavFilter() {
  _favFilter = !_favFilter;
  document.getElementById('fav-filter-btn').textContent = _favFilter ? '❤️' : '🤍';
  renderVenues(null);
  document.querySelectorAll('#home-cat-tabs .cat-tab').forEach((b, i) => b.classList.toggle('active', i === 0));
}

function toggleFav(venueId, btn) {
  const idx = FAVORITES.indexOf(venueId);
  if (idx >= 0) { FAVORITES.splice(idx, 1); btn.textContent = '🤍'; btn.classList.remove('active'); }
  else          { FAVORITES.push(venueId); btn.textContent = '❤️'; btn.classList.add('active'); }
  _saveFavorites();
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
    <span class="venue-delivery-info">🚴 ${venue.deliveryTime || '?'} мин</span>
    <span class="venue-delivery-info">💰 ${fmtPrice(venue.deliveryPrice || 0, _selectedCurrency)}</span>
    ${venue.workOpen ? `<span class="venue-delivery-info">🕐 ${venue.workOpen}–${venue.workClose}</span>` : ''}`;

  const isFav = FAVORITES.includes(venueId);
  const favBtn = document.getElementById('venue-fav-btn');
  favBtn.textContent = isFav ? '❤️' : '🤍';
  favBtn.classList.toggle('active', isFav);

  showScreen('s-venue');
  await loadVenueMenu(venueId);
}

function backToHome() { showScreen('s-home'); setNav(document.getElementById('nav-home')); }
function toggleCurrentVenueFav() { if (!CURRENT_VENUE) return; toggleFav(CURRENT_VENUE.id, document.getElementById('venue-fav-btn')); }

async function loadVenueMenu(venueId) {
  const grid = document.getElementById('venue-menu-grid');
  grid.innerHTML = '<div class="loader" style="grid-column:1/-1"><div class="spinner"></div></div>';
  VENUE_MENU = (await dbQuery('menu_items', 'venueId', '==', venueId)).filter(i => i.available !== false);
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
      ? `<div class="menu-card-img"><img src="${item.imageUrl}" alt="${item.name}" loading="lazy" onerror="this.parentElement.innerHTML='<span style=font-size:44px>${item.emoji || '🍽️'}</span>'"></div>`
      : `<div class="menu-card-img"><span style="font-size:44px">${item.emoji || '🍽️'}</span></div>`;

    if (item.variants && item.variants.length > 0) {
      const variantRows = item.variants.map(v => {
        const key = `${item.id}::${v.name}`;
        const qty = (venueCart.find(c => c.cartKey === key) || { qty: 0 }).qty;
        return `<div class="variant-row" id="vr-${CSS.escape(key)}">
          <span class="variant-name">${v.name}</span>
          <div style="display:flex;align-items:center;gap:4px">
            <span class="variant-price">${fmtPrice(v.price, _selectedCurrency)}</span>
            <div class="qty-ctrl">
              ${qty > 0 ? `<div class="qty-btn" onclick="changeQty('${item.id}',-1,'${v.name}')">−</div><div class="qty-num">${qty}</div>` : ''}
              <div class="qty-btn add" onclick="changeQty('${item.id}',1,'${v.name}')">+</div>
            </div>
          </div>
        </div>`;
      }).join('');
      return `<div class="menu-card menu-card-wide" id="mc-${item.id}">${imgHtml}<div class="menu-card-body"><div class="menu-card-name">${item.name}</div>${item.description ? `<div class="menu-card-desc">${item.description}</div>` : ''}<div class="variants-container" style="margin-top:8px">${variantRows}</div></div></div>`;
    } else {
      const cartItem = venueCart.find(c => c.cartKey === item.id);
      const qty = cartItem ? cartItem.qty : 0;
      return `<div class="menu-card" id="mc-${item.id}">${imgHtml}<div class="menu-card-body"><div class="menu-card-name">${item.name}</div>${item.description ? `<div class="menu-card-desc">${item.description}</div>` : ''}<div class="qty-row"><div class="menu-card-price">${fmtPrice(item.price, _selectedCurrency)}</div><div class="qty-ctrl">${qty > 0 ? `<div class="qty-btn" onclick="changeQty('${item.id}',-1)">−</div><div class="qty-num" id="qn-${item.id}">${qty}</div>` : ''}<div class="qty-btn add" onclick="changeQty('${item.id}',1)">+</div></div></div></div></div>`;
    }
  }).join('');
}

// ── Cart management ──
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
    menuItem.variants.forEach(v => {
      const key    = `${itemId}::${v.name}`;
      const qty    = (venueCart.find(c => c.cartKey === key) || { qty: 0 }).qty;
      const safeId = CSS.escape(key);
      const row    = document.getElementById(`vr-${safeId}`);
      if (!row) return;
      const ctrl = row.querySelector('.qty-ctrl');
      if (!ctrl) return;
      ctrl.innerHTML = qty > 0
        ? `<div class="qty-btn" onclick="changeQty('${itemId}',-1,'${v.name}')">−</div><div class="qty-num">${qty}</div><div class="qty-btn add" onclick="changeQty('${itemId}',1,'${v.name}')">+</div>`
        : `<div class="qty-btn add" onclick="changeQty('${itemId}',1,'${v.name}')">+</div>`;
    });
  } else {
    const qty  = (venueCart.find(c => c.cartKey === itemId) || { qty: 0 }).qty;
    const ctrl = document.querySelector(`#mc-${itemId} .qty-ctrl`);
    if (!ctrl) return;
    ctrl.innerHTML = qty > 0
      ? `<div class="qty-btn" onclick="changeQty('${itemId}',-1)">−</div><div class="qty-num" id="qn-${itemId}">${qty}</div><div class="qty-btn add" onclick="changeQty('${itemId}',1)">+</div>`
      : `<div class="qty-btn add" onclick="changeQty('${itemId}',1)">+</div>`;
  }
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
    VENUE_MENU = (await dbQuery('menu_items', 'venueId', '==', venueId)).filter(i => i.available !== false);
  }
  _cartOpenedFrom = 'overview';
  renderCartScreen();
  showScreen('s-cart');
  document.getElementById('cart-venue-name').textContent = venue.name;
  // Show available payment methods
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
  const hasCash = venue?.paymentMethods?.cash !== false;
  const hasCard = venue?.paymentMethods?.card !== false;
  let html = '';
  if (hasCash) html += `<button class="btn ${_paymentMethod === 'cash' ? 'btn-primary' : 'btn-secondary'} payment-opt" data-val="cash" onclick="selectPayment(this)">💵 Наличные</button>`;
  if (hasCard) html += `<button class="btn ${_paymentMethod === 'card' ? 'btn-primary' : 'btn-secondary'} payment-opt" data-val="card" onclick="selectPayment(this)">💳 Карта</button>`;
  row.innerHTML = html;
  // Auto-select first available
  if (!hasCash && hasCard) _paymentMethod = 'card';
  if (hasCash && !hasCard) _paymentMethod = 'cash';
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

  const itemsTotal    = venueCartTotal(venueId);
  const deliveryPrice = CURRENT_VENUE?.deliveryPrice || 0;
  document.getElementById('cart-items-sum').textContent      = fmtPrice(itemsTotal, _selectedCurrency);
  document.getElementById('cart-delivery-price').textContent = _deliveryType === 'pickup' ? 'Бесплатно' : fmtPrice(deliveryPrice, _selectedCurrency);
  document.getElementById('cart-total-final').textContent    = fmtPrice(itemsTotal + (_deliveryType === 'pickup' ? 0 : deliveryPrice), _selectedCurrency);

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

  const blEntry = await dbGet('venue_blacklist', venueId + '_' + STATE.uid);
  if (blEntry) { showToast('Вы не можете оформить заказ в этом заведении', 'error'); return; }

  const btn = document.getElementById('order-btn');
  btn.disabled = true; btn.textContent = 'Оформляем...';

  // Re-fetch fresh prices from DB to prevent manipulation
  const freshMenuItems = await dbQuery('menu_items', 'venueId', '==', venueId);
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
  const deliveryPrice = isPickup ? 0 : (CURRENT_VENUE.deliveryPrice || 0);
  const order = {
    id: orderId, venueId, venueName: CURRENT_VENUE.name,
    clientUid: STATE.uid, clientName: STATE.user?.name || '', clientPhone: STATE.user?.phone || '',
    clientTgId: STATE.user?.tgId || '',
    currency: _selectedCurrency,
    items: recalcItems.map(c => ({ id: c.id, name: c.name, price: c.price, qty: c.qty, emoji: c.emoji, variantName: c.variantName || null })),
    total: freshTotal, deliveryPrice,
    address: isPickup ? null : { street, house, apt, hasIntercom: _intercomChecked },
    payment: _paymentMethod, deliveryType: _deliveryType, comment,
    status: 'pending', createdAt: new Date().toISOString(),
    clientNotification: { type: '', seen: true },
    adminBotNotified: false, courierBotNotified: false, cancelledBotNotified: false
  };

  try {
    await dbSet('orders', orderId, order);
    // Save new order to localStorage immediately
    const storedOrders = _loadOrdersFromStorage();
    storedOrders.unshift(order);
    _saveOrdersToStorage(storedOrders);
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

function _loadOrdersFromStorage() { try { return JSON.parse(localStorage.getItem('vez_client_orders') || '[]'); } catch { return []; } }
function _saveOrdersToStorage(orders) { try { localStorage.setItem('vez_client_orders', JSON.stringify(orders)); } catch {} }

function watchActiveOrders() {
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }

  // Show stored orders immediately while waiting for Firestore
  const stored = _loadOrdersFromStorage();
  if (stored.length) {
    _allClientOrders = stored;
    ACTIVE_ORDERS = stored.filter(o => !['delivered', 'cancelled', 'issued'].includes(o.status))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    document.getElementById('order-nav-badge').classList.toggle('hidden', ACTIVE_ORDERS.length === 0);
    if (document.getElementById('s-orders').classList.contains('active')) renderAllOrders();
  }

  _ordersUnsub = onQuerySnap('orders', 'clientUid', '==', STATE.uid, orders => {
    // Merge Firestore active orders with locally stored completed orders
    const storedAll = _loadOrdersFromStorage();
    const fsIds = new Set(orders.map(o => o.id));
    const localCompleted = storedAll.filter(o => ['delivered', 'cancelled', 'issued'].includes(o.status) && !fsIds.has(o.id));
    const merged = [...orders, ...localCompleted];
    _allClientOrders = merged;
    _saveOrdersToStorage(merged);

    ACTIVE_ORDERS = orders.filter(o => !['delivered', 'cancelled', 'issued'].includes(o.status))
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
    orders.forEach(o => {
      const n = o.clientNotification;
      if (!n || n.seen) return;
      const notifLvl  = _notifLevel[n.type]    || 0;
      const statusLvl = _statusLevel[o.status] || 0;
      if (notifLvl < statusLvl) {
        // Notification is from an earlier stage — mark seen silently
        dbSet('orders', o.id, { clientNotification: { ...n, seen: true } });
        return;
      }
      const key = `${o.id}:${n.type}`;
      if (!_shownNotifs.has(key)) {
        _shownNotifs.add(key);
        _showClientNotification(o);
      }
    });

    if (document.getElementById('s-orders').classList.contains('active')) renderAllOrders();
  });
}

function _showClientNotification(order) {
  const type  = order.clientNotification?.type;
  const notifMap = { accepted: 'notif-accepted', ready: 'notif-accepted', cancelled: 'notif-cancelled', delivering: 'notif-delivering', delivered: 'notif-delivered', issued: 'notif-delivered' };
  const notifId  = notifMap[type];
  if (!notifId) return;
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
        <div><div class="font-bold" style="font-size:13px">📍 ${o.venueName || 'Заведение'}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id || '').slice(-6)}</div></div>
        <div style="text-align:right">
          <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
          <div class="order-total" style="font-size:15px;margin-top:3px">${fmtPrice((o.total||0)+(o.deliveryPrice||0), o.currency || _selectedCurrency)}</div>
        </div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items || []).map(i => `${i.emoji || '🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
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
      <div class="flex justify-between"><span class="text-dim">Заведение</span><span class="font-bold">${o.venueName||'—'}</span></div>
      ${addr?`<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:60%">${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}</span></div>`:'<div class="flex justify-between"><span class="text-dim">Получение</span><span>🏪 Самовывоз</span></div>'}
      <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${o.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
    </div>
    <div class="section-title" style="margin-bottom:6px">Состав</div>
    <div class="card card-body" style="margin-bottom:12px;gap:4px;display:flex;flex-direction:column">
      ${(o.items||[]).map(it=>`<div class="flex justify-between text-sm"><span>${it.emoji||'🍽️'} ${it.name}${it.variantName?' ('+it.variantName+')':''} ×${it.qty}</span><span>${fmtPrice(it.price*it.qty, cur)}</span></div>`).join('')}
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

  const menuItems = (await dbQuery('menu_items', 'venueId', '==', o.venueId)).filter(i => i.available !== false);

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
    : [{ icon: '📋', label: 'Создан' }, { icon: '👨‍🍳', label: 'Готовится' }, { icon: ['searching_courier','courier_assigned'].includes(o.status)?'⏳':'🚴', label: ['searching_courier','courier_assigned'].includes(o.status)?'Ожидает курьера':'В пути' }, { icon: '✅', label: 'Доставлен' }];
  const stepIdx = isPickup
    ? { pending: 0, accepted: 0, cooking: 1, ready: 2, issued: 3, cancelled: 0 }
    : { pending: 0, accepted: 0, cooking: 1, searching_courier: 2, courier_assigned: 2, delivering: 2, delivered: 3, cancelled: 0 };
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
        <div><div class="font-bold" style="font-size:13px">📍 ${o.venueName || 'Заведение'}</div><div class="order-id">#${(o.id || '').slice(-6)} · ${fmtDate(o.createdAt)}</div></div>
        <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
      </div>
      <div class="order-card-body">
        <div class="status-track" style="margin-bottom:12px">${track}</div>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:13px;margin-bottom:8px">
          ${(o.items || []).map(it => `<div class="flex justify-between"><span>${it.emoji || '🍽️'} ${it.name}${it.variantName ? ' (' + it.variantName + ')' : ''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price * it.qty, cur)}</span></div>`).join('')}
        </div>
        <div class="divider" style="margin:6px 0"></div>
        <div class="flex justify-between"><span class="text-dim">Товары</span><span>${fmtPrice(o.total, cur)}</span></div>
        ${o.deliveryPrice ? `<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(o.deliveryPrice, cur)}</span></div>` : ''}
        <div class="flex justify-between"><span class="font-bold">Итого</span><span class="font-bold text-primary">${fmtPrice((o.total||0)+(o.deliveryPrice||0), cur)}</span></div>
        <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${o.payment === 'cash' ? '💵 Наличные' : '💳 Карта'}</span></div>
        ${addr ? `<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:58%">${addr.street} ${addr.house}${addr.apt ? ', кв.' + addr.apt : ''}</span></div>` : ''}
        ${o.courierName ? `<div class="flex justify-between"><span class="text-dim">Курьер</span><span>${o.courierName}</span></div>` : ''}
        ${o.status === 'pending' ? `<div style="margin-top:10px;text-align:right"><button class="btn btn-danger btn-sm" onclick="clientCancelOrder('${o.id}')">❌ Отменить заказ</button></div>` : ''}
      </div>
    </div>`;
}

async function clientCancelOrder(orderId) {
  const doCancel = async () => {
    await dbSet('orders', orderId, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledBy: 'client',
      clientNotification: { type: 'cancelled', seen: true, message: 'Вы отменили заказ.' }
    });
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

  // Favourites
  const favList   = document.getElementById('favorites-list');
  const favVenues = VENUES.filter(v => FAVORITES.includes(v.id));
  if (!favVenues.length) { favList.innerHTML = '<div class="text-dim text-sm">Нет избранных заведений</div>'; return; }
  favList.innerHTML = favVenues.map(v => `
    <div class="list-item" onclick="openVenue('${v.id}');setNav(document.getElementById('nav-home'))">
      <div class="li-icon yellow">${CATEGORIES.find(c => c.id === v.categoryId)?.icon || '🏪'}</div>
      <div class="li-body"><div class="li-title">${v.name}</div><div class="li-sub">${isVenueOpen(v) ? 'Открыто' : 'Закрыто'}</div></div>
      <div class="chevron">›</div>
    </div>`).join('');
}

async function saveAddress() {
  const street = document.getElementById('saved-street').value.trim();
  const house  = document.getElementById('saved-house').value.trim();
  const apt    = document.getElementById('saved-apt').value.trim();
  if (!street || !house) { showToast('Введите улицу и дом', 'warning'); return; }
  const savedAddress = { street, house, apt };
  STATE.user = { ...STATE.user, savedAddress };
  _saveClientState();
  await dbSet('users', STATE.uid, { savedAddress });
  tgHaptic('success'); showToast('Адрес сохранён', 'success');
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
const _navHistory = [];
const _NO_HISTORY_SCREENS = ['s-splash', 's-blocked', 's-no-uid', 's-agree'];
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
