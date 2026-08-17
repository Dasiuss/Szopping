(function () {
  'use strict';

  const REST_URL = SUPABASE_URL + '/rest/v1/items';
  const AUTH_URL = SUPABASE_URL + '/auth/v1/token';
  const BASE_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  const SESSION_KEY = 'szopping_session';
  const ITEMS_KEY = 'szopping_items';
  const POLL_MS = 60000;

  const els = {
    header: document.getElementById('app-header'),
    login: document.getElementById('view-login'),
    loginForm: document.getElementById('login-form'),
    loginEmail: document.getElementById('login-email'),
    loginPassword: document.getElementById('login-password'),
    loginError: document.getElementById('login-error'),
    master: document.getElementById('view-master'),
    shopping: document.getElementById('view-shopping'),
    masterList: document.getElementById('master-list'),
    shoppingList: document.getElementById('shopping-list'),
    addForm: document.getElementById('add-form'),
    addInput: document.getElementById('add-input'),
    clearBtn: document.getElementById('clear-btn'),
    masterEditBtn: document.getElementById('master-edit-btn'),
    shoppingEditBtn: document.getElementById('shopping-edit-btn'),
    version: document.getElementById('version'),
    tabMaster: document.getElementById('tab-master'),
    tabShopping: document.getElementById('tab-shopping')
  };

  let items = [];
  let boughtSession = new Set();
  let currentView = 'master';
  let editMode = false;
  let session = loadSession();
  let realtimeStarted = false;
  let hasData = false;

  window.__rt = window.__rt || {};
  window.__rt.onReady = function () {
    if (session) startRealtime();
  };

  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (s && s.access_token) return s;
    } catch (e) {}
    return null;
  }

  function saveSession(s) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    session = null;
  }

  function refreshSession() {
    return fetch(AUTH_URL + '?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || session.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000
      };
      saveSession(session);
      applyRealtimeAuth();
      return session;
    }).catch(function (e) {
      clearSession();
      showLogin();
      throw e;
    });
  }

  function authHeaders() {
    if (!session) return Promise.reject(new Error('no session'));
    if (Date.now() >= session.expires_at - 60000) {
      return refreshSession().then(function (s) {
        return Object.assign({}, BASE_HEADERS, { 'Authorization': 'Bearer ' + s.access_token });
      });
    }
    return Promise.resolve(
      Object.assign({}, BASE_HEADERS, { 'Authorization': 'Bearer ' + session.access_token })
    );
  }

  function api(path, options) {
    options = options || {};
    return authHeaders().then(function (headers) {
      var req = {
        method: options.method || 'GET',
        headers: Object.assign({}, headers, options.headers || {})
      };
      if (options.body !== undefined) req.body = options.body;
      return fetch(REST_URL + path, req);
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        clearSession();
        showLogin();
        throw new Error('HTTP ' + res.status);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (res.status === 204) return null;
      return res.json();
    });
  }

  function signIn(email, password) {
    return fetch(AUTH_URL + '?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000
      };
      saveSession(session);
      applyRealtimeAuth();
    });
  }

  function applyRealtimeAuth() {
    var client = window.__rt && window.__rt.client;
    if (client && session && session.access_token) {
      client.setAuth(session.access_token);
    }
  }

  function startRealtime() {
    var RT = window.__rt && window.__rt.RealtimeClient;
    if (realtimeStarted || !RT || !session) return;
    realtimeStarted = true;
    var client = new RT(
      SUPABASE_URL.replace('https://', 'wss://') + '/realtime/v1',
      { params: { apikey: SUPABASE_KEY } }
    );
    window.__rt.client = client;
    applyRealtimeAuth();
    client.connect();
    client.channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, function (payload) {
        handleRealtimeEvent(payload);
      })
      .subscribe(function (status) {
        if (status === 'CHANNEL_ERROR') fetchItems();
      });
  }

  function showLogin() {
    els.header.hidden = true;
    els.login.hidden = false;
    els.master.hidden = true;
    els.shopping.hidden = true;
  }

  function showApp() {
    els.header.hidden = false;
    els.login.hidden = true;
    setView(currentView);
    startRealtime();
    fetchItems();
  }

  function compareOrder(a, b, key) {
    var oa = (a[key] == null) ? Infinity : a[key];
    var ob = (b[key] == null) ? Infinity : b[key];
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' });
  }

  function byMasterOrder(a, b) { return compareOrder(a, b, 'master_order'); }
  function byShopOrder(a, b) { return compareOrder(a, b, 'shop_order'); }

  function persistCache() {
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
    } catch (e) {}
  }

  function restoreCache() {
    try {
      var raw = localStorage.getItem(ITEMS_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (Array.isArray(data)) {
        items = data;
      } else if (data && Array.isArray(data.items)) {
        items = data.items;
      } else {
        return;
      }
      boughtSession = new Set();
      hasData = true;
    } catch (e) {}
  }

  function fetchItems() {
    if (!session) return Promise.resolve();
    return api('?select=id,name,to_buy,master_order,shop_order')
      .then(function (rows) {
        items = rows;
        boughtSession = new Set(items.filter(function (it) {
          return boughtSession.has(it.id);
        }).map(function (it) {
          return it.id;
        }));
        hasData = true;
        render();
      })
      .catch(function () {});
  }

  function handleRealtimeEvent(payload) {
    if (!payload || !session) return;

    if (payload.eventType === 'DELETE' && payload.old && payload.old.id) {
      items = items.filter(function (it) { return it.id !== payload.old.id; });
      boughtSession.delete(payload.old.id);
      render();
      return;
    }

    var rec = payload.new;
    if (!rec || !rec.id) return;

    var existing = findItem(rec.id);

    if (payload.eventType === 'INSERT' && existing) {
      applyRecord(existing, rec);
      render();
      return;
    }

    if (!existing) {
      items.push(rec);
      render();
      return;
    }

    var wasToBuy = existing.to_buy || boughtSession.has(rec.id);
    applyRecord(existing, rec);

    if (existing.to_buy) {
      boughtSession.delete(rec.id);
    } else if (wasToBuy) {
      boughtSession.add(rec.id);
    }

    render();
  }

  function applyRecord(target, rec) {
    target.name = rec.name;
    target.to_buy = rec.to_buy;
    target.master_order = rec.master_order;
    target.shop_order = rec.shop_order;
  }

  function findItem(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  function patchItem(id, patch) {
    return api('?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    }).then(function (rows) {
      if (rows && rows.length) {
        var it = findItem(id);
        if (it) applyRecord(it, rows[0]);
      }
    }).catch(function () {});
  }

  function nextOrder(key) {
    var max = -1;
    items.forEach(function (it) {
      var v = it[key];
      if (v != null && v > max) max = v;
    });
    return max + 1;
  }

  function addItem(name) {
    return api('', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        name: name,
        to_buy: false,
        master_order: nextOrder('master_order'),
        shop_order: nextOrder('shop_order')
      })
    }).then(function (rows) {
      if (rows && rows.length) {
        var rec = rows[0];
        var existing = findItem(rec.id);
        if (existing) {
          applyRecord(existing, rec);
        } else {
          items.push(rec);
        }
      }
      render();
    }).catch(function () {});
  }

  function setToBuy(id, value) {
    patchItem(id, { to_buy: value }).then(function () { render(); });
  }

  function removeItem(id) {
    if (!window.confirm('Usunac element z listy?')) return;
    api('?id=eq.' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        items = items.filter(function (it) { return it.id !== id; });
        boughtSession.delete(id);
        render();
      })
      .catch(function () {});
  }

  function toggleBought(id, checked) {
    if (checked) {
      boughtSession.add(id);
      setToBuy(id, false);
    } else {
      boughtSession.delete(id);
      setToBuy(id, true);
    }
  }

  function render() {
    if (hasData) persistCache();
    if (currentView === 'master') renderMaster();
    else renderShopping();
  }

  function renderEmpty(listEl, message) {
    var empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = message;
    listEl.appendChild(empty);
  }

  function checkboxRow(it, checked, liClass, nameClass, onChange) {
    var li = document.createElement('li');
    li.className = 'item' + (liClass ? ' ' + liClass : '');

    var label = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', function () { onChange(cb.checked); });

    var span = document.createElement('span');
    span.className = 'name' + (nameClass ? ' ' + nameClass : '');
    span.textContent = it.name;

    label.appendChild(cb);
    label.appendChild(span);
    li.appendChild(label);
    return li;
  }

  function renderMaster() {
    els.masterList.textContent = '';
    if (items.length === 0) {
      renderEmpty(els.masterList, 'Lista jest pusta. Dodaj pierwszy element.');
      return;
    }
    var sorted = items.slice().sort(byMasterOrder);
    sorted.forEach(function (it, i) {
      if (editMode) {
        renderEditRow(els.masterList, it, 'master', i, sorted.length);
        return;
      }
      els.masterList.appendChild(checkboxRow(
        it,
        it.to_buy,
        '',
        it.to_buy ? 'tobuy' : '',
        function (v) { setToBuy(it.id, v); }
      ));
    });
  }

  function renderEditRow(listEl, it, view, idx, len) {
    var li = document.createElement('li');
    li.className = 'item edit';

    var span = document.createElement('span');
    span.className = 'name';
    span.textContent = it.name;

    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'move up';
    up.textContent = '▲';
    up.disabled = idx === 0;
    up.addEventListener('click', function () { moveItem(it.id, view, -1); });

    var down = document.createElement('button');
    down.type = 'button';
    down.className = 'move down';
    down.textContent = '▼';
    down.disabled = idx === len - 1;
    down.addEventListener('click', function () { moveItem(it.id, view, 1); });

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete';
    del.textContent = 'Usun';
    del.addEventListener('click', function () { removeItem(it.id); });

    li.appendChild(span);
    li.appendChild(up);
    li.appendChild(down);
    li.appendChild(del);
    listEl.appendChild(li);
  }

  function moveItem(id, view, delta) {
    var key = view === 'master' ? 'master_order' : 'shop_order';
    var cmp = view === 'master' ? byMasterOrder : byShopOrder;
    var arr = items.slice().sort(cmp);
    var idx = -1;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { idx = i; break; }
    }
    var newIdx = idx + delta;
    if (idx < 0 || newIdx < 0 || newIdx >= arr.length) return;

    var tmp = arr[idx];
    arr[idx] = arr[newIdx];
    arr[newIdx] = tmp;

    var changes = [];
    arr.forEach(function (it, pos) {
      var was = it[key];
      it[key] = pos;
      if (was !== pos) changes.push(it);
    });

    render();
    changes.forEach(function (it) {
      var patch = {};
      patch[key] = it[key];
      patchItem(it.id, patch);
    });
  }

  function renderShopping() {
    var all = items.slice().sort(byShopOrder);
    var visible = editMode ? all : all.filter(function (it) {
      return it.to_buy || boughtSession.has(it.id);
    });
    els.shoppingList.textContent = '';
    if (visible.length === 0) {
      renderEmpty(els.shoppingList, 'Brak elementow do kupienia.');
      return;
    }
    visible.forEach(function (it, i) {
      if (editMode) {
        renderEditRow(els.shoppingList, it, 'shopping', i, visible.length);
        return;
      }
      var bought = boughtSession.has(it.id);
      els.shoppingList.appendChild(checkboxRow(
        it,
        bought,
        bought ? 'bought' : '',
        bought ? 'bought' : '',
        function (v) { toggleBought(it.id, v); }
      ));
    });
  }

  function setView(view) {
    currentView = view;
    editMode = false;
    els.master.hidden = view !== 'master';
    els.shopping.hidden = view !== 'shopping';
    els.tabMaster.classList.toggle('active', view === 'master');
    els.tabShopping.classList.toggle('active', view === 'shopping');
    updateEditButtons();
    render();
  }

  function updateEditButtons() {
    var label = editMode ? 'Zakończ edycję' : 'Edytuj kolejność';
    els.masterEditBtn.textContent = label;
    els.shoppingEditBtn.textContent = label;
    els.clearBtn.hidden = editMode;
  }

  function setEditMode(mode) {
    editMode = mode;
    updateEditButtons();
    render();
  }

  function pollTick() {
    if (document.visibilityState === 'visible' && session) fetchItems();
  }

  els.loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    els.loginError.hidden = true;
    var email = els.loginEmail.value.trim();
    var password = els.loginPassword.value;
    signIn(email, password).then(function () {
      els.loginPassword.value = '';
      showApp();
    }).catch(function () {
      els.loginError.textContent = 'Bledny email lub haslo';
      els.loginError.hidden = false;
    });
  });

  els.addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = els.addInput.value.trim();
    if (!name) return;
    addItem(name);
    els.addInput.value = '';
  });

  els.clearBtn.addEventListener('click', function () {
    boughtSession.clear();
    render();
  });

  els.tabMaster.addEventListener('click', function () { setView('master'); });
  els.tabShopping.addEventListener('click', function () { setView('shopping'); });
  els.masterEditBtn.addEventListener('click', function () { setEditMode(!editMode); });
  els.shoppingEditBtn.addEventListener('click', function () { setEditMode(!editMode); });

  document.addEventListener('visibilitychange', function () {
    if (!session) return;
    var client = window.__rt && window.__rt.client;
    if (document.visibilityState === 'visible') {
      fetchItems();
      if (client && !client.isConnected()) client.connect();
    } else if (client) {
      client.disconnect();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  }

  setInterval(pollTick, POLL_MS);

  els.version.textContent = 'Wersja ' + APP_VERSION;

  restoreCache();
  if (session) showApp(); else showLogin();
})();
