'use strict';

/* ─── CONFIG ──────────────────────────────────────────────────────────── */
const CFG = {
  url:     'https://dqiosohjicnruwrhxeou.supabase.co',
  key:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxaW9zb2hqaWNucnV3cmh4ZW91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTI0NzcsImV4cCI6MjA4ODA2ODQ3N30.y5LVH3Lb9xDuHLDVvDaNCrzuS2RsJenI0EqgVtHBWfM',
  allowed: ['alcsolha@gmail.com', 'brunosims@gmail.com'],
  sk:      'ps_session'
};

/* ─── STATE ───────────────────────────────────────────────────────────── */
const S = {
  auth:            null,   // { access_token, refresh_token, user }
  profiles:        {},     // user_id → display_name
  view:            'login',

  // Dashboard
  period:          'month',
  customFrom:      null,
  customTo:        null,
  dashboardData:   null,
  dashboardLoading: false,
  dashboardError:  null,

  // Search
  searchLogin:     '',
  searchSale:      '',
  searchResults:   null,
  searchLoading:   false,
  searchError:     null,

  // Login form
  loginError:      null,
  loginLoading:    false
};

/* ─── AUTH ────────────────────────────────────────────────────────────── */
async function signIn(email, password) {
  const res = await fetch(`${CFG.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CFG.key },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.message || 'Credenciais inválidas.');
  return data;
}

function saveSession(d) {
  const s = { access_token: d.access_token, refresh_token: d.refresh_token, user: d.user };
  localStorage.setItem(CFG.sk, JSON.stringify(s));
  S.auth = s;
}

function loadStoredSession() {
  try { return JSON.parse(localStorage.getItem(CFG.sk)); } catch { return null; }
}

async function tryRefresh(session) {
  if (!session?.refresh_token) return null;
  try {
    const res = await fetch(`${CFG.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.key },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function signOut() {
  if (S.auth?.access_token) {
    fetch(`${CFG.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: CFG.key, Authorization: `Bearer ${S.auth.access_token}` }
    }).catch(() => {});
  }
  localStorage.removeItem(CFG.sk);
  Object.assign(S, {
    auth: null, profiles: {}, view: 'login',
    dashboardData: null, dashboardError: null,
    searchResults: null, searchError: null,
    loginError: null, loginLoading: false
  });
  render();
}

/* ─── API ─────────────────────────────────────────────────────────────── */
let _refreshing = false;
let _refreshQueue = [];

async function sbFetch(path, opts = {}) {
  const doReq = (token) => fetch(`${CFG.url}${path}`, {
    ...opts,
    headers: {
      apikey: CFG.key,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers
    }
  });

  let res = await doReq(S.auth?.access_token);

  if (res.status === 401 && S.auth?.refresh_token) {
    if (!_refreshing) {
      _refreshing = true;
      const refreshed = await tryRefresh(S.auth);
      _refreshing = false;
      if (refreshed) {
        saveSession(refreshed);
      } else {
        _refreshQueue.forEach(r => r());
        _refreshQueue = [];
        await signOut();
        throw new Error('Sessão expirada. Por favor, entre novamente.');
      }
      _refreshQueue.forEach(r => r());
      _refreshQueue = [];
    } else {
      await new Promise(resolve => _refreshQueue.push(resolve));
    }
    res = await doReq(S.auth?.access_token);
  }

  return res;
}

async function rpc(fn, params) {
  const res = await sbFetch(`/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.message || data.hint || data.error || '';
    if (fn === 'get_dashboard_stats' && (msg.includes('does not exist') || msg.includes('function'))) {
      throw new Error('Função de dashboard não encontrada. Execute a migration SQL no painel do Supabase primeiro (arquivo: supabase/migrations/20260602000000_add_dashboard_rpc.sql).');
    }
    throw new Error(msg || `Erro ao chamar ${fn}.`);
  }
  return data;
}

async function loadProfiles() {
  try {
    const res = await sbFetch('/rest/v1/hub_user_profiles?select=user_id,display_name');
    if (!res.ok) return;
    const data = await res.json();
    S.profiles = {};
    for (const p of data) { if (p.display_name) S.profiles[p.user_id] = p.display_name; }
  } catch {}
}

async function apiSearch(login, sale) {
  const params = { p_limit: 100 };
  if (login) params.p_login = login;
  if (sale)  params.p_sale  = sale;
  return rpc('search_order_picker_history', params);
}

async function apiDashboard(from, to) {
  return rpc('get_dashboard_stats', { p_from: from.toISOString(), p_to: to.toISOString() });
}

/* ─── DATE HELPERS ────────────────────────────────────────────────────── */
function getPeriodRange() {
  const now = new Date();
  let from, to;

  switch (S.period) {
    case 'today':
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      to   = new Date(from.getTime() + 86400000);
      break;
    case 'week': {
      const day  = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
      to   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      break;
    }
    case 'month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'custom':
      from = S.customFrom || new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to   = S.customTo   || new Date(now.getFullYear(), now.getMonth(), 1);
      break;
  }
  return { from, to };
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function fmtPeriodLabel() {
  const { from, to } = getPeriodRange();
  const d = { day: '2-digit', month: '2-digit', year: 'numeric' };

  if (S.period === 'today')
    return `Hoje — ${from.toLocaleDateString('pt-BR', d)}`;

  if (S.period === 'week')
    return `Esta semana — ${from.toLocaleDateString('pt-BR', d)} a ${new Date(to - 86400000).toLocaleDateString('pt-BR', d)}`;

  if (S.period === 'month') {
    const s = from.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  if (S.period === 'custom' && S.customFrom) {
    const s = S.customFrom.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  return '';
}

function getDisplayName(row) {
  return S.profiles[row.user_id] || row.owner_email || '-';
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── SVG ICONS ───────────────────────────────────────────────────────── */
const ICON = {
  shield: (size) => `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" style="flex-shrink:0">
    <rect width="48" height="48" rx="12" fill="#4f46e5"/>
    <path d="M24 10L36 16V24C36 31.7 30.5 38.9 24 41C17.5 38.9 12 31.7 12 24V16L24 10Z" fill="white" opacity=".9"/>
    <path d="M20 24L23 27L28 21" stroke="#4f46e5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  grid: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
  </svg>`,

  search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>`
};

/* ─── RENDER ──────────────────────────────────────────────────────────── */
function render() {
  const app = document.getElementById('app');
  app.innerHTML = S.view === 'login' ? htmlLogin() : htmlShell();
  bindAll();
}

/* --- Login ---- */
function htmlLogin() {
  return `
<div class="login-wrap">
  <div class="login-card">
    <div class="login-logo">${ICON.shield(48)}<span>Painel Sentinela</span></div>
    <h2>Entrar</h2>
    <p class="login-subtitle">Acesso restrito a administradores</p>
    <form id="loginForm">
      <div class="field mb-16">
        <label for="em">E-mail</label>
        <input type="email" id="em" placeholder="seu@email.com" required autocomplete="email"/>
      </div>
      <div class="field mb-20">
        <label for="pw">Senha</label>
        <input type="password" id="pw" placeholder="••••••••" required autocomplete="current-password"/>
      </div>
      ${S.loginError ? `<div class="error-msg mb-16">${esc(S.loginError)}</div>` : ''}
      <button type="submit" class="btn-primary" style="width:100%" ${S.loginLoading ? 'disabled' : ''}>
        ${S.loginLoading ? `<span class="spinner-sm"></span>&nbsp;Entrando...` : 'Entrar'}
      </button>
    </form>
  </div>
</div>`;
}

/* --- App shell --- */
function htmlShell() {
  const email = S.auth?.user?.email || '';
  const content = S.view === 'search' ? htmlSearch() : htmlDashboard();
  return `
<header class="app-header">
  <div class="header-logo">${ICON.shield(32)}<span>Painel Sentinela</span></div>
  <nav class="app-nav">
    <button class="nav-btn ${S.view === 'dashboard' ? 'active' : ''}" data-view="dashboard">${ICON.grid} Dashboard</button>
    <button class="nav-btn ${S.view === 'search'    ? 'active' : ''}" data-view="search">${ICON.search} Busca</button>
  </nav>
  <div class="header-user">
    <span class="user-email">${esc(email)}</span>
    <button class="btn-logout" id="logoutBtn">Sair</button>
  </div>
</header>
<main class="app-main">${content}</main>`;
}

/* --- Search view --- */
function htmlSearch() {
  let resultsHtml = '';

  if (S.searchLoading) {
    resultsHtml = `<div class="loading-state card"><div class="spinner"></div><span>Buscando pedidos...</span></div>`;
  } else if (S.searchResults !== null) {
    const res = S.searchResults;
    if (res.length === 0) {
      resultsHtml = `<div class="empty-state card"><p>Nenhum resultado encontrado para a busca realizada.</p></div>`;
    } else {
      const rows = res.map(r => `
        <tr>
          <td>${esc(r.login_cliente || '-')}</td>
          <td class="mono">${esc(r.numero_venda || '-')}</td>
          <td class="user-name">${esc(getDisplayName(r))}</td>
          <td class="user-email-cell">${esc(r.owner_email || '-')}</td>
          <td style="white-space:nowrap">${fmtDate(r.selected_at)}</td>
          <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" class="link-btn">Abrir</a>` : '-'}</td>
        </tr>`).join('');

      resultsHtml = `
<div class="card">
  <div class="table-header"><span class="result-count">${res.length} resultado${res.length !== 1 ? 's' : ''}</span></div>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Login Cliente</th>
          <th>Número da Venda</th>
          <th>Responsável</th>
          <th>E-mail</th>
          <th>Data / Hora</th>
          <th>Link</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
    }
  }

  return `
<div class="page-header">
  <h1>Busca de Pedidos</h1>
  <p>Pesquise por login do cliente ou número da venda</p>
</div>
<div class="search-form card">
  <div class="search-fields">
    <div class="field">
      <label for="sl">Login do cliente</label>
      <input type="text" id="sl" placeholder="ex: comprador123" value="${esc(S.searchLogin)}"/>
    </div>
    <div class="search-divider">ou</div>
    <div class="field">
      <label for="ss">Número da venda</label>
      <input type="text" id="ss" placeholder="ex: 2000006123456789" value="${esc(S.searchSale)}"/>
    </div>
    <button class="btn-primary" id="searchBtn" ${S.searchLoading ? 'disabled' : ''}>
      ${S.searchLoading ? `<span class="spinner-sm"></span>&nbsp;Buscando...` : `${ICON.search}&nbsp;Buscar`}
    </button>
  </div>
  ${S.searchError ? `<div class="error-msg mt-12">${esc(S.searchError)}</div>` : ''}
</div>
${resultsHtml}`;
}

/* --- Dashboard view --- */
function htmlDashboard() {
  // Month picker options (last 12 months)
  const now = new Date();
  const monthOpts = Array.from({ length: 12 }, (_, i) => {
    const d   = new Date(now.getFullYear(), now.getMonth() - i - 1, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const lbl = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const sel = (S.customFrom && S.customFrom.getFullYear() === d.getFullYear() && S.customFrom.getMonth() === d.getMonth()) ? 'selected' : '';
    return `<option value="${val}" ${sel}>${lbl.charAt(0).toUpperCase()}${lbl.slice(1)}</option>`;
  }).join('');

  let bodyHtml = '';

  if (S.dashboardLoading) {
    bodyHtml = `<div class="loading-state card"><div class="spinner"></div><span>Carregando dados...</span></div>`;
  } else if (S.dashboardError) {
    bodyHtml = `<div class="error-msg">${esc(S.dashboardError)}</div>`;
  } else if (S.dashboardData !== null) {
    const data     = S.dashboardData;
    const total    = data.reduce((s, r) => s + Number(r.order_count), 0);
    const maxCount = data.length ? Math.max(...data.map(r => Number(r.order_count))) : 1;
    const COLORS   = ['#4f46e5','#06b6d4','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];

    const RANK_COLORS = ['#f59e0b','#94a3b8','#b45309'];
    const tableRows = data.map((r, i) => {
      const count    = Number(r.order_count);
      const barPct   = maxCount > 0 ? (count / maxCount * 100).toFixed(1) : '0';
      const totalPct = total > 0 ? (count / total * 100).toFixed(1) : '0';
      const name     = r.display_name || r.owner_email || 'Desconhecido';
      const color    = COLORS[i % COLORS.length];
      const rankClr  = RANK_COLORS[i] || 'var(--text-muted)';
      const initials = name.split(/[\s@._-]+/).slice(0,2).map(w => w[0]?.toUpperCase() || '').join('') || '?';
      return `
        <tr>
          <td class="rank" style="color:${rankClr}">${i + 1}</td>
          <td class="avatar-cell"><span class="tbl-avatar" style="background:${color}22;color:${color};border-color:${color}55">${esc(initials)}</span></td>
          <td class="user-name">${esc(name)}</td>
          <td class="user-email-cell">${esc(r.owner_email || '-')}</td>
          <td class="count-cell">
            <div class="count-top">
              <span class="count-lbl">qtd</span>
              <span class="count-num">${count}</span>
            </div>
            <div class="count-bar-row">
              <div class="count-bar-outer">
                <div class="count-bar" style="width:${barPct}%;background:${color}"></div>
              </div>
              <span class="count-pct">${totalPct}%</span>
            </div>
          </td>
        </tr>`;
    }).join('');

    const tableHtml = data.length === 0
      ? `<div class="empty-state card"><p>Nenhum pedido encontrado no período selecionado.</p></div>`
      : `<div class="card">
           <div class="table-wrap">
             <table class="data-table">
               <thead><tr><th>#</th><th></th><th>Nome</th><th>E-mail</th><th>Pedidos Capturados</th></tr></thead>
               <tbody>${tableRows}</tbody>
             </table>
           </div>
         </div>`;

    const chartItems = data.slice(0, 10).map((r, i) => {
      const count = Number(r.order_count);
      const pct   = total > 0 ? (count / total * 100).toFixed(1) : '0';
      const name  = (r.display_name || r.owner_email || '?').split('@')[0];
      return `
        <div class="chart-item">
          <div class="chart-label">${esc(name)}</div>
          <div class="chart-bar-outer">
            <div class="chart-bar-inner" style="width:${pct}%;background:${COLORS[i % COLORS.length]}"></div>
          </div>
          <div class="chart-pct">${pct}%</div>
        </div>`;
    }).join('');

    bodyHtml = `
<div class="stats-summary">
  <div class="stat-card">
    <div class="stat-label">Período</div>
    <div class="stat-value-sm">${esc(fmtPeriodLabel())}</div>
  </div>
  <div class="stat-card accent">
    <div class="stat-label">Total de Pedidos</div>
    <div class="stat-value">${total}</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Usuários Ativos</div>
    <div class="stat-value">${data.length}</div>
  </div>
</div>
${tableHtml}
${data.length > 0 && total > 0 ? `
<div class="card">
  <h3 class="card-title">Distribuição de Pedidos</h3>
  <div class="chart">${chartItems}</div>
</div>` : ''}`;
  }

  return `
<div class="page-header">
  <h1>Dashboard</h1>
  <p>Pedidos capturados por usuário no período selecionado</p>
</div>
<div class="period-selector card">
  <div class="period-btns">
    <button class="period-btn ${S.period === 'today'  ? 'active' : ''}" data-period="today">Hoje</button>
    <button class="period-btn ${S.period === 'week'   ? 'active' : ''}" data-period="week">Esta Semana</button>
    <button class="period-btn ${S.period === 'month'  ? 'active' : ''}" data-period="month">Este Mês</button>
    <button class="period-btn ${S.period === 'custom' ? 'active' : ''}" data-period="custom">Mês Anterior</button>
  </div>
  ${S.period === 'custom' ? `
  <div class="custom-period">
    <label>Mês:</label>
    <select id="monthPicker">${monthOpts}</select>
  </div>` : ''}
</div>
${bodyHtml}`;
}

/* ─── BIND EVENTS ─────────────────────────────────────────────────────── */
function bindAll() {
  if (S.view === 'login') {
    document.getElementById('loginForm')?.addEventListener('submit', onLoginSubmit);
    return;
  }

  document.getElementById('logoutBtn')?.addEventListener('click', signOut);

  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (S.view !== btn.dataset.view) {
        S.view = btn.dataset.view;
        render();
      }
    });
  });

  if (S.view === 'search') {
    document.getElementById('searchBtn')?.addEventListener('click', onSearch);
    ['sl', 'ss'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') onSearch(); });
    });
  }

  if (S.view === 'dashboard') {
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => onPeriodChange(btn.dataset.period));
    });
    document.getElementById('monthPicker')?.addEventListener('change', onMonthChange);
  }
}

/* ─── HANDLERS ────────────────────────────────────────────────────────── */
async function onLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('em').value.trim();
  const pw    = document.getElementById('pw').value;

  S.loginError   = null;
  S.loginLoading = true;
  render();

  try {
    const data = await signIn(email, pw);
    const userEmail = data.user?.email || '';

    if (!CFG.allowed.includes(userEmail)) {
      // Sign out the Supabase session immediately
      fetch(`${CFG.url}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: CFG.key, Authorization: `Bearer ${data.access_token}` }
      }).catch(() => {});
      throw new Error('Acesso negado. Este e-mail não tem permissão para usar o Painel Sentinela.');
    }

    saveSession(data);
    await loadProfiles();
    S.view         = 'dashboard';
    S.loginLoading = false;
    render();
    await loadDashboard();
    render();
  } catch (err) {
    S.loginError   = err.message;
    S.loginLoading = false;
    render();
  }
}

async function onSearch() {
  if (S.searchLoading) return;

  S.searchLogin = document.getElementById('sl')?.value.trim() || '';
  S.searchSale  = document.getElementById('ss')?.value.trim() || '';

  if (!S.searchLogin && !S.searchSale) {
    S.searchError   = 'Informe o login do cliente ou o número da venda para buscar.';
    S.searchResults = null;
    render();
    return;
  }

  S.searchError   = null;
  S.searchResults = null;
  S.searchLoading = true;
  render();

  try {
    S.searchResults = await apiSearch(S.searchLogin, S.searchSale);
  } catch (err) {
    S.searchError = err.message;
  } finally {
    S.searchLoading = false;
  }
  render();
}

async function onPeriodChange(period) {
  if (S.period === period && !S.dashboardData && !S.dashboardLoading) {
    // Just refresh
  } else if (S.period === period && period !== 'custom') {
    return;
  }

  S.period = period;

  if (period === 'custom' && !S.customFrom) {
    const now  = new Date();
    S.customFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    S.customTo   = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  S.dashboardData    = null;
  S.dashboardLoading = true;
  S.dashboardError   = null;
  render();

  await loadDashboard();
  render();
}

async function onMonthChange(e) {
  const [year, month] = e.target.value.split('-').map(Number);
  S.customFrom = new Date(year, month - 1, 1);
  S.customTo   = new Date(year, month, 1);

  S.dashboardData    = null;
  S.dashboardLoading = true;
  render();

  await loadDashboard();
  render();
}

async function loadDashboard() {
  const { from, to } = getPeriodRange();
  S.dashboardLoading = true;
  S.dashboardError   = null;
  try {
    S.dashboardData = await apiDashboard(from, to);
  } catch (err) {
    S.dashboardError = err.message;
    S.dashboardData  = null;
  } finally {
    S.dashboardLoading = false;
  }
}

/* ─── INIT ────────────────────────────────────────────────────────────── */
async function init() {
  const stored = loadStoredSession();

  if (!stored) {
    S.view = 'login';
    render();
    return;
  }

  S.auth = stored;

  // Try to get a fresh token
  const refreshed = await tryRefresh(stored);
  if (refreshed) {
    saveSession(refreshed);
  }

  // Verify email is still allowed
  const email = S.auth?.user?.email || '';
  if (!CFG.allowed.includes(email)) {
    localStorage.removeItem(CFG.sk);
    S.auth = null;
    S.view = 'login';
    render();
    return;
  }

  S.view = 'dashboard';
  render(); // Show shell immediately while data loads

  await loadProfiles();
  await loadDashboard();
  render();
}

init();
