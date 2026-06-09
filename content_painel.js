'use strict';

/* ─── CONFIG ──────────────────────────────────────────────────────────── */
const PS = {
  url:     'https://dqiosohjicnruwrhxeou.supabase.co',
  key:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxaW9zb2hqaWNucnV3cmh4ZW91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTI0NzcsImV4cCI6MjA4ODA2ODQ3N30.y5LVH3Lb9xDuHLDVvDaNCrzuS2RsJenI0EqgVtHBWfM',
  allowed: ['alcsolha@gmail.com', 'brunosims@gmail.com'],
  sk:      'ps_session'
};

/* ─── STATE ───────────────────────────────────────────────────────────── */
const PSS = {
  session:      null,
  profiles:     {},
  panelOpen:    false,
  period:       'today',   // 'today' | 'month'
  dashData:     null,
  dashLoading:  false,
  dashError:    null,
  searchTimer:  null,
  searchLoading: false
};

/* ─── STORAGE ─────────────────────────────────────────────────────────── */
async function psLoadSession() {
  const r = await chrome.storage.local.get(PS.sk);
  return r[PS.sk] || null;
}

async function psSaveSession(d) {
  const s = { access_token: d.access_token, refresh_token: d.refresh_token, user: d.user };
  await chrome.storage.local.set({ [PS.sk]: s });
  PSS.session = s;
}

async function psClearSession() {
  await chrome.storage.local.remove(PS.sk);
  PSS.session = null;
}

/* ─── AUTH ────────────────────────────────────────────────────────────── */
async function psTryRefresh(session) {
  if (!session?.refresh_token) return null;
  try {
    const res = await fetch(`${PS.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: PS.key },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/* ─── API ─────────────────────────────────────────────────────────────── */
async function psFetch(path, opts = {}) {
  const doReq = (token) => fetch(`${PS.url}${path}`, {
    ...opts,
    headers: {
      apikey: PS.key,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers
    }
  });

  let res = await doReq(PSS.session?.access_token);

  if (res.status === 401 && PSS.session?.refresh_token) {
    const refreshed = await psTryRefresh(PSS.session);
    if (refreshed) {
      await psSaveSession(refreshed);
      res = await doReq(PSS.session.access_token);
    } else {
      await psClearSession();
      psShowLoginPrompt();
      throw new Error('Sessão expirada.');
    }
  }
  return res;
}

async function psRpc(fn, params) {
  const res = await psFetch(`/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.hint || `Erro: ${fn}`);
  return data;
}

async function psLoadProfiles() {
  try {
    const res = await psFetch('/rest/v1/hub_user_profiles?select=user_id,display_name');
    if (!res.ok) return;
    const data = await res.json();
    PSS.profiles = {};
    for (const p of data) { if (p.display_name) PSS.profiles[p.user_id] = p.display_name; }
  } catch {}
}

async function psApiDash(from, to) {
  return psRpc('get_dashboard_stats', { p_from: from.toISOString(), p_to: to.toISOString() });
}

async function psApiSearch(value) {
  const clean = value.trim();
  const params = { p_limit: 20 };
  if (/^\d{4,}$/.test(clean)) {
    params.p_sale = clean;
  } else {
    params.p_login = clean;
  }
  return psRpc('search_order_picker_history', params);
}

/* ─── DATE HELPERS ────────────────────────────────────────────────────── */
function psPeriodRange(period) {
  const now = new Date();
  if (period === 'today') {
    return { from: new Date(now.getTime() - 86400000), to: now };
  }
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to:   new Date(now.getFullYear(), now.getMonth() + 1, 1)
  };
}

function psFmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function psName(row) {
  return PSS.profiles[row.user_id] || row.owner_email?.split('@')[0] || '-';
}

function psEsc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── DOM REFS ────────────────────────────────────────────────────────── */
const el = (id) => document.getElementById(id);

/* ─── BUILD UI ────────────────────────────────────────────────────────── */
function psInject() {
  if (el('ps-root')) return;

  const root = document.createElement('div');
  root.id = 'ps-root';
  root.innerHTML = `
    <!-- Floating button -->
    <button id="ps-btn" title="Painel Sentinela">
      <img id="ps-btn-img" width="44" height="44" style="display:block;border-radius:8px;pointer-events:none"/>
    </button>

    <!-- Slide-in panel -->
    <div id="ps-panel">
      <div id="ps-header">
        <div class="ps-logo">
          <svg width="22" height="22" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="10" fill="#4f46e5"/>
            <path d="M24 8L38 15V24C38 33 31.5 41 24 43C16.5 41 10 33 10 24V15L24 8Z" fill="white" opacity=".9"/>
            <path d="M19 24L23 28L30 20" stroke="#4f46e5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Painel Sentinela
        </div>
        <div class="ps-hdr-btns">
          <button class="ps-hdr-btn" id="ps-full-btn" title="Abrir painel completo em nova aba">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Painel Completo
          </button>
          <button class="ps-hdr-btn ps-close" id="ps-close-btn" title="Fechar">✕</button>
        </div>
      </div>

      <div id="ps-body">
        <!-- Dashboard section -->
        <div class="ps-sec" id="ps-dash-sec">
          <div class="ps-sec-head">
            <span class="ps-sec-title">Dashboard</span>
            <div class="ps-ptoggle">
              <button class="ps-pbtn ps-on" data-p="today">Hoje</button>
              <button class="ps-pbtn" data-p="month">Este Mês</button>
            </div>
          </div>
          <div id="ps-dash-body">
            <div class="ps-loading"><div class="ps-spinner"></div> Carregando...</div>
          </div>
        </div>

        <!-- Search section -->
        <div class="ps-sec" id="ps-search-sec">
          <div class="ps-sec-head">
            <span class="ps-sec-title">Busca de Pedidos</span>
          </div>
          <div class="ps-search-wrap">
            <div class="ps-search-inner">
              <span class="ps-search-ic">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
              </span>
              <input id="ps-search" type="text" placeholder="Cole login ou número da venda..."/>
              <button id="ps-search-clear" class="ps-search-clear ps-hidden" title="Limpar">✕</button>
            </div>
          </div>
          <div id="ps-results"></div>
        </div>
      </div>

      <!-- Login prompt (shown when not authenticated) -->
      <div id="ps-login-prompt" class="ps-hidden">
        <div class="ps-login-box">
          <div class="ps-login-icon">
            <svg width="36" height="36" viewBox="0 0 48 48" fill="none">
              <rect width="48" height="48" rx="12" fill="#4f46e5"/>
              <path d="M24 8L38 15V24C38 33 31.5 41 24 43C16.5 41 10 33 10 24V15L24 8Z" fill="white" opacity=".9"/>
              <path d="M19 24L23 28L30 20" stroke="#4f46e5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <p class="ps-login-title">Painel Sentinela</p>
          <p class="ps-prompt-msg">Entre com sua conta para continuar.</p>
          <div class="ps-login-fields">
            <input type="email" id="ps-login-email" class="ps-login-input" placeholder="Email" autocomplete="email"/>
            <input type="password" id="ps-login-pw" class="ps-login-input" placeholder="Senha" autocomplete="current-password"/>
          </div>
          <div id="ps-login-err" class="ps-login-err ps-hidden"></div>
          <button id="ps-login-btn" class="ps-login-submit">Entrar</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  // Use the extension's own icon so it updates automatically when the user changes it
  document.getElementById('ps-btn-img').src = chrome.runtime.getURL('icon48.png');
  psBindEvents();
}

/* ─── EVENTS ──────────────────────────────────────────────────────────── */
function psBindEvents() {
  el('ps-btn').addEventListener('click', psOpen);
  el('ps-close-btn').addEventListener('click', psClose);
  el('ps-full-btn').addEventListener('click', psOpenFull);
  el('ps-login-btn').addEventListener('click', psDoLogin);
  el('ps-login-email').addEventListener('keydown', e => { if (e.key === 'Enter') el('ps-login-pw').focus(); });
  el('ps-login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') psDoLogin(); });

  // Period toggle
  document.querySelectorAll('.ps-pbtn').forEach(btn => {
    btn.addEventListener('click', () => psSwitchPeriod(btn.dataset.p));
  });

  // Dynamic search
  const inp   = el('ps-search');
  const clrBtn = el('ps-search-clear');

  const psUpdateClear = () => {
    clrBtn.classList.toggle('ps-hidden', !inp.value);
  };

  inp.addEventListener('input', () => { psOnSearchInput(inp.value); psUpdateClear(); });
  inp.addEventListener('paste', () => {
    setTimeout(() => { psOnSearchInput(inp.value); psUpdateClear(); }, 0);
  });

  clrBtn.addEventListener('click', () => {
    inp.value = '';
    el('ps-results').innerHTML = '';
    clearTimeout(PSS.searchTimer);
    clrBtn.classList.add('ps-hidden');
    inp.focus();
  });
}

function psOpenFull() {
  chrome.runtime.sendMessage({ action: 'PS_OPEN_PANEL' });
}

function psOpen() {
  PSS.panelOpen = true;
  el('ps-panel').classList.add('ps-open');
  el('ps-btn').style.display = 'none';
  if (!PSS.dashData && !PSS.dashLoading) psLoadDash();
}

function psClose() {
  PSS.panelOpen = false;
  el('ps-panel').classList.remove('ps-open');
  el('ps-btn').style.display = '';
}

/* ─── AUTH STATE ──────────────────────────────────────────────────────── */
function psShowLoginPrompt() {
  el('ps-body').classList.add('ps-hidden');
  el('ps-login-prompt').classList.remove('ps-hidden');
  const errEl = el('ps-login-err');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('ps-hidden'); }
  const btn = el('ps-login-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
}

function psShowApp() {
  el('ps-body').classList.remove('ps-hidden');
  el('ps-login-prompt').classList.add('ps-hidden');
}

async function psDoLogin() {
  const email = el('ps-login-email').value.trim();
  const pw    = el('ps-login-pw').value;
  const errEl = el('ps-login-err');
  const btn   = el('ps-login-btn');

  errEl.classList.add('ps-hidden');

  if (!email || !pw) {
    errEl.textContent = 'Preencha email e senha.';
    errEl.classList.remove('ps-hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="ps-spinner-sm"></span> Entrando...';

  try {
    const res = await fetch(`${PS.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: PS.key },
      body: JSON.stringify({ email, password: pw })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.message || 'Credenciais inválidas.');

    if (!PS.allowed.includes(data.user?.email)) {
      throw new Error('Acesso não autorizado para este email.');
    }

    await psSaveSession(data);
    psShowApp();
    await psLoadProfiles();
    if (PSS.panelOpen && !PSS.dashData && !PSS.dashLoading) psLoadDash();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('ps-hidden');
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

/* ─── DASHBOARD ───────────────────────────────────────────────────────── */
async function psLoadDash() {
  const { from, to } = psPeriodRange(PSS.period);
  PSS.dashLoading = true;
  PSS.dashError = null;
  psRenderDashLoading();

  try {
    PSS.dashData = await psApiDash(from, to);
    psRenderDash(PSS.dashData);
  } catch (err) {
    PSS.dashError = err.message;
    psRenderDashError(err.message);
  } finally {
    PSS.dashLoading = false;
  }
}

function psRenderDashLoading() {
  el('ps-dash-body').innerHTML = `<div class="ps-loading"><div class="ps-spinner"></div> Carregando...</div>`;
}

function psRenderDashError(msg) {
  el('ps-dash-body').innerHTML = `<div class="ps-err">${psEsc(msg)}</div>`;
}

function psRenderDash(data) {
  if (!data || data.length === 0) {
    el('ps-dash-body').innerHTML = `<div class="ps-empty">Nenhum pedido no período.</div>`;
    return;
  }

  const total    = data.reduce((s, r) => s + Number(r.order_count), 0);
  const maxCount = Math.max(...data.map(r => Number(r.order_count)));
  const COLORS      = ['#4f46e5','#06b6d4','#10b981','#f59e0b','#ef4444','#8b5cf6'];
  const RANK_COLORS = ['#f59e0b','#94a3b8','#b45309'];

  const rows = data.map((r, i) => {
    const count    = Number(r.order_count);
    const bar      = maxCount > 0 ? (count / maxCount * 100).toFixed(1) : '0';
    const name     = r.display_name || r.owner_email?.split('@')[0] || '?';
    const color    = COLORS[i % COLORS.length];
    const rankClr  = RANK_COLORS[i] || '#484f58';
    const pct      = total > 0 ? (count / total * 100).toFixed(1) : '0';
    const initials = name.split(/[\s@._-]+/).slice(0,2).map(w => w[0]?.toUpperCase() || '').join('') || '?';
    return `
      <div class="ps-user-row">
        <span class="ps-rank" style="color:${rankClr}">${i + 1}</span>
        <span class="ps-avatar" style="background:${color}22;color:${color};border-color:${color}55">${psEsc(initials)}</span>
        <div class="ps-row-main">
          <div class="ps-row-top">
            <span class="ps-uname" title="${psEsc(name)}">${psEsc(name)}</span>
            <span class="ps-ucount"><span class="ps-ucount-lbl">qtd</span>${count}</span>
          </div>
          <div class="ps-bar-row">
            <div class="ps-bar-outer">
              <div class="ps-bar-inner" style="width:${bar}%;background:${color}"></div>
            </div>
            <span class="ps-upct">${pct}%</span>
          </div>
        </div>
      </div>`;
  }).join('');

  el('ps-dash-body').innerHTML = `
    <div class="ps-dash">
      <div class="ps-total-hero">
        <span class="ps-total-hero-val">${total}</span>
        <span class="ps-total-hero-lbl">${PSS.period === 'today' ? 'pedidos hoje' : 'pedidos este mês'}</span>
      </div>
      ${rows}
    </div>`;
}

async function psSwitchPeriod(period) {
  PSS.period = period;
  PSS.dashData = null;

  document.querySelectorAll('.ps-pbtn').forEach(b => {
    b.classList.toggle('ps-on', b.dataset.p === period);
  });

  await psLoadDash();
}

/* ─── SEARCH ──────────────────────────────────────────────────────────── */
function psOnSearchInput(value) {
  clearTimeout(PSS.searchTimer);

  if (!value.trim()) {
    el('ps-results').innerHTML = '';
    return;
  }

  // Immediate on paste (value length jumped by >4 chars) or 350ms debounce
  const delay = 350;
  PSS.searchTimer = setTimeout(() => psDoSearch(value), delay);
}

async function psDoSearch(value) {
  if (!value.trim()) return;

  el('ps-results').innerHTML = `<div class="ps-loading"><div class="ps-spinner"></div> Buscando...</div>`;
  PSS.searchLoading = true;

  try {
    const results = await psApiSearch(value);
    psRenderResults(results);
  } catch (err) {
    el('ps-results').innerHTML = `<div class="ps-err">${psEsc(err.message)}</div>`;
  } finally {
    PSS.searchLoading = false;
  }
}

function psRenderResults(results) {
  if (!results || results.length === 0) {
    el('ps-results').innerHTML = `<div class="ps-empty">Nenhum resultado encontrado.</div>`;
    return;
  }

  const cards = results.slice(0, 15).map(r => {
    const name   = psEsc(PSS.profiles[r.user_id] || r.owner_email || '-');
    const venda  = r.numero_venda ? `<div class="ps-card-venda"># ${psEsc(r.numero_venda)}</div>` : '';
    const link   = r.url
      ? `<a href="${psEsc(r.url)}" target="_blank" class="ps-card-link">↗ Abrir</a>`
      : '<span></span>';
    return `
      <div class="ps-card">
        <div class="ps-card-top">
          <span class="ps-card-login">${psEsc(r.login_cliente || '-')}</span>
          <span class="ps-card-date">${psFmtDate(r.selected_at)}</span>
        </div>
        ${venda}
        <div class="ps-card-bottom">
          <span class="ps-card-resp">
            <span class="ps-card-resp-label">por</span>${name}
          </span>
          ${link}
        </div>
      </div>`;
  }).join('');

  el('ps-results').innerHTML = cards;
}

/* ─── INIT ────────────────────────────────────────────────────────────── */
async function psInit() {
  psInject();

  const stored = await psLoadSession();
  if (!stored) {
    psShowLoginPrompt();
    return;
  }

  PSS.session = stored;

  // Validate session / refresh
  const refreshed = await psTryRefresh(stored);
  if (refreshed) await psSaveSession(refreshed);

  const email = PSS.session?.user?.email || '';
  if (!PS.allowed.includes(email)) {
    await psClearSession();
    psShowLoginPrompt();
    return;
  }

  psShowApp();
  await psLoadProfiles();
  // Dashboard loads lazily when panel first opens
}

psInit();

/* ─── STORAGE LISTENER ────────────────────────────────────────────────── */
// Detecta quando o usuário loga (ou desloga) na aba do Painel Completo
// e atualiza o mini painel sem precisar recarregar a página do ML.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(PS.sk in changes)) return;

  const newSession = changes[PS.sk].newValue;

  if (newSession) {
    const email = newSession?.user?.email || '';
    if (!PS.allowed.includes(email)) return;

    PSS.session = newSession;
    psShowApp();
    psLoadProfiles().then(() => {
      if (PSS.panelOpen && !PSS.dashData && !PSS.dashLoading) psLoadDash();
    });
  } else {
    // Sessão removida (logout no painel completo)
    PSS.session  = null;
    PSS.profiles = {};
    PSS.dashData = null;
    if (el('ps-results')) el('ps-results').innerHTML = '';
    if (el('ps-search'))  el('ps-search').value = '';
    psShowLoginPrompt();
  }
});
