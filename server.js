/*
  Baram Cloud Data Relay Server V10.72
  - Browser HTML connects to wss://YOUR-CLOUD-DOMAIN/ws
  - BTC uses Binance WebSocket + REST klines/depth.
  - Nasdaq, Gold, Silver, Oil, Hang Seng use Yahoo Chart REST from the local server and push updates by WebSocket.
  - No fake candles: if a provider has no bar, the server sends an error/status instead of fabricating OHLC.
*/
const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || process.env.BARAM_RELAY_PORT || 8787);

const SYMBOLS = {
  BTCUSDT: { label: 'BTC/USDT', provider: 'binance', binance: 'BTCUSDT', tick: 0.01, tickValue: 0.01, decimals: 2, base: 65000 },
  NQ:     { label: '나스닥', provider: 'yahoo', yahoo: 'NQ=F', tick: 0.25, tickValue: 5, decimals: 2, base: 22000 },
  GOLD:   { label: '금', provider: 'yahoo', yahoo: 'GC=F', tick: 0.1, tickValue: 10, decimals: 1, base: 2400 },
  SILVER: { label: '은', provider: 'yahoo', yahoo: 'SI=F', tick: 0.005, tickValue: 25, decimals: 3, base: 30 },
  OIL:    { label: '오일', provider: 'yahoo', yahoo: 'CL=F', tick: 0.01, tickValue: 10, decimals: 2, base: 75 },
  HSI:    { label: '항셍', provider: 'yahoo', yahoo: '^HSI', tick: 1, tickValue: 6.4, decimals: 0, base: 18000 }
};

function nowIso(){ return new Date().toISOString(); }
function num(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function send(ws, obj){ if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function safeLabel(sym){ return (SYMBOLS[sym] && SYMBOLS[sym].label) || sym; }
function validBar(b){
  return b && Number.isFinite(b.t) && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0 && b.h >= Math.max(b.o,b.c) && b.l <= Math.min(b.o,b.c);
}
function sanitizeBar(b){
  if(!b) return null;
  const x = { t:num(b.t), o:num(b.o), h:num(b.h), l:num(b.l), c:num(b.c), v:num(b.v) };
  if(x.o <= 0 || x.h <= 0 || x.l <= 0 || x.c <= 0) return null;
  x.h = Math.max(x.h, x.o, x.c);
  x.l = Math.min(x.l, x.o, x.c);
  return validBar(x) ? x : null;
}
function bucketOf(t, tfMs, year){
  if(year){ const d = new Date(t); return Date.UTC(d.getUTCFullYear(),0,1); }
  return Math.floor(Number(t) / tfMs) * tfMs;
}
function aggregateBars(raw, tfSec, customYear=false){
  const tfMs = tfSec * 1000;
  const sorted = raw.map(sanitizeBar).filter(Boolean).sort((a,b)=>a.t-b.t);
  const out = [];
  let key = null, g = null;
  for(const b of sorted){
    const k = bucketOf(b.t, tfMs, customYear);
    if(key === null || k !== key){
      if(g) out.push(g);
      key = k;
      g = { t:k, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v };
    }else{
      g.h = Math.max(g.h, b.h);
      g.l = Math.min(g.l, b.l);
      g.c = b.c;
      g.v += num(b.v);
    }
  }
  if(g) out.push(g);
  return out;
}
function binanceRule(tfSec){
  switch(Number(tfSec)||60){
    case 60: return {base:'1m', custom:false, limit:300};
    case 180: return {base:'3m', custom:false, limit:300};
    case 300: return {base:'5m', custom:false, limit:300};
    case 600: return {base:'1m', custom:true, tfSec:600, limit:1200};
    case 900: return {base:'15m', custom:false, limit:300};
    case 1800: return {base:'30m', custom:false, limit:300};
    case 3600: return {base:'1h', custom:false, limit:300};
    case 5400: return {base:'30m', custom:true, tfSec:5400, limit:1200};
    case 14400: return {base:'4h', custom:false, limit:300};
    case 86400: return {base:'1d', custom:false, limit:300};
    case 604800: return {base:'1w', custom:false, limit:300};
    case 2592000: return {base:'1M', custom:false, limit:300};
    case 31536000: return {base:'1M', custom:true, tfSec:31536000, year:true, limit:1200};
    default: return {base:'1m', custom:false, limit:300};
  }
}
function yahooRule(tfSec){
  switch(Number(tfSec)||60){
    case 60: return {interval:'1m', range:'5d', custom:false, poll:7000};
    case 180: return {interval:'1m', range:'5d', custom:true, tfSec:180, poll:9000};
    case 300: return {interval:'5m', range:'5d', custom:false, poll:12000};
    case 600: return {interval:'5m', range:'5d', custom:true, tfSec:600, poll:14000};
    case 900: return {interval:'15m', range:'5d', custom:false, poll:16000};
    case 1800: return {interval:'30m', range:'1mo', custom:false, poll:22000};
    case 3600: return {interval:'60m', range:'1mo', custom:false, poll:30000};
    case 5400: return {interval:'90m', range:'1mo', custom:false, poll:35000};
    case 14400: return {interval:'60m', range:'3mo', custom:true, tfSec:14400, poll:45000};
    case 86400: return {interval:'1d', range:'1y', custom:false, poll:120000};
    case 604800: return {interval:'1wk', range:'5y', custom:false, poll:240000};
    case 2592000: return {interval:'1mo', range:'10y', custom:false, poll:300000};
    case 31536000: return {interval:'1mo', range:'10y', custom:true, tfSec:31536000, year:true, poll:300000};
    default: return {interval:'1m', range:'5d', custom:false, poll:9000};
  }
}
async function fetchJson(url){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 12000);
  try{
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 BaramRelay/10.67' } });
    if(!res.ok) throw new Error('HTTP '+res.status+' '+res.statusText);
    return await res.json();
  }finally{ clearTimeout(t); }
}
function binanceKlineToBar(k){ return sanitizeBar({ t:num(k[0]), o:num(k[1]), h:num(k[2]), l:num(k[3]), c:num(k[4]), v:num(k[5]) }); }
async function fetchBinanceSnapshot(tfSec){
  const rule = binanceRule(tfSec);
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${encodeURIComponent(rule.base)}&limit=${encodeURIComponent(rule.limit)}`;
  const raw = await fetchJson(url);
  let arr = Array.isArray(raw) ? raw.map(binanceKlineToBar).filter(Boolean) : [];
  if(rule.custom) arr = aggregateBars(arr, rule.tfSec, !!rule.year);
  if(!arr.length) throw new Error('Binance empty klines');
  return arr.slice(-300);
}
async function fetchBinanceDepth(){
  const raw = await fetchJson('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20');
  if(!raw || !Array.isArray(raw.asks) || !Array.isArray(raw.bids)) return null;
  return { type:'depth', asks:raw.asks, bids:raw.bids };
}
function yahooRowsToBars(result){
  const ts = result && result.timestamp;
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  if(!Array.isArray(ts) || !quote) return [];
  const out = [];
  for(let i=0;i<ts.length;i++){
    const b = sanitizeBar({
      t:num(ts[i])*1000,
      o:num(quote.open && quote.open[i]),
      h:num(quote.high && quote.high[i]),
      l:num(quote.low && quote.low[i]),
      c:num(quote.close && quote.close[i]),
      v:num(quote.volume && quote.volume[i])
    });
    if(b) out.push(b);
  }
  return out;
}
async function fetchYahooSnapshot(symbol, tfSec){
  const cfg = SYMBOLS[symbol];
  const rule = yahooRule(tfSec);
  const ysym = encodeURIComponent(cfg.yahoo);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ysym}?interval=${encodeURIComponent(rule.interval)}&range=${encodeURIComponent(rule.range)}&includePrePost=true&events=div%7Csplits`;
  const json = await fetchJson(url);
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if(!result) throw new Error('Yahoo empty result');
  let arr = yahooRowsToBars(result);
  if(rule.custom) arr = aggregateBars(arr, rule.tfSec, !!rule.year);
  arr = arr.filter(validBar).sort((a,b)=>a.t-b.t).slice(-300);
  if(!arr.length) throw new Error('Yahoo empty bars');
  return arr;
}
function sendSnapshot(ws, symbol, arr){
  const cfg = SYMBOLS[symbol];
  const bars = arr.slice(0, -1);
  const current = arr[arr.length-1] || null;
  send(ws, { type:'meta', symbol, label:cfg.label, tick:cfg.tick, tickValue:cfg.tickValue, decimals:cfg.decimals, name:cfg.name || cfg.label });
  send(ws, { type:'snapshot', symbol, label:cfg.label, bars, current, ts:Date.now() });
}
class ClientFeed {
  constructor(ws){
    this.ws = ws;
    this.symbol = 'BTCUSDT';
    this.tf = 60;
    this.timer = null;
    this.binanceWs = null;
    this.depthTimer = null;
    this.lastBarKey = null;
  }
  stop(){
    if(this.timer) clearInterval(this.timer); this.timer = null;
    if(this.depthTimer) clearInterval(this.depthTimer); this.depthTimer = null;
    if(this.binanceWs){ try{this.binanceWs.close();}catch(e){} } this.binanceWs = null;
  }
  async subscribe(symbol, tf){
    symbol = String(symbol || 'BTCUSDT').toUpperCase();
    if(!SYMBOLS[symbol]) symbol = 'BTCUSDT';
    this.stop();
    this.symbol = symbol;
    this.tf = Math.max(60, num(tf, 60));
    const cfg = SYMBOLS[symbol];
    send(this.ws, { type:'status', level:'wait', message:`${cfg.label} ${this.tf}초 연결중` });
    if(cfg.provider === 'binance') await this.startBinance();
    else await this.startYahoo();
  }
  async startBinance(){
    const cfg = SYMBOLS[this.symbol];
    const tf = this.tf;
    try{
      const arr = await fetchBinanceSnapshot(tf);
      sendSnapshot(this.ws, this.symbol, arr);
      send(this.ws, { type:'status', level:'relay', message:`${cfg.label} Binance 캔들 수신` });
    }catch(e){
      send(this.ws, { type:'error', message:`${cfg.label} Binance REST 실패: ${e.message}` });
    }
    try{
      const d = await fetchBinanceDepth(); if(d) send(this.ws, d);
    }catch(e){}
    this.depthTimer = setInterval(async()=>{
      try{ const d = await fetchBinanceDepth(); if(d) send(this.ws, d); }catch(e){}
    }, 5000);
    const rule = binanceRule(tf);
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@kline_${rule.base}/btcusdt@depth20@1000ms`;
    this.binanceWs = new WebSocket(wsUrl);
    this.binanceWs.on('open', ()=>send(this.ws, { type:'status', level:'relay', message:`${cfg.label} Binance WS 연결` }));
    this.binanceWs.on('message', (buf)=>{
      let raw; try{raw = JSON.parse(String(buf));}catch(e){return;}
      const m = raw && raw.data ? raw.data : raw;
      if(!m) return;
      if(m.e === 'trade'){
        send(this.ws, { type:'tick', symbol:this.symbol, price:num(m.p), ts:num(m.T, Date.now()) });
      }else if(m.e === 'kline' && m.k){
        if(rule.custom){
          if(m.k.x) this.refreshSnapshot('closed custom kline');
          else send(this.ws, { type:'tick', symbol:this.symbol, price:num(m.k.c), ts:num(m.k.t, Date.now()) });
        }else{
          const b = sanitizeBar({t:num(m.k.t), o:num(m.k.o), h:num(m.k.h), l:num(m.k.l), c:num(m.k.c), v:num(m.k.v)});
          if(b) send(this.ws, { type:'bar', symbol:this.symbol, bar:b, closed:!!m.k.x });
        }
      }else if(Array.isArray(m.asks) && Array.isArray(m.bids)){
        send(this.ws, { type:'depth', asks:m.asks, bids:m.bids });
      }
    });
    this.binanceWs.on('close', ()=>{
      if(this.ws.readyState === WebSocket.OPEN && this.symbol === 'BTCUSDT'){
        send(this.ws, { type:'status', level:'err', message:`${cfg.label} Binance WS 재연결중` });
        setTimeout(()=>{ if(this.ws.readyState === WebSocket.OPEN && this.symbol === 'BTCUSDT') this.startBinance().catch(()=>{}); }, 2500);
      }
    });
    this.binanceWs.on('error', ()=>send(this.ws, { type:'status', level:'err', message:`${cfg.label} Binance WS 오류` }));
    this.timer = setInterval(()=>this.refreshSnapshot('periodic'), 30000);
  }
  async refreshSnapshot(reason){
    try{
      const cfg = SYMBOLS[this.symbol];
      const arr = cfg.provider === 'binance' ? await fetchBinanceSnapshot(this.tf) : await fetchYahooSnapshot(this.symbol, this.tf);
      sendSnapshot(this.ws, this.symbol, arr);
    }catch(e){
      send(this.ws, { type:'status', level:'err', message:`${safeLabel(this.symbol)} 보조수신 실패: ${e.message}` });
    }
  }
  async startYahoo(){
    const cfg = SYMBOLS[this.symbol];
    const rule = yahooRule(this.tf);
    const poll = Math.max(6000, rule.poll || 15000);
    const pull = async()=>{
      try{
        const arr = await fetchYahooSnapshot(this.symbol, this.tf);
        sendSnapshot(this.ws, this.symbol, arr);
        send(this.ws, { type:'status', level:'relay', message:`${cfg.label} Yahoo 중계 수신 · 지연 가능` });
      }catch(e){
        send(this.ws, { type:'error', message:`${cfg.label} Yahoo 수신 실패: ${e.message}` });
      }
    };
    await pull();
    this.timer = setInterval(pull, poll);
  }
}

const server = http.createServer((req, res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  const host = req.headers.host || ('localhost:'+PORT);
  const proto = String(req.headers['x-forwarded-proto'] || '').includes('https') ? 'wss' : 'ws';
  const wsUrl = proto + '://' + host + '/ws';
  if(req.url === '/status'){
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({ok:true, name:'Baram Cloud Data Relay', version:'10.72', time:nowIso(), ws:'/ws', wsUrl, symbols:Object.keys(SYMBOLS)}));
    return;
  }
  if(req.url === '/'){
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baram Data Relay</title><style>body{margin:0;background:#05070b;color:#e8eef7;font-family:Arial,'Noto Sans KR',sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}.box{width:min(680px,92vw);background:#0e141d;border:1px solid rgba(215,173,95,.45);border-radius:20px;padding:26px;box-shadow:0 20px 70px rgba(0,0,0,.55)}h1{color:#d7ad5f;margin:0 0 10px}.url{background:#070b11;border:1px solid #2b3848;border-radius:12px;padding:14px;font-size:18px;font-weight:900;word-break:break-all;color:#42e5c8}.small{color:#aeb8c8;line-height:1.6}.ok{color:#6cff36;font-weight:900}</style></head><body><div class="box"><h1>Baram 데이터 서버 작동중</h1><p class="small"><span class="ok">정상입니다.</span> 아래 주소를 바람 화면의 <b>서버연결</b> 창에 붙여넣으세요.</p><div class="url">${wsUrl}</div><p class="small">BTC / 나스닥 / 금 / 은 / 오일 / 항셍 중계 준비 완료 · 가짜 캔들 생성 없음</p></div></body></html>`);
    return;
  }
  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('Baram cloud relay server is running. WebSocket path: /ws');
});
const wss = new WebSocket.Server({ server, path:'/ws' });
wss.on('connection', (ws)=>{
  const feed = new ClientFeed(ws);
  send(ws, { type:'hello', name:'Baram Cloud Data Relay', version:'10.72', ts:Date.now() });
  ws.on('message', async(buf)=>{
    let msg; try{ msg = JSON.parse(String(buf)); }catch(e){ send(ws,{type:'error', message:'잘못된 메시지'}); return; }
    if(msg.type === 'subscribe'){
      try{ await feed.subscribe(msg.symbol, msg.tf); }
      catch(e){ send(ws,{type:'error', message:'구독 실패: '+e.message}); }
    }
  });
  ws.on('close', ()=>feed.stop());
  ws.on('error', ()=>feed.stop());
});
server.listen(PORT, '0.0.0.0', ()=>{
  console.log('============================================================');
  console.log(' Baram Cloud Data Relay Server V10.72');
  console.log(' 실행 주소: ws://0.0.0.0:'+PORT+'/ws');
  console.log(' 상태 확인: /status');
  console.log(' BTC=Binance WebSocket, 나스닥/금/은/오일/항셍=Yahoo 중계');
  console.log(' 가짜 캔들 생성 없음. 수신 실패 시 오류만 표시.');
  console.log('============================================================');
});
