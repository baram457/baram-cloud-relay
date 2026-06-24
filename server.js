import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const DEMO = String(process.env.CAPITAL_DEMO || 'true').toLowerCase() !== 'false';
const BASE = (process.env.CAPITAL_BASE_URL || (DEMO
  ? 'https://demo-api-capital.backend-capital.com'
  : 'https://api-capital.backend-capital.com')).replace(/\/+$/, '');
const API_BASE = BASE + '/api/v1';

const API_KEY = process.env.CAPITAL_API_KEY || '';
const IDENTIFIER = process.env.CAPITAL_IDENTIFIER || '';
const PASSWORD = process.env.CAPITAL_PASSWORD || '';

let session = { cst: '', securityToken: '', expiresAt: 0, createdAt: 0 };
let loginInFlight = null;
const epicCache = new Map();
const quoteCache = new Map();
const candleCache = new Map();

const LABELS = {
  NQ: 'US Tech 100',
  GOLD: 'Gold',
  SILVER: 'Silver',
  OIL: 'Crude Oil',
  HSI: 'Hong Kong 50',
  BTC: 'Bitcoin'
};

const SEARCH_TERMS = {
  NQ: ['US Tech 100', 'US Tech', 'Nasdaq', 'NASDAQ 100', 'US100'],
  GOLD: ['Gold'],
  SILVER: ['Silver'],
  OIL: ['Oil Crude', 'Crude Oil', 'Oil'],
  HSI: ['Hong Kong 50', 'Hong Kong', 'HSI', 'Hang Seng'],
  BTC: ['Bitcoin', 'Bitcoin/USD', 'BTC']
};

const ENV_EPICS = {
  NQ: process.env.CAPITAL_EPIC_NQ || '',
  GOLD: process.env.CAPITAL_EPIC_GOLD || '',
  SILVER: process.env.CAPITAL_EPIC_SILVER || '',
  OIL: process.env.CAPITAL_EPIC_OIL || '',
  HSI: process.env.CAPITAL_EPIC_HSI || '',
  BTC: process.env.CAPITAL_EPIC_BTC || ''
};

function needCreds() {
  return Boolean(API_KEY && IDENTIFIER && PASSWORD);
}

function jsonError(res, status, message, extra = {}) {
  res.status(status).json({ ok: false, error: message, ...extra, ts: Date.now() });
}

async function capitalFetch(path, { method = 'GET', query = null, body = null, auth = true, retry = true } = {}) {
  if (auth) await ensureSession();
  const url = new URL(API_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    headers.CST = session.cst;
    headers['X-SECURITY-TOKEN'] = session.securityToken;
  }
  if (!auth && path === '/session') {
    headers['Content-Type'] = 'application/json';
    headers['X-CAP-API-KEY'] = API_KEY;
  }
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    if (auth && retry && (r.status === 401 || r.status === 403)) {
      session.expiresAt = 0;
      await ensureSession(true);
      return capitalFetch(path, { method, query, body, auth, retry: false });
    }
    const msg = data?.errorCode || data?.error || data?.message || text || ('Capital HTTP ' + r.status);
    throw new Error(msg);
  }
  return { data, headers: r.headers };
}

async function login() {
  if (!needCreds()) {
    throw new Error('Render Environment Variables에 CAPITAL_API_KEY / CAPITAL_IDENTIFIER / CAPITAL_PASSWORD가 필요합니다.');
  }
  const r = await fetch(API_BASE + '/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-CAP-API-KEY': API_KEY
    },
    body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD, encryptedPassword: false })
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.errorCode || data?.error || data?.message || text || ('Session HTTP ' + r.status);
    throw new Error('Capital session 실패: ' + msg);
  }
  const cst = r.headers.get('CST') || r.headers.get('cst') || '';
  const securityToken = r.headers.get('X-SECURITY-TOKEN') || r.headers.get('x-security-token') || '';
  if (!cst || !securityToken) throw new Error('Capital session 토큰 누락');
  session = { cst, securityToken, createdAt: Date.now(), expiresAt: Date.now() + 8 * 60 * 1000 };
  return session;
}

async function ensureSession(force = false) {
  if (!force && session.cst && session.securityToken && Date.now() < session.expiresAt) return session;
  if (!loginInFlight) loginInFlight = login().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

function midObj(obj) {
  if (!obj) return NaN;
  const bid = Number(obj.bid);
  const ask = Number(obj.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  if (Number.isFinite(bid)) return bid;
  if (Number.isFinite(ask)) return ask;
  return NaN;
}

function parseTime(v) {
  if (!v) return NaN;
  const s = String(v).replace(' ', 'T') + (String(v).endsWith('Z') ? '' : 'Z');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function validBar(b) {
  return b && Number.isFinite(b.t) && Number.isFinite(b.o) && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c)
    && b.o > 0 && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c);
}

function toBars(prices = []) {
  const out = [];
  for (const p of prices) {
    const t = parseTime(p.snapshotTimeUTC || p.snapshotTime);
    const b = {
      t,
      o: midObj(p.openPrice),
      h: midObj(p.highPrice),
      l: midObj(p.lowPrice),
      c: midObj(p.closePrice),
      v: Number(p.lastTradedVolume || 0)
    };
    if (validBar(b)) out.push(b);
  }
  return out.sort((a, b) => a.t - b.t);
}

function ruleFor(sec) {
  sec = Number(sec) || 60;
  if (sec <= 60) return { resolution: 'MINUTE', baseSec: 60, mul: 1, maxMul: 1 };
  if (sec === 180) return { resolution: 'MINUTE', baseSec: 60, mul: 3 };
  if (sec === 300) return { resolution: 'MINUTE_5', baseSec: 300, mul: 1 };
  if (sec === 600) return { resolution: 'MINUTE_5', baseSec: 300, mul: 2 };
  if (sec === 900) return { resolution: 'MINUTE_15', baseSec: 900, mul: 1 };
  if (sec === 1800) return { resolution: 'MINUTE_30', baseSec: 1800, mul: 1 };
  if (sec === 3600) return { resolution: 'HOUR', baseSec: 3600, mul: 1 };
  if (sec === 7200) return { resolution: 'HOUR', baseSec: 3600, mul: 2 };
  if (sec === 14400) return { resolution: 'HOUR_4', baseSec: 14400, mul: 1 };
  if (sec === 86400) return { resolution: 'DAY', baseSec: 86400, mul: 1 };
  if (sec === 604800) return { resolution: 'WEEK', baseSec: 604800, mul: 1 };
  if (sec >= 2592000) return { resolution: 'DAY', baseSec: 86400, mul: 30 };
  return { resolution: 'MINUTE', baseSec: 60, mul: Math.max(1, Math.round(sec / 60)) };
}

function bucket(t, sec) {
  return Math.floor(Number(t) / (Number(sec) * 1000)) * Number(sec) * 1000;
}

function aggregate(src, rule, wantedSec) {
  const arr = (src || []).filter(validBar).sort((a, b) => a.t - b.t);
  if (!arr.length) return [];
  if (!rule || rule.mul <= 1) return arr;
  const out = [];
  let g = null;
  let bk = null;
  for (const b of arr) {
    const k = bucket(b.t, wantedSec || (rule.baseSec * rule.mul));
    if (!g || k !== bk) {
      if (g) out.push(g);
      bk = k;
      g = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 };
    } else {
      g.h = Math.max(g.h, b.h);
      g.l = Math.min(g.l, b.l);
      g.c = b.c;
      g.v += b.v || 0;
    }
  }
  if (g) out.push(g);
  return out;
}

function scoreMarket(m, term) {
  const termL = String(term || '').toLowerCase();
  const fields = [m.instrumentName, m.symbol, m.epic, m.instrumentType].map(x => String(x || '').toLowerCase());
  let s = 0;
  if (fields.some(f => f === termL)) s += 100;
  if (fields.some(f => f.includes(termL))) s += 50;
  if (m.streamingPricesAvailable) s += 10;
  if (m.marketStatus === 'TRADEABLE') s += 10;
  if (Number(m.delayTime || 0) === 0) s += 5;
  if (String(m.expiry || '-') === '-') s += 3;
  return s;
}

async function searchMarkets(term) {
  const { data } = await capitalFetch('/markets', { query: { searchTerm: term } });
  return Array.isArray(data.markets) ? data.markets : [];
}

async function resolveEpic(symbol) {
  symbol = String(symbol || '').toUpperCase();
  if (ENV_EPICS[symbol]) return { symbol, epic: ENV_EPICS[symbol], label: LABELS[symbol] || symbol, env: true };
  if (epicCache.has(symbol)) return epicCache.get(symbol);
  const terms = SEARCH_TERMS[symbol] || [symbol];
  let best = null;
  let bestScore = -1;
  for (const term of terms) {
    const markets = await searchMarkets(term);
    for (const m of markets) {
      const sc = scoreMarket(m, term);
      if (sc > bestScore) {
        bestScore = sc;
        best = m;
      }
    }
    if (best && bestScore >= 60) break;
  }
  if (!best || !best.epic) throw new Error(`${symbol} epic 자동검색 실패. Render 환경변수 CAPITAL_EPIC_${symbol}에 직접 epic을 넣어주세요.`);
  const out = { symbol, epic: best.epic, label: best.instrumentName || best.symbol || LABELS[symbol] || symbol, market: best };
  epicCache.set(symbol, out);
  return out;
}


function quoteFromMarket(symbol, ep, m) {
  if (!m) return null;
  const bid = Number(m.bid);
  const ask = Number(m.offer ?? m.ask);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : (Number.isFinite(bid) ? bid : ask);
  if (!Number.isFinite(mid)) return null;
  return {
    symbol: ep.symbol || String(symbol || '').toUpperCase(),
    epic: ep.epic,
    label: ep.label || m.instrumentName || m.symbol || String(symbol || '').toUpperCase(),
    bid,
    ask,
    mid,
    price: mid,
    high: Number(m.high),
    low: Number(m.low),
    percentageChange: Number(m.percentageChange),
    netChange: Number(m.netChange),
    delayTime: Number(m.delayTime || 0),
    marketStatus: m.marketStatus,
    updateTimeUTC: m.updateTimeUTC || m.updateTime,
    ts: Date.now()
  };
}

async function getQuote(symbol) {
  const ep = await resolveEpic(symbol);
  const cacheKey = ep.epic;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 1200) return cached.value;
  let m = null;
  try {
    const { data } = await capitalFetch('/markets', { query: { epics: ep.epic } });
    m = Array.isArray(data.markets) ? data.markets[0] : null;
  } catch {}

  // Capital.com demo can return an empty market list for /markets?epics=US100,
  // even though /markets?searchTerm=US Tech 100 returns a valid live quote.
  // In that case, use the market object already found during epic auto-search.
  let quote = quoteFromMarket(symbol, ep, m) || quoteFromMarket(symbol, ep, ep.market);

  if (!quote) {
    // Last fallback: re-run search terms and pick the exact epic again.
    const terms = SEARCH_TERMS[ep.symbol] || [symbol];
    for (const term of terms) {
      try {
        const markets = await searchMarkets(term);
        const mm = markets.find(x => String(x.epic || '') === String(ep.epic)) || markets[0];
        quote = quoteFromMarket(symbol, ep, mm);
        if (quote) break;
      } catch {}
    }
  }

  if (!quote) throw new Error('quote market empty: ' + ep.epic);
  quoteCache.set(cacheKey, { ts: Date.now(), value: quote });
  return quote;
}

async function getCandles(symbol, tfSec = 60, max = 260) {
  const ep = await resolveEpic(symbol);
  const sec = Number(tfSec) || 60;
  const maxOut = Math.max(10, Math.min(Number(max) || 260, 600));
  const rule = ruleFor(sec);
  const requestMax = Math.min(1000, Math.max(20, maxOut * (rule.mul || 1) + 8));
  const key = `${ep.epic}:${sec}:${maxOut}`;
  const cached = candleCache.get(key);
  const ttl = sec <= 60 ? 4000 : 10000;
  if (cached && Date.now() - cached.ts < ttl) return cached.value;
  const { data } = await capitalFetch('/prices/' + encodeURIComponent(ep.epic), {
    query: { resolution: rule.resolution, max: requestMax }
  });
  let bars = toBars(data.prices || []);
  bars = aggregate(bars, rule, sec).slice(-maxOut);
  if (!bars.length) throw new Error('Capital prices empty: ' + ep.epic + ' ' + rule.resolution);
  let quote = null;
  try { quote = await getQuote(symbol); } catch {}
  const value = { symbol, epic: ep.epic, label: ep.label, resolution: rule.resolution, tfSec: sec, bars, quote, serverTime: Date.now() };
  candleCache.set(key, { ts: Date.now(), value });
  return value;
}

app.get('/', (_req, res) => {
  res.type('text/plain').send('Baram V10.78 Capital.com Demo Relay OK\n' + new Date().toISOString());
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'baram-capital-demo-relay', version: '10.78Q', demo: DEMO, base: BASE, hasCredentials: needCreds(), sessionActive: Boolean(session.cst && Date.now() < session.expiresAt), ts: Date.now() });
});

app.get('/api/capital/status', async (_req, res) => {
  try {
    await ensureSession();
    res.json({ ok: true, demo: DEMO, base: BASE, sessionActive: true, expiresInMs: Math.max(0, session.expiresAt - Date.now()), ts: Date.now() });
  } catch (e) { jsonError(res, 500, e.message || String(e)); }
});

app.get('/api/capital/search', async (req, res) => {
  try {
    const term = String(req.query.term || req.query.searchTerm || '').trim();
    if (!term) return jsonError(res, 400, 'term 필요');
    const markets = await searchMarkets(term);
    res.json({ ok: true, term, markets, ts: Date.now() });
  } catch (e) { jsonError(res, 500, e.message || String(e)); }
});

app.get('/api/capital/epics', async (_req, res) => {
  try {
    const out = {};
    for (const s of Object.keys(SEARCH_TERMS)) {
      try { out[s] = await resolveEpic(s); } catch (e) { out[s] = { error: e.message || String(e) }; }
    }
    res.json({ ok: true, epics: out, ts: Date.now() });
  } catch (e) { jsonError(res, 500, e.message || String(e)); }
});

app.get('/api/capital/quote', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'NQ').toUpperCase();
    const quote = await getQuote(symbol);
    res.json({ ok: true, quote, ts: Date.now() });
  } catch (e) { jsonError(res, 500, e.message || String(e)); }
});

app.get('/api/capital/candles', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'NQ').toUpperCase();
    const tfSec = Number(req.query.tfSec || 60);
    const max = Number(req.query.max || 260);
    const data = await getCandles(symbol, tfSec, max);
    res.json({ ok: true, ...data, ts: Date.now() });
  } catch (e) { jsonError(res, 500, e.message || String(e)); }
});

app.use((req, res) => jsonError(res, 404, 'not found: ' + req.path));

app.listen(PORT, () => {
  console.log(`Baram V10.78Q Capital.com relay running on :${PORT}`);
  console.log(`BASE=${BASE} DEMO=${DEMO} CREDENTIALS=${needCreds() ? 'YES' : 'NO'}`);
});
