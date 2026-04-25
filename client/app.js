'use strict';
/* ============================================================
   VEZOO CLIENT — Customer Mini App
   ============================================================ */

const STATE = { uid: null, user: null };
let VENUES       = [];
let CATEGORIES   = [];
let CURRENT_VENUE = null;
let VENUE_MENU    = [];
let CART          = {};   // { venueId: [{cartKey, id, variantName, name, price, qty, emoji}] }
let ACTIVE_ORDERS = [];
let FAVORITES     = [];   // [venueId]
let _ordersUnsub  = null;
let _shownNotifs  = new Set();
let _cdIntervals  = {};
let _paymentMethod  = 'cash';
let _deliveryType   = 'delivery';
let _intercomChecked = false;
let _favFilter      = false;
let _currentReviewVenueId = null;
let _agreedCheck = false;

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  if (new URLSearchParams(location.search).get('reset') === '1') {
    localStorage.clear(); location.replace(location.pathname); return;
  }
  tgReady();

  try {
    const s = JSON.parse(localStorage.getItem('vez_client_state') || '{}');
    STATE.uid  = s.uid  || null;
    STATE.user = s.user || null;
    CART       = JSON.parse(localStorage.getItem('vez_cart') || '{}');
    FAVORITES  = JSON.parse(localStorage.getItem('vez_favorites') || '[]');
  } catch {}

  const urlUid = readUidFromUrl();
  if (urlUid) { STATE.uid = urlUid; saveClientState(); }

  await initFirebase();

  if (!STATE.uid) {
    const tgUid = await resolveUidByTgId();
    if (tgUid) { STATE.uid = tgUid; saveClientState(); }
  }

  if (!STATE.uid) { showScreen('s-no-uid'); return; }

  const existing = await dbGet('users', STATE.uid);
  if (existing) {
    if (existing.blocked) { showScreen('s-blocked'); return; }
    if (!existing.agreedClient) { showScreen('s-agree'); return; }
    STATE.user = existing; saveClientState();
    initMain();
  } else {
    const linkData = await dbGet('user_links', STATE.uid);
    const tgUser   = tg?.initDataUnsafe?.user;
    let name = tgUser ? (tgUser.first_name + (tgUser.last_name ? ' ' + tgUser.last_name : '')) : '';
    if (!name && linkData?.firstName) name = linkData.firstName;
    const inp = document.getElementById('ob-name');
    if (inp && name) inp.value = name;
    showScreen('s-agree');
  }
});

function saveClientState() {
  try { localStorage.setItem('vez_client_state', JSON.stringify({ uid: STATE.uid, user: STATE.user })); } catch {}
}
function saveCart() {
  try { localStorage.setItem('vez_cart', JSON.stringify(CART)); } catch {}
}
function saveFavorites() {
  try { localStorage.setItem('vez_favorites', JSON.stringify(FAVORITES)); } catch {}
}

// ── Agreement ──
function toggleAgreeCheck() {
  _agreedCheck = !_agreedCheck;
  document.getElementById('agree-box').textContent = _agreedCheck ? '✓' : '';
  document.getElementById('agree-check-row').classList.toggle('checked', _agreedCheck);
  document.getElementById('agree-btn').disabled = !_agreedCheck;
}
async function submitAgree() {
  showScreen('s-onboard');
  const linkData = await dbGet('user_links', STATE.uid);
  const tgUser   = tg?.initDataUnsafe?.user;
  let name = tgUser ? (tgUser.first_name + (tgUser.last_name ? ' ' + tgUser.last_name : '')) : '';
  if (!name && linkData?.firstName) name = linkData.firstName;
  const inp = document.getElementById('ob-name');
  if (inp && name) inp.value = name;
}

// ── Onboarding ──
async function onboardSubmit() {
  const name = document.getElementById('ob-name').value.trim();
  if (!name) { showToast('Введите ваше имя', 'warning'); return; }
  const btn = document.getElementById('ob-btn');
  btn.disabled = true; btn.classList.add('btn-loading');
  const linkData = await dbGet('user_links', STATE.uid);
  STATE.user = {
    name, phone: linkData?.phone || '', tgId: linkData?.tgId || '',
    role: 'client', agreedClient: true, createdAt: new Date().toISOString()
  };
  await dbSet('users', STATE.uid, STATE.user);
  if (linkData?.phone) {
    STATE.user.phone = linkData.phone;
  }
  saveClientState();
  btn.disabled = false; btn.classList.remove('btn-loading');
  initMain();
}

// ── Init main ──
function initMain() {
  document.getElementById('main-nav').style.display = 'flex';
  startHeartbeat(STATE.uid);
  FAVORITES = JSON.parse(localStorage.getItem('vez_favorites') || '[]');
  if (STATE.user?.favorites) FAVORITES = STATE.user.favorites;
  loadVenues();
  watchActiveOrders();
  showScreen('s-home');
}

// ══════════════════════════════════════════════════════════
//  HOME — Venue list
// ══════════════════════════════════════════════════════════
async function loadVenues() {
  const [venues, cats] = await Promise.all([
    dbGetAll('venues', 'name', 'asc'),
    dbGetAll('categories', 'order', 'asc')
  ]);
  VENUES     = venues.filter(v => v.status === 'approved' && !v.blocked);
  CATEGORIES = cats;
  renderCatTabs();
  renderVenues(null);
}

function renderCatTabs() {
  const container = document.getElementById('home-cat-tabs');
  const tabs = [{ id: null, name: 'Все', icon: '🏪' }, ...CATEGORIES.map(c => ({ id: c.id, name: c.name, icon: c.icon || '📦' }))];
  container.innerHTML = tabs.map((c, i) =>
    `<button class="cat-tab${i===0?' active':''}" onclick="filterVenues(this,'${c.id||''}')">${c.icon} ${c.name}</button>`
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
    container.innerHTML = `<div class="empty"><div class="empty-icon">🏪</div><div class="empty-text">${_favFilter ? 'Нет избранных заведений' : 'Заведений пока нет'}</div></div>`;
    return;
  }
  container.innerHTML = list.map(v => {
    const isFav = FAVORITES.includes(v.id);
    const cat   = CATEGORIES.find(c => c.id === v.categoryId);
    const open  = isVenueOpen(v);
    const cover = v.coverUrl
      ? `<img src="${v.coverUrl}" onerror="this.style.display='none'">`
      : `<span style="font-size:48px">${cat?.icon||'🏪'}</span>`;
    return `
      <div class="venue-card" onclick="openVenue('${v.id}')">
        <div class="venue-card-img">${cover}</div>
        <div class="venue-card-body">
          <div class="flex justify-between items-center">
            <div class="venue-card-name">${v.name}</div>
            <button class="venue-fav${isFav?' active':''}" onclick="event.stopPropagation();toggleFav('${v.id}',this)">${isFav?'❤️':'🤍'}</button>
          </div>
          <div class="venue-card-meta">
            ${cat ? `<span class="cat-pill">${cat.icon||''} ${cat.name}</span>` : ''}
            <div class="star-row">${renderStars(v.rating||0)}<span class="rating-val" style="font-size:12px;margin-left:4px">${(v.rating||0).toFixed(1)}</span></div>
          </div>
          <div class="venue-card-foot">
            <span class="${open?'venue-open':'venue-closed'}">${open?'● Открыто':'● Закрыто'}</span>
            <span class="venue-delivery-info">🚴 ${v.deliveryTime||'?'} мин · ${fmtPrice(v.deliveryPrice||0)}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function isVenueOpen(v) {
  if (!v.workOpen || !v.workClose) return true;
  const now = new Date();
  const [oh, om] = v.workOpen.split(':').map(Number);
  const [ch, cm] = v.workClose.split(':').map(Number);
  const mins = now.getHours()*60+now.getMinutes();
  return mins >= oh*60+om && mins < ch*60+cm;
}

function toggleFavFilter() {
  _favFilter = !_favFilter;
  const btn = document.getElementById('fav-filter-btn');
  btn.textContent = _favFilter ? '❤️' : '🤍';
  renderVenues(null);
  document.querySelectorAll('#home-cat-tabs .cat-tab').forEach((b,i) => b.classList.toggle('active', i===0));
}

function toggleFav(venueId, btn) {
  const idx = FAVORITES.indexOf(venueId);
  if (idx >= 0) {
    FAVORITES.splice(idx, 1);
    btn.textContent = '🤍'; btn.classList.remove('active');
  } else {
    FAVORITES.push(venueId);
    btn.textContent = '❤️'; btn.classList.add('active');
  }
  saveFavorites();
  dbSet('users', STATE.uid, { favorites: FAVORITES });
}

// ══════════════════════════════════════════════════════════
//  VENUE DETAIL
// ══════════════════════════════════════════════════════════
async function openVenue(venueId) {
  const venue = VENUES.find(v => v.id === venueId);
  if (!venue) return;
  CURRENT_VENUE = venue;

  const coverEl  = document.getElementById('venue-cover-el');
  const imgEl    = document.getElementById('venue-cover-img');
  const emojiEl  = document.getElementById('venue-cover-emoji');
  const cat      = CATEGORIES.find(c => c.id === venue.categoryId);

  if (venue.coverUrl) {
    imgEl.src = venue.coverUrl; imgEl.style.display = 'block';
    emojiEl.style.display = 'none';
  } else {
    imgEl.style.display = 'none';
    emojiEl.textContent = cat?.icon || '🏪'; emojiEl.style.display = '';
  }

  document.getElementById('venue-name-el').textContent  = venue.name;
  const open = isVenueOpen(venue);
  const openEl = document.getElementById('venue-open-el');
  openEl.textContent = open ? '● Открыто' : '● Закрыто';
  openEl.className   = open ? 'venue-open' : 'venue-closed';
  document.getElementById('venue-closed-banner').classList.toggle('hidden', open);

  const metaEl = document.getElementById('venue-meta-el');
  metaEl.innerHTML = `
    ${cat ? `<span class="cat-pill">${cat.icon||''} ${cat.name}</span>` : ''}
    <span class="venue-delivery-info">🚴 ${venue.deliveryTime||'?'} мин</span>
    <span class="venue-delivery-info">💰 Доставка: ${fmtPrice(venue.deliveryPrice||0)}</span>
    ${venue.workOpen ? `<span class="venue-delivery-info">🕐 ${venue.workOpen}–${venue.workClose}</span>` : ''}
  `;

  document.getElementById('venue-stars-el').innerHTML = renderStars(venue.rating||0);
  document.getElementById('venue-rating-val').textContent  = (venue.rating||0).toFixed(1);
  document.getElementById('venue-rating-cnt').textContent  = `(${venue.reviewCount||0} отзывов)`;

  const isFav = FAVORITES.includes(venueId);
  const favBtn = document.getElementById('venue-fav-btn');
  favBtn.textContent = isFav ? '❤️' : '🤍';
  favBtn.classList.toggle('active', isFav);

  showScreen('s-venue');
  await loadVenueMenu(venueId);
  updateCartFAB();
}

function backToHome() {
  showScreen('s-home'); setNav(document.getElementById('nav-home'));
  document.getElementById('cart-fab').classList.add('hidden');
}

function toggleCurrentVenueFav() {
  if (!CURRENT_VENUE) return;
  toggleFav(CURRENT_VENUE.id, document.getElementById('venue-fav-btn'));
}

async function loadVenueMenu(venueId) {
  const grid = document.getElementById('venue-menu-grid');
  grid.innerHTML = '<div class="loader" style="grid-column:1/-1"><div class="spinner"></div></div>';
  VENUE_MENU = (await dbQuery('menu_items', 'venueId', '==', venueId)).filter(i => i.available !== false);
  const menuCats = ['Все', ...new Set(VENUE_MENU.map(i => i.category).filter(Boolean))];
  const tabsEl = document.getElementById('venue-cat-tabs');
  tabsEl.innerHTML = menuCats.map((c, i) =>
    `<button class="cat-tab${i===0?' active':''}" onclick="filterVenueMenu(this,'${c}')">${c}</button>`
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
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-icon">🍽️</div><div class="empty-text">Нет позиций в этой категории</div></div>';
    return;
  }
  const venueId = CURRENT_VENUE?.id;
  const venueCart = CART[venueId] || [];
  grid.innerHTML = items.map(item => {
    const imgHtml = item.imageUrl
      ? `<div class="menu-card-img"><img src="${item.imageUrl}" alt="${item.name}" loading="lazy" onerror="this.parentElement.innerHTML='<span style=font-size:44px>${item.emoji||'🍽️'}</span>'"></div>`
      : `<div class="menu-card-img"><span style="font-size:44px">${item.emoji||'🍽️'}</span></div>`;

    if (item.variants && item.variants.length > 0) {
      const variantRows = item.variants.map(v => {
        const key = `${item.id}::${v.name}`;
        const qty = (venueCart.find(c => c.cartKey === key)||{qty:0}).qty;
        return `<div class="variant-row" id="vr-${CSS.escape(key)}">
          <span class="variant-name">${v.name}</span>
          <div style="display:flex;align-items:center;gap:4px">
            <span class="variant-price">${fmtPrice(v.price)}</span>
            <div class="qty-ctrl">
              ${qty>0?`<div class="qty-btn" onclick="changeQty('${item.id}',-1,'${v.name}')">−</div><div class="qty-num">${qty}</div>`:''}
              <div class="qty-btn add" onclick="changeQty('${item.id}',1,'${v.name}')">+</div>
            </div>
          </div>
        </div>`;
      }).join('');
      return `<div class="menu-card menu-card-wide" id="mc-${item.id}">${imgHtml}<div class="menu-card-body"><div class="menu-card-name">${item.name}</div>${item.description?`<div class="menu-card-desc">${item.description}</div>`:''}<div class="variants-container" style="margin-top:8px">${variantRows}</div></div></div>`;
    } else {
      const cartItem = venueCart.find(c => c.cartKey===item.id);
      const qty = cartItem ? cartItem.qty : 0;
      return `<div class="menu-card" id="mc-${item.id}">${imgHtml}<div class="menu-card-body"><div class="menu-card-name">${item.name}</div>${item.description?`<div class="menu-card-desc">${item.description}</div>`:''}<div class="qty-row"><div class="menu-card-price">${fmtPrice(item.price)}</div><div class="qty-ctrl">${qty>0?`<div class="qty-btn" onclick="changeQty('${item.id}',-1)">−</div><div class="qty-num" id="qn-${item.id}">${qty}</div>`:''}
        <div class="qty-btn add" onclick="changeQty('${item.id}',1)">+</div></div></div></div></div>`;
    }
  }).join('');
}

// ── Cart management ──
function changeQty(itemId, delta, variantName = null) {
  tgHaptic('light');
  const menuItem = VENUE_MENU.find(i => i.id === itemId);
  if (!menuItem) return;
  const venueId  = CURRENT_VENUE?.id;
  if (!venueId) return;
  if (!CART[venueId]) CART[venueId] = [];
  const key = variantName ? `${itemId}::${variantName}` : itemId;
  let cartItem = CART[venueId].find(c => c.cartKey === key);
  if (!cartItem) {
    if (delta < 0) return;
    const price = variantName
      ? (menuItem.variants?.find(v => v.name === variantName)?.price ?? menuItem.price)
      : menuItem.price;
    const name  = variantName ? `${menuItem.name} (${variantName})` : menuItem.name;
    cartItem = { cartKey: key, id: itemId, variantName: variantName||null, name, price, qty: 0, emoji: menuItem.emoji||'🍽️' };
    CART[venueId].push(cartItem);
  }
  cartItem.qty = Math.max(0, cartItem.qty + delta);
  if (cartItem.qty === 0) CART[venueId] = CART[venueId].filter(c => c.cartKey !== key);
  saveCart();
  updateMenuItemUI(itemId);
  updateCartFAB();
}

function updateMenuItemUI(itemId) {
  const menuItem = VENUE_MENU.find(i => i.id === itemId);
  if (!menuItem) return;
  const venueId   = CURRENT_VENUE?.id;
  const venueCart = CART[venueId] || [];
  if (menuItem.variants?.length > 0) {
    menuItem.variants.forEach(v => {
      const key    = `${itemId}::${v.name}`;
      const qty    = (venueCart.find(c => c.cartKey===key)||{qty:0}).qty;
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
    const qty  = (venueCart.find(c => c.cartKey===itemId)||{qty:0}).qty;
    const ctrl = document.querySelector(`#mc-${itemId} .qty-ctrl`);
    if (!ctrl) return;
    ctrl.innerHTML = qty > 0
      ? `<div class="qty-btn" onclick="changeQty('${itemId}',-1)">−</div><div class="qty-num" id="qn-${itemId}">${qty}</div><div class="qty-btn add" onclick="changeQty('${itemId}',1)">+</div>`
      : `<div class="qty-btn add" onclick="changeQty('${itemId}',1)">+</div>`;
  }
}

function updateCartFAB() {
  const fab    = document.getElementById('cart-fab');
  const venueId = CURRENT_VENUE?.id;
  const venueCart = (venueId && CART[venueId]) || [];
  const count  = venueCart.reduce((s,c) => s+c.qty, 0);
  const total  = venueCart.reduce((s,c) => s+c.price*c.qty, 0);
  const onVenue = document.getElementById('s-venue').classList.contains('active');
  if (count > 0 && onVenue) {
    fab.classList.remove('hidden');
    document.getElementById('cart-fab-count').textContent = `${count} поз.`;
    document.getElementById('cart-fab-total').textContent = fmtPrice(total);
  } else { fab.classList.add('hidden'); }
}

function venueCartTotal(venueId) {
  return (CART[venueId]||[]).reduce((s,c) => s+c.price*c.qty, 0);
}

// ── Cart screen ──
function openCart() {
  if (!CURRENT_VENUE) return;
  renderCartScreen();
  showScreen('s-cart');
  document.getElementById('cart-fab').classList.add('hidden');
  document.getElementById('cart-venue-name').textContent = CURRENT_VENUE.name;
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
        <div>
          <div style="font-weight:600;font-size:13px">${c.name}</div>
          <div style="font-size:12px;color:var(--text-dim)">${fmtPrice(c.price)} × ${c.qty}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <div style="font-weight:700;font-size:14px">${fmtPrice(c.price*c.qty)}</div>
        <button class="btn-xs btn-ghost" onclick="changeQtyCart('${c.cartKey}',-1)">−</button>
        <span style="font-weight:700;min-width:16px;text-align:center">${c.qty}</span>
        <button class="btn-xs btn-ghost" onclick="changeQtyCart('${c.cartKey}',1)">+</button>
      </div>
    </div>`).join('');
  wrap.innerHTML = `<div class="card card-body" style="display:flex;flex-direction:column">${itemsHtml}</div>`;

  const itemsTotal    = venueCartTotal(venueId);
  const deliveryPrice = CURRENT_VENUE?.deliveryPrice || 0;
  document.getElementById('cart-items-sum').textContent      = fmtPrice(itemsTotal);
  document.getElementById('cart-delivery-price').textContent = _deliveryType==='pickup' ? 'Бесплатно' : fmtPrice(deliveryPrice);
  document.getElementById('cart-total-final').textContent    = fmtPrice(itemsTotal + (_deliveryType==='pickup' ? 0 : deliveryPrice));

  // Prefill saved address
  const saved = STATE.user?.savedAddress;
  if (saved) {
    if (!document.getElementById('addr-street').value) document.getElementById('addr-street').value = saved.street||'';
    if (!document.getElementById('addr-house').value)  document.getElementById('addr-house').value  = saved.house||'';
    if (!document.getElementById('addr-apt').value)    document.getElementById('addr-apt').value    = saved.apt||'';
  }
}

function changeQtyCart(key, delta) {
  const venueId   = CURRENT_VENUE?.id;
  const venueCart = CART[venueId] || [];
  const c = venueCart.find(x => x.cartKey === key);
  if (!c) return;
  changeQty(c.id, delta, c.variantName||null);
  renderCartScreen();
}

function toggleIntercom() {
  _intercomChecked = !_intercomChecked;
  document.getElementById('intercom-box').textContent = _intercomChecked ? '✓' : '🔔';
  document.getElementById('intercom-row').classList.toggle('checked', _intercomChecked);
  document.getElementById('intercom-code-wrap').classList.toggle('hidden', !_intercomChecked);
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
  if (!venueCart.length) { showToast('Корзина пуста', 'warning'); return; }
  if (!isVenueOpen(CURRENT_VENUE)) { showToast('Заведение сейчас закрыто', 'warning'); return; }

  const isPickup = _deliveryType === 'pickup';
  const street   = document.getElementById('addr-street').value.trim();
  const house    = document.getElementById('addr-house').value.trim();
  const apt      = document.getElementById('addr-apt').value.trim();
  const comment  = document.getElementById('order-comment').value.trim();
  const code     = _intercomChecked ? document.getElementById('intercom-code').value.trim() : '';
  if (!isPickup && (!street || !house)) { showToast('Укажите улицу и дом', 'warning'); return; }

  const btn = document.getElementById('order-btn');
  btn.disabled = true; btn.textContent = 'Оформляем...';

  const orderId = genOrderId();
  const deliveryPrice = isPickup ? 0 : (CURRENT_VENUE.deliveryPrice || 0);
  const order = {
    id: orderId, venueId, venueName: CURRENT_VENUE.name,
    clientUid: STATE.uid, clientName: STATE.user?.name||'', clientPhone: STATE.user?.phone||'', clientTgId: STATE.user?.tgId||'',
    items: venueCart.map(c => ({ id:c.id, name:c.name, price:c.price, qty:c.qty, emoji:c.emoji, variantName:c.variantName||null })),
    total: venueCartTotal(venueId), deliveryPrice,
    address: isPickup ? null : { street, house, apt, hasIntercom: _intercomChecked, intercomCode: code },
    payment: _paymentMethod, deliveryType: _deliveryType, comment,
    status: 'pending', createdAt: new Date().toISOString(),
    clientNotification: { type:'', seen:true }
  };

  try {
    await dbSet('orders', orderId, order);
    CART[venueId] = []; saveCart();
    tgHaptic('success');
    showToast('Заказ оформлен!', 'success');
    navTo('s-orders'); setNav(document.getElementById('nav-orders'));
  } catch(e) {
    showToast('Ошибка при оформлении', 'error');
  }
  btn.disabled = false; btn.textContent = 'Оформить заказ';
}

// ══════════════════════════════════════════════════════════
//  ACTIVE ORDERS
// ══════════════════════════════════════════════════════════
function watchActiveOrders() {
  if (_ordersUnsub) { _ordersUnsub(); _ordersUnsub = null; }
  _ordersUnsub = onQuerySnap('orders', 'clientUid', '==', STATE.uid, orders => {
    ACTIVE_ORDERS = orders.filter(o => !['delivered','cancelled'].includes(o.status))
      .sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));

    document.getElementById('order-nav-badge').classList.toggle('hidden', ACTIVE_ORDERS.length === 0);

    orders.forEach(o => {
      const n = o.clientNotification;
      if (n && !n.seen) {
        const key = `${o.id}:${n.type}`;
        if (!_shownNotifs.has(key)) {
          _shownNotifs.add(key);
          showClientNotification(o);
        }
      }
    });

    if (document.getElementById('s-orders').classList.contains('active')) renderAllActiveOrders();
  });
}

function showClientNotification(order) {
  const type = order.clientNotification?.type;
  const idMap = { accepted:'notif-accepted', cancelled:'notif-cancelled', delivering:'notif-delivering', delivered:'notif-delivered' };
  const notifId = idMap[type];
  if (!notifId) return;

  if (type === 'accepted') {
    const mins = order.deliveryMinutes || 60;
    const h = Math.floor(mins/60), m = mins%60;
    const ts = h>0 ? `${h} ч ${m>0?m+' мин':''}` : `${m} мин`;
    const el = document.getElementById('notif-accepted-text');
    if (el) el.textContent = order.deliveryType==='pickup'
      ? `Заказ принят! Он будет готов примерно через ${ts}.`
      : `Заказ принят! Ожидайте доставку в течение ${ts}.`;
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

function renderAllActiveOrders() {
  const container = document.getElementById('orders-content');
  if (!ACTIVE_ORDERS.length) {
    container.innerHTML = `<div class="empty" style="padding-top:40px"><div class="empty-icon">📦</div><div class="empty-text">Нет активных заказов</div><button class="btn btn-primary" style="margin-top:20px" onclick="navTo('s-home');setNav(document.getElementById('nav-home'))">🏪 К заведениям</button></div>`;
    return;
  }
  container.innerHTML = ACTIVE_ORDERS.map(renderOrderCard).join('');
  startAllCountdowns();
}

function renderOrderCard(o) {
  const isPickup = o.deliveryType === 'pickup';
  const steps = isPickup
    ? [{key:'pending',icon:'🕐',label:'Принят'},{key:'cooking',icon:'👨‍🍳',label:'Готовится'},{key:'delivered',icon:'✅',label:'Готов'}]
    : [{key:'pending',icon:'🕐',label:'Принят'},{key:'cooking',icon:'👨‍🍳',label:'Готовится'},{key:'searching_courier',icon:'🔍',label:'Курьер'},{key:'delivering',icon:'🚴',label:'В пути'},{key:'delivered',icon:'✅',label:'Доставлен'}];
  const si = steps.findIndex(s => s.key === o.status);
  const track = o.status==='cancelled'
    ? '<div style="color:var(--danger);font-weight:600;font-size:14px;text-align:center">❌ Заказ отменён</div>'
    : steps.map((s,i) => {
        const cls = i<si?'done':i===si?'active':'';
        return `<div class="st-step ${cls}"><div class="st-dot">${cls==='done'?'✓':s.icon}</div><div style="margin-top:4px;font-size:11px">${s.label}</div></div>${i<steps.length-1?`<div class="st-line ${i<si?'done':''}"></div>`:''}`;
      }).join('');

  const showCd = o.estimatedAt && !['pending','delivered','cancelled'].includes(o.status);
  const addr   = o.address;

  return `
    <div class="order-card" style="margin-bottom:2px">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">📍 ${o.venueName||'Заведение'}</div><div class="order-id">#${(o.id||'').slice(-6)}</div></div>
        <span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span>
      </div>
      <div class="order-card-body">
        <div class="status-track" style="margin-bottom:12px">${track}</div>
        ${showCd?`<div class="countdown-box" style="margin-bottom:12px"><div class="countdown-lbl">${isPickup?'Готовность':'Время доставки'}</div><div class="countdown-val" id="cd-val-${o.id}">—</div><div class="progress-wrap" style="margin-top:8px"><div class="progress-bar" id="cd-bar-${o.id}"></div></div></div>`:''}
        <div style="display:flex;flex-direction:column;gap:4px;font-size:13px;margin-bottom:8px">
          ${(o.items||[]).map(it=>`<div class="flex justify-between"><span>${it.emoji||'🍽️'} ${it.name}${it.variantName?' ('+it.variantName+')':''} ×${it.qty}</span><span class="font-bold">${fmtPrice(it.price*it.qty)}</span></div>`).join('')}
        </div>
        <div class="divider" style="margin:6px 0"></div>
        <div class="flex justify-between"><span class="text-dim">Товары</span><span>${fmtPrice(o.total)}</span></div>
        ${o.deliveryPrice?`<div class="flex justify-between"><span class="text-dim">Доставка</span><span>${fmtPrice(o.deliveryPrice)}</span></div>`:''}
        <div class="flex justify-between"><span class="text-dim">Оплата</span><span>${o.payment==='cash'?'💵 Наличные':'💳 Карта'}</span></div>
        ${addr?`<div class="flex justify-between"><span class="text-dim">Адрес</span><span style="text-align:right;max-width:58%;font-size:12px">${addr.street} ${addr.house}${addr.apt?', кв.'+addr.apt:''}</span></div>`:''}
      </div>
    </div>`;
}

function startAllCountdowns() {
  Object.values(_cdIntervals).forEach(clearInterval);
  _cdIntervals = {};
  ACTIVE_ORDERS.forEach(o => {
    if (o.estimatedAt && !['pending','delivered','cancelled'].includes(o.status)) _startCountdown(o);
  });
}

function _startCountdown(o) {
  const target    = new Date(o.estimatedAt).getTime();
  const startTime = o.acceptedAt ? new Date(o.acceptedAt).getTime() : target - 3600000;
  const total     = target - startTime;
  const tick = () => {
    const val = document.getElementById(`cd-val-${o.id}`);
    const bar = document.getElementById(`cd-bar-${o.id}`);
    if (!val) { clearInterval(_cdIntervals[o.id]); delete _cdIntervals[o.id]; return; }
    const rem = target - Date.now();
    if (rem <= 0) { val.textContent='Совсем скоро!'; val.classList.add('urgent'); if(bar){bar.style.width='0%';bar.classList.add('urgent');} clearInterval(_cdIntervals[o.id]); return; }
    val.textContent = fmtCountdown(rem);
    val.classList.toggle('urgent', rem < 300000);
    if (bar) { bar.style.width=Math.max(0,(rem/total)*100)+'%'; bar.classList.toggle('urgent',rem<300000); }
  };
  tick(); _cdIntervals[o.id] = setInterval(tick, 1000);
}

// ── History ──
async function loadHistory() {
  const container = document.getElementById('history-list');
  container.innerHTML = '<div class="loader"><div class="spinner"></div></div>';
  const orders = (await dbQuery('orders','clientUid','==',STATE.uid))
    .sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,60);
  if (!orders.length) { container.innerHTML='<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Заказов ещё нет</div></div>'; return; }
  container.innerHTML = orders.map(o => `
    <div class="order-card">
      <div class="order-card-hdr">
        <div><div class="font-bold" style="font-size:13px">${o.venueName||'Заведение'}</div><div class="order-id">${fmtDate(o.createdAt)} · #${(o.id||'').slice(-6)}</div></div>
        <div style="text-align:right"><span class="${statusBadgeClass(o.status)}">${statusLabel(o.status)}</span><div class="order-total" style="font-size:16px;margin-top:3px">${fmtPrice(o.total)}</div></div>
      </div>
      <div class="order-card-body">
        <div class="text-sm text-dim">${(o.items||[]).map(i=>`${i.emoji||'🍽️'} ${i.name} ×${i.qty}`).join(', ')}</div>
      </div>
    </div>`).join('');
}

// ══════════════════════════════════════════════════════════
//  REVIEWS
// ══════════════════════════════════════════════════════════
async function openReviews() {
  if (!CURRENT_VENUE) return;
  _currentReviewVenueId = CURRENT_VENUE.id;
  showScreen('s-reviews');
  await renderReviews();
}

function closeReviews() {
  showScreen('s-venue');
}

async function renderReviews() {
  const venueId = _currentReviewVenueId;
  const mySection = document.getElementById('my-review-section');
  const listEl    = document.getElementById('reviews-list');

  const myReviewId = `${venueId}_${STATE.uid}`;
  const myReview   = await dbGet('reviews', myReviewId);
  let selectedStars = myReview?.stars || 0;

  if (myReview) {
    mySection.innerHTML = `
      <div class="section" style="margin-bottom:16px">
        <div class="section-title">Мой отзыв</div>
        <div class="review-card" style="border-color:var(--primary);border-width:1.5px">
          <div class="star-row">${renderStars(myReview.stars)}</div>
          <div class="review-text">${myReview.text||''}</div>
          <div class="review-date">${fmtDate(myReview.updatedAt||myReview.createdAt)}</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn btn-sm btn-outline" onclick="editReview()">✏️ Изменить</button>
            <button class="btn btn-sm btn-danger" onclick="deleteReview()">🗑 Удалить</button>
          </div>
        </div>
      </div>`;
  } else {
    mySection.innerHTML = `
      <div class="section" style="margin-bottom:16px">
        <div class="section-title">Оставить отзыв</div>
        <div class="card card-body" style="gap:10px">
          <div><div class="text-dim text-sm" style="margin-bottom:6px">Оценка</div>
            <div class="star-row" id="review-stars-sel">
              ${[1,2,3,4,5].map(i=>`<span class="star star-interactive ${i<=selectedStars?'star-filled':'star-empty'}" onclick="selectReviewStar(${i})" style="font-size:28px">★</span>`).join('')}
            </div>
          </div>
          <div class="field"><label>Комментарий</label><textarea class="inp" id="review-text" rows="3" placeholder="Поделитесь впечатлениями..."></textarea></div>
          <button class="btn btn-primary btn-sm" onclick="submitReview()">Отправить отзыв</button>
        </div>
      </div>`;
  }

  const allReviews = (await dbQuery('reviews','venueId','==',venueId))
    .filter(r => r.uid !== STATE.uid)
    .sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  if (!allReviews.length) { listEl.innerHTML='<div class="empty" style="padding:24px"><div class="empty-icon">💬</div><div class="empty-text">Отзывов ещё нет</div></div>'; return; }
  listEl.innerHTML = allReviews.map(r => `
    <div class="review-card" style="margin-bottom:10px">
      <div class="flex items-center gap-2">
        <div class="avatar" style="width:32px;height:32px;font-size:13px">${(r.userName||'?')[0].toUpperCase()}</div>
        <div class="review-user">${r.userName||'Пользователь'}</div>
        <div class="star-row" style="margin-left:auto">${renderStars(r.stars)}</div>
      </div>
      <div class="review-text">${r.text||''}</div>
      <div class="review-date">${fmtDate(r.updatedAt||r.createdAt)}</div>
    </div>`).join('');
}

let _reviewStarsSel = 0;
function selectReviewStar(n) {
  _reviewStarsSel = n;
  const row = document.getElementById('review-stars-sel');
  if (!row) return;
  row.querySelectorAll('.star').forEach((s,i) => {
    s.classList.toggle('star-filled', i<n);
    s.classList.toggle('star-empty',  i>=n);
  });
}

async function submitReview() {
  if (_reviewStarsSel < 1) { showToast('Выберите оценку', 'warning'); return; }
  const text = document.getElementById('review-text')?.value.trim() || '';
  const venueId  = _currentReviewVenueId;
  const reviewId = `${venueId}_${STATE.uid}`;
  await dbSet('reviews', reviewId, {
    uid: STATE.uid, venueId, stars: _reviewStarsSel, text,
    userName: STATE.user?.name||'Пользователь',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  await updateVenueRating(venueId);
  tgHaptic('success'); showToast('Отзыв отправлен!', 'success');
  _reviewStarsSel = 0;
  renderReviews();
}

async function editReview() {
  const venueId  = _currentReviewVenueId;
  const reviewId = `${venueId}_${STATE.uid}`;
  const r = await dbGet('reviews', reviewId);
  if (!r) return;
  const mySection = document.getElementById('my-review-section');
  _reviewStarsSel = r.stars || 0;
  mySection.innerHTML = `
    <div class="section" style="margin-bottom:16px">
      <div class="section-title">Редактировать отзыв</div>
      <div class="card card-body" style="gap:10px">
        <div><div class="text-dim text-sm" style="margin-bottom:6px">Оценка</div>
          <div class="star-row" id="review-stars-sel">
            ${[1,2,3,4,5].map(i=>`<span class="star star-interactive ${i<=_reviewStarsSel?'star-filled':'star-empty'}" onclick="selectReviewStar(${i})" style="font-size:28px">★</span>`).join('')}
          </div>
        </div>
        <div class="field"><label>Комментарий</label><textarea class="inp" id="review-text" rows="3">${r.text||''}</textarea></div>
        <button class="btn btn-primary btn-sm" onclick="submitEditReview()">Сохранить</button>
        <button class="btn btn-ghost btn-sm" onclick="renderReviews()">Отмена</button>
      </div>
    </div>`;
}

async function submitEditReview() {
  if (_reviewStarsSel < 1) { showToast('Выберите оценку', 'warning'); return; }
  const text    = document.getElementById('review-text')?.value.trim() || '';
  const venueId = _currentReviewVenueId;
  await dbSet('reviews', `${venueId}_${STATE.uid}`, { stars: _reviewStarsSel, text, updatedAt: new Date().toISOString() });
  await updateVenueRating(venueId);
  tgHaptic('success'); showToast('Отзыв обновлён', 'success');
  renderReviews();
}

async function deleteReview() {
  if (!confirm('Удалить отзыв?')) return;
  const venueId = _currentReviewVenueId;
  await dbDelete('reviews', `${venueId}_${STATE.uid}`);
  await updateVenueRating(venueId);
  tgHaptic('light'); showToast('Отзыв удалён', 'info');
  renderReviews();
}

async function updateVenueRating(venueId) {
  const reviews = await dbQuery('reviews','venueId','==',venueId);
  if (!reviews.length) { await dbSet('venues', venueId, { rating: 0, reviewCount: 0 }); return; }
  const avg = reviews.reduce((s,r)=>s+(r.stars||0),0) / reviews.length;
  await dbSet('venues', venueId, { rating: Math.round(avg*10)/10, reviewCount: reviews.length });
  const venue = VENUES.find(v => v.id === venueId);
  if (venue) { venue.rating = Math.round(avg*10)/10; venue.reviewCount = reviews.length; }
  if (CURRENT_VENUE?.id === venueId) {
    document.getElementById('venue-stars-el').innerHTML = renderStars(avg);
    document.getElementById('venue-rating-val').textContent = avg.toFixed(1);
    document.getElementById('venue-rating-cnt').textContent = `(${reviews.length} отзывов)`;
  }
}

// ══════════════════════════════════════════════════════════
//  SETTINGS / PROFILE
// ══════════════════════════════════════════════════════════
function loadSettings2() {
  const u = STATE.user;
  if (!u) return;
  document.getElementById('profile-name').textContent   = u.name   || '—';
  document.getElementById('profile-phone').textContent  = u.phone  || '—';
  document.getElementById('profile-avatar').textContent = (u.name||'?')[0].toUpperCase();
  const saved = u.savedAddress;
  if (saved) {
    document.getElementById('saved-street').value = saved.street||'';
    document.getElementById('saved-house').value  = saved.house ||'';
    document.getElementById('saved-apt').value    = saved.apt   ||'';
  }
  const favList = document.getElementById('favorites-list');
  const favVenues = VENUES.filter(v => FAVORITES.includes(v.id));
  if (!favVenues.length) { favList.innerHTML='<div class="text-dim text-sm">Нет избранных заведений</div>'; return; }
  favList.innerHTML = favVenues.map(v => `
    <div class="list-item" onclick="openVenue('${v.id}');setNav(document.getElementById('nav-home'))">
      <div class="li-icon yellow">${CATEGORIES.find(c=>c.id===v.categoryId)?.icon||'🏪'}</div>
      <div class="li-body"><div class="li-title">${v.name}</div><div class="li-sub">${isVenueOpen(v)?'Открыто':'Закрыто'}</div></div>
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
  saveClientState();
  await dbSet('users', STATE.uid, { savedAddress });
  tgHaptic('success'); showToast('Адрес сохранён', 'success');
}

// ══════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════
function navTo(screenId) {
  showScreen(screenId);
  document.getElementById('cart-fab').classList.add('hidden');
  if (screenId === 's-home') loadVenues();
  if (screenId === 's-orders') renderAllActiveOrders();
}

function navToOrders() {
  if (ACTIVE_ORDERS.length > 0) { navTo('s-orders'); }
  else { navTo('s-history'); loadHistory(); }
}

function setNav(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
}
