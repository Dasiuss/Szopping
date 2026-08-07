(function () {
  'use strict';

  const REST_URL = SUPABASE_URL + '/rest/v1/items';
  const BASE_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  const POLL_MS = 3000;

  const els = {
    master: document.getElementById('view-master'),
    shopping: document.getElementById('view-shopping'),
    masterList: document.getElementById('master-list'),
    shoppingList: document.getElementById('shopping-list'),
    addForm: document.getElementById('add-form'),
    addInput: document.getElementById('add-input'),
    clearBtn: document.getElementById('clear-btn'),
    tabMaster: document.getElementById('tab-master'),
    tabShopping: document.getElementById('tab-shopping'),
    status: document.getElementById('status')
  };

  let items = [];
  let boughtSession = new Set();
  let currentView = 'master';
  let lastSync = null;

  function api(path, options) {
    options = options || {};
    const req = {
      method: options.method || 'GET',
      headers: Object.assign({}, BASE_HEADERS, options.headers || {})
    };
    if (options.body !== undefined) req.body = options.body;
    return fetch(REST_URL + path, req).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function sortItems() {
    items.sort(function (a, b) {
      return a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' });
    });
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function refreshStatus() {
    if (lastSync) {
      setStatus('Zaktualizowano ' + lastSync.toLocaleTimeString('pl-PL'));
    }
  }

  function markSynced() {
    lastSync = new Date();
    refreshStatus();
  }

  function fetchItems() {
    return api('?select=id,name,to_buy&order=name.asc')
      .then(function (rows) {
        items = rows;
        boughtSession = new Set(items.filter(function (it) {
          return boughtSession.has(it.id);
        }).map(function (it) {
          return it.id;
        }));
        sortItems();
        render();
        markSynced();
      })
      .catch(function () {
        setStatus('Blad polaczenia z baza');
      });
  }

  function addItem(name) {
    return api('', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: name, to_buy: false })
    }).then(function (rows) {
      if (rows && rows.length) items.push(rows[0]);
      sortItems();
      render();
      markSynced();
    }).catch(function () {
      setStatus('Nie udalo sie dodac elementu');
    });
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
      markSynced();
    }).catch(function () {
      setStatus('Nie udalo sie zapisac');
    });
  }

  function removeItem(id) {
    if (!window.confirm('Usunac element z listy?')) return;
    api('?id=eq.' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        items = items.filter(function (it) { return it.id !== id; });
        boughtSession.delete(id);
        render();
        markSynced();
      })
      .catch(function () {
        setStatus('Nie udalo sie usunac');
      });
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
    if (document.visibilityState === 'visible') fetchItems();
  }

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
    if (document.visibilityState === 'visible') fetchItems();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  }

  setInterval(pollTick, POLL_MS);

  setView('master');
  fetchItems();
})();
