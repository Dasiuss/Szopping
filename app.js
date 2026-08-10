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
    tabMaster: document.getElementById('tab-master'),
    tabShopping: document.getElementById('tab-shopping')
  };

  let items = [];
  let boughtSession = new Set();
  let currentView = 'master';
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

  function sortItems() {
    items.sort(function (a, b) {
      return a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' });
    });
  }

  function persistCache() {
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify({
        items: items,
        bought: Array.from(boughtSession)
      }));
    } catch (e) {}
  }

  function restoreCache() {
    try {
      var raw = localStorage.getItem(ITEMS_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && Array.isArray(data.items)) {
        items = data.items;
        boughtSession = new Set(Array.isArray(data.bought) ? data.bought : []);
        hasData = true;
        sortItems();
      }
    } catch (e) {}
  }

  function fetchItems() {
    if (!session) return Promise.resolve();
    return api('?select=id,name,to_buy&order=name.asc')
      .then(function (rows) {
        items = rows;
        boughtSession = new Set(items.filter(function (it) {
          return boughtSession.has(it.id);
        }).map(function (it) {
          return it.id;
        }));
        hasData = true;
        sortItems();
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

    var existing = items.filter(function (it) { return it.id === rec.id; })[0];

    if (payload.eventType === 'INSERT' && existing) {
      existing.name = rec.name;
      existing.to_buy = rec.to_buy;
      sortItems();
      render();
      return;
    }

    if (!existing) {
      items.push(rec);
      sortItems();
      render();
      return;
    }

    var wasToBuy = existing.to_buy || boughtSession.has(rec.id);
    existing.name = rec.name;
    existing.to_buy = rec.to_buy;

    if (existing.to_buy) {
      boughtSession.delete(rec.id);
    } else if (wasToBuy) {
      boughtSession.add(rec.id);
    }

    sortItems();
    render();
  }

  function addItem(name) {
    return api('', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: name, to_buy: false })
    }).then(function (rows) {
      if (rows && rows.length) {
        var rec = rows[0];
        var existing = items.filter(function (it) { return it.id === rec.id; })[0];
        if (existing) {
          existing.name = rec.name;
          existing.to_buy = rec.to_buy;
        } else {
          items.push(rec);
        }
      }
      sortItems();
      render();
    }).catch(function () {});
  }

  function setToBuy(id, value) {
    return api('?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ to_buy: value })
    }).then(function (rows) {
      if (rows && rows.length) {
        var updated = rows[0];
        for (var i = 0; i < items.length; i++) {
          if (items[i].id === id) {
            items[i].to_buy = updated.to_buy;
            break;
          }
        }
      }
      render();
    }).catch(function () {});
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

  function renderMaster() {
    els.masterList.textContent = '';
    if (items.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Lista jest pusta. Dodaj pierwszy element.';
      els.masterList.appendChild(empty);
      return;
    }
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'item';

      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = it.to_buy;
      cb.addEventListener('change', function () {
        setToBuy(it.id, cb.checked);
      });

      var span = document.createElement('span');
      span.className = 'name' + (it.to_buy ? ' tobuy' : '');
      span.textContent = it.name;

      label.appendChild(cb);
      label.appendChild(span);

      var del = document.createElement('button');
      del.className = 'delete';
      del.type = 'button';
      del.textContent = 'Usun';
      del.addEventListener('click', function () {
        removeItem(it.id);
      });

      li.appendChild(label);
      li.appendChild(del);
      els.masterList.appendChild(li);
    });
  }

  function renderShopping() {
    var visible = items.filter(function (it) {
      return it.to_buy || boughtSession.has(it.id);
    });
    els.shoppingList.textContent = '';
    if (visible.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Brak elementow do kupienia.';
      els.shoppingList.appendChild(empty);
      return;
    }
    visible.forEach(function (it) {
      var bought = boughtSession.has(it.id);

      var li = document.createElement('li');
      li.className = 'item' + (bought ? ' bought' : '');

      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = bought;
      cb.addEventListener('change', function () {
        toggleBought(it.id, cb.checked);
      });

      var span = document.createElement('span');
      span.className = 'name' + (bought ? ' bought' : '');
      span.textContent = it.name;

      label.appendChild(cb);
      label.appendChild(span);
      li.appendChild(label);
      els.shoppingList.appendChild(li);
    });
  }

  function setView(view) {
    currentView = view;
    els.master.hidden = view !== 'master';
    els.shopping.hidden = view !== 'shopping';
    els.tabMaster.classList.toggle('active', view === 'master');
    els.tabShopping.classList.toggle('active', view === 'shopping');
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

  restoreCache();
  if (session) showApp(); else showLogin();
})();
