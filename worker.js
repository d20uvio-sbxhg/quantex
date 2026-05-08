// QUANTEX Pro - Cloudflare Worker (含雲端 ML + 雲端備份 + API Key 認證 v2.2)
// 代理台灣證交所 + Yahoo Finance API,解決 CORS 問題
// + 雲端 ML 引擎(Random Forest)
// + 雲端自動備份(OOS / AutoBT / Paper Track)
// + v2.2: API Key 認證(env.ML_KEY)
// + v2.3: 跨裝置 OOS 同步(/oos/push, /oos/pull, /oos/list_users)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
};

const ML_KV_KEY = 'quantex_ml_model_v1';
const OOS_SHARED_KEY = 'quantex_oos_shared_v1';
const DEVICES_KEY = 'quantex_devices_v1';

// 備份的 KV key 命名
const SYNC_KEYS = {
  oos:        'quantex_sync_oos_v1',
  autobt:     'quantex_sync_autobt_v1',
  papertrack: 'quantex_sync_papertrack_v1',
};

// v2.3: 跨裝置 OOS 同步 KV key prefix
const OOS_USER_PREFIX = 'oos_user:';        // oos_user:u-ABC123 → 該裝置的 OOS data
const OOS_USER_META_PREFIX = 'oos_user_meta:'; // 該裝置的 metadata
const OOS_RATE_PREFIX = 'oos_rate:';          // rate limit counter

export default {
  async fetch(request, env) {
    // ════════════════════════════════════════════════════════
    // CORS Preflight (永遠放行,瀏覽器跨域必要)
    // ════════════════════════════════════════════════════════
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    // ════════════════════════════════════════════════════════
    // 公開端點(不需 API Key,方便 debug 與健康檢查)
    // ════════════════════════════════════════════════════════
    if (path === '/health') {
      return jsonResponse({
        status: 'ok',
        version: 'v2.4-with-device-registry',
        time: new Date().toISOString(),
        mlAvailable: !!env.QUANTEX_KV,
        syncAvailable: !!env.QUANTEX_KV,
        oosShareAvailable: !!env.QUANTEX_KV,
        authConfigured: !!env.ML_KEY
      });
    }

    // ════════════════════════════════════════════════════════
    // API Key 認證 (v2.2)
    // 環境變數 ML_KEY 在 Cloudflare Dashboard → Settings → Variables 設定
    // ════════════════════════════════════════════════════════
    if (!env.ML_KEY) {
      return jsonResponse({
        ok: false,
        error: 'Server config error: ML_KEY not set in environment variables'
      }, 500);
    }
    const auth = request.headers.get('Authorization') || '';
    if (auth !== 'Bearer ' + env.ML_KEY) {
      return jsonResponse({
        ok: false,
        error: 'Unauthorized'
      }, 401);
    }

    // ════════════════════════════════════════════════════════
    // 以下為認證通過後的所有路由(原邏輯不動)
    // ════════════════════════════════════════════════════════

    try {
      // ════════════ OOS 跨裝置同步路由 (v2.3) ════════════
      if (path.startsWith('/oos/')) {
        const r = await handleOOS(request, env, path);
        if (r) return r;
      }
      
      // ════════════ Devices 註冊表 (v2.4) ════════════
      if (path.startsWith('/devices/')) {
        const r = await handleDevices(request, env, path);
        if (r) return r;
      }
      
      // ════════════ ML 雲端路由 ════════════
      if (path.startsWith('/ml/')) {
        const r = await handleML(request, env, path);
        if (r) return r;
      }
      
      // ════════════ Sync 雲端備份路由 ════════════
      if (path.startsWith('/sync/')) {
        const r = await handleSync(request, env, path, params);
        if (r) return r;
      }
      
      // ════════════ v2.3: OOS 跨裝置同步路由 ════════════
      if (path.startsWith('/oos/')) {
        const r = await handleOOSSync(request, env, path, params);
        if (r) return r;
      }

      // ── 原有路由 ──
      if (path === '/yahoo') return await proxyYahoo(params);
      if (path === '/twse/institution') return await proxyTWSE_Institution(params);
      if (path === '/twse/margin') return await proxyTWSE_Margin(params);
      if (path === '/twse/pe') return await proxyTWSE_PE(params);
      if (path === '/yahoo-history') return await proxyYahooHistory(params);
      if (path === '/market') return await proxyYahooHistory(params);

      if (path === '/market-cache') {
        const type = params.get('type') || 'tw';
        const symbol = type === 'tw' ? '0050.TW' : 'SPY';
        const fakeParams = new URLSearchParams({symbol});
        const res = await proxyYahooHistory(fakeParams);
        const data = await res.clone().json();
        return new Response(JSON.stringify(data), {
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }
        });
      }

      // v2.5: 國際新聞與情緒(代理 Yahoo Finance RSS,加簡單關鍵字情緒分析)
      if (path === '/news') {
        try {
          const region = params.get('region') || 'us'; // us / tw
          const limit = Math.min(parseInt(params.get('limit') || '15'), 30);
          
          // Yahoo Finance RSS feeds
          const feedUrl = region === 'tw' 
            ? 'https://tw.news.yahoo.com/rss/finance'
            : 'https://feeds.finance.yahoo.com/rss/2.0/headline?region=US&lang=en-US';
          
          const r = await fetch(feedUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantexBot)' },
            cf: { cacheTtl: 600, cacheEverything: true }
          });
          if (!r.ok) return jsonResponse({ error: 'RSS fetch failed', status: r.status }, 502);
          
          const xml = await r.text();
          
          // 簡易 RSS 解析(不依賴 DOMParser,Worker 環境沒有)
          const items = [];
          const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          
          // 情緒關鍵字字典
          const POSITIVE = ['surge','soar','rally','beat','jump','gain','rise','rising','high','strong','bullish','optimistic','上漲','大漲','飆升','利多','創新高','強勢','看好','突破'];
          const NEGATIVE = ['plunge','fall','drop','decline','tumble','crash','slump','weak','bearish','pessimistic','recession','crisis','risk','下跌','大跌','重挫','利空','創新低','弱勢','看壞','跌破','風險','衰退','危機'];
          
          for (let i = 0; i < Math.min(itemMatches.length, limit); i++) {
            const item = itemMatches[i];
            const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
            const linkMatch = item.match(/<link>(.*?)<\/link>/);
            const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
            const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/);
            
            const title = (titleMatch ? (titleMatch[1] || titleMatch[2] || '') : '').trim();
            const link = linkMatch ? linkMatch[1].trim() : '';
            const date = dateMatch ? dateMatch[1].trim() : '';
            const desc = (descMatch ? (descMatch[1] || descMatch[2] || '') : '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
            
            // 情緒打分
            const text = (title + ' ' + desc).toLowerCase();
            let posCount = 0, negCount = 0;
            POSITIVE.forEach(w => { if (text.includes(w.toLowerCase())) posCount++; });
            NEGATIVE.forEach(w => { if (text.includes(w.toLowerCase())) negCount++; });
            const sentiment = posCount > negCount ? 'positive' : negCount > posCount ? 'negative' : 'neutral';
            const sentimentScore = posCount - negCount;
            
            items.push({ title, link, date, desc, sentiment, sentimentScore });
          }
          
          // 整體情緒
          const totalScore = items.reduce((a,b) => a + b.sentimentScore, 0);
          const overallSentiment = totalScore > 2 ? 'positive' : totalScore < -2 ? 'negative' : 'neutral';
          
          return new Response(JSON.stringify({
            region, items, count: items.length,
            overall: { sentiment: overallSentiment, score: totalScore }
          }), {
            headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' }
          });
        } catch (e) {
          return jsonResponse({ error: e.message }, 500);
        }
      }

      if (path === '/fundamentals') {
        const sym2 = params.get('symbol');
        if (!sym2) return jsonResponse({ error: 'symbol required' }, 400);
        try {
          const v10url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym2)}?modules=financialData,defaultKeyStatistics,summaryDetail`;
          const v10res = await fetch(v10url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            cf: { cacheTtl: 86400 }
          });
          if (!v10res.ok) return jsonResponse({ error: 'fetch failed' }, 500);
          const v10data = await v10res.json();
          const fd = v10data?.quoteSummary?.result?.[0]?.financialData;
          const ks = v10data?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
          const sd = v10data?.quoteSummary?.result?.[0]?.summaryDetail;
          return jsonResponse({
            roe: fd?.returnOnEquity?.raw ?? null,
            revenueGrowth: fd?.revenueGrowth?.raw ?? null,
            earningsGrowth: fd?.earningsGrowth?.raw ?? null,
            trailingPE: sd?.trailingPE?.raw ?? null,
            forwardPE: sd?.forwardPE?.raw ?? null,
            priceToBook: ks?.priceToBook?.raw ?? null,
            dividendYield: sd?.dividendYield?.raw ?? null,
          });
        } catch(e) { return jsonResponse({ error: e.message }, 500); }
      }

      if (path === '/twse/holding') {
        try {
          const url = 'https://www.twse.com.tw/fund/MI_QFIIS?response=json&selectType=ALLBUT0999';
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
            cf: { cacheTtl: 86400 }
          });
          const data = await res.json();
          const result = {};
          if (data.data) {
            data.data.forEach(row => {
              const symbol = row[0].trim();
              result[symbol] = {
                foreign_hold_shares: parseInt((row[2]||'0').replace(/,/g,'')) || 0,
                foreign_hold_pct: parseFloat((row[3]||'0').replace(/%/,'')) || 0,
                legal_limit_pct: parseFloat((row[6]||'0').replace(/%/,'')) || 0,
                available_pct: parseFloat((row[7]||'0').replace(/%/,'')) || 0,
              };
            });
          }
          return jsonResponse({ data: result });
        } catch(e) { return jsonResponse({ error: e.message }, 500); }
      }

      if (path === '/twse/trust') {
        try {
          const url = 'https://www.twse.com.tw/fund/TWT43U?response=json&selectType=ALL';
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
            cf: { cacheTtl: 86400 }
          });
          const data = await res.json();
          const result = {};
          if (data.data) {
            data.data.forEach(row => {
              const symbol = row[0].trim();
              result[symbol] = {
                trust_hold_shares: parseInt((row[4]||'0').replace(/,/g,'')) || 0,
                trust_hold_pct: parseFloat((row[5]||'0').replace(/%/,'')) || 0,
              };
            });
          }
          return jsonResponse({ data: result });
        } catch(e) { return jsonResponse({ error: e.message }, 500); }
      }

      if (path === '/twse/inst5d') {
        try {
          const symbol = params.get('symbol');
          if (!symbol) return jsonResponse({ error: 'symbol required' }, 400);
          const dates = [];
          let d = new Date();
          while (dates.length < 5) {
            d.setDate(d.getDate() - 1);
            const day = d.getDay();
            if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
          }
          const results = await Promise.all(dates.map(async (date) => {
            try {
              const url = `https://www.twse.com.tw/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`;
              const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 3600 } });
              const data = await res.json();
              if (!data.data) return null;
              const row = data.data.find(r => r[0].trim() === symbol);
              if (!row) return null;
              return {
                date,
                foreign_net: parseInt((row[4]||'0').replace(/,/g,'')) || 0,
                trust_net: parseInt((row[7]||'0').replace(/,/g,'')) || 0,
                dealer_net: parseInt((row[10]||'0').replace(/,/g,'')) || 0,
              };
            } catch(e) { return null; }
          }));
          return jsonResponse({ data: results.filter(r => r !== null) });
        } catch(e) { return jsonResponse({ error: e.message }, 500); }
      }

      if (path === '/twse/financials') {
        try {
          const url = 'https://www.twse.com.tw/exchangeReport/t163sb04?response=json&selectType=ALL';
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
            cf: { cacheTtl: 86400 }
          });
          const data = await res.json();
          const result = {};
          if (data.data) {
            data.data.forEach(row => {
              const symbol = row[0].trim();
              const roe = parseFloat(row[5]);
              const eps = parseFloat(row[4]);
              const pb  = parseFloat(row[3]);
              result[symbol] = {
                roe: isNaN(roe) ? null : roe / 100,
                eps: isNaN(eps) ? null : eps,
                bookValue: isNaN(pb) ? null : pb,
                debtRatio: parseFloat(row[6]) || null,
              };
            });
          }
          return jsonResponse({ data: result, source: 'TWSE t163sb04', quarter: data.title || '' });
        } catch(e) { return jsonResponse({ error: e.message }, 500); }
      }

      return jsonResponse({ error: 'Unknown endpoint' }, 404);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

// ════════════════════════════════════════════════════════
// OOS 跨裝置同步(v2.3)
// 設計:client 把本地 OOS 整份送來,server 跟雲端版本 merge,回傳合併結果
// merge 規則:hist 陣列以 ts 為 key 取 union,每個 (sym, rk) 上限 200 筆
// ════════════════════════════════════════════════════════

async function handleOOS(request, env, path) {
  if (!env.QUANTEX_KV) {
    return jsonResponse({ ok: false, error: 'KV not bound' }, 500);
  }

  // GET /oos/pull — 純拉(不上傳)
  if (path === '/oos/pull') {
    const data = await env.QUANTEX_KV.get(OOS_SHARED_KEY, { type: 'json' }) || {};
    return jsonResponse({ ok: true, oos: data, totalSamples: countOOSSamples(data) });
  }

  // POST /oos/sync — 雙向同步 (推薦)
  if (path === '/oos/sync' && request.method === 'POST') {
    try {
      const body = await request.json();
      const localOOS = body.oos || {};
      const cloudOOS = await env.QUANTEX_KV.get(OOS_SHARED_KEY, { type: 'json' }) || {};
      const merged = mergeOOS(cloudOOS, localOOS);
      await env.QUANTEX_KV.put(OOS_SHARED_KEY, JSON.stringify(merged));
      return jsonResponse({
        ok: true,
        oos: merged,
        totalSamples: countOOSSamples(merged),
        cloudBefore: countOOSSamples(cloudOOS),
        clientSent: countOOSSamples(localOOS)
      });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // GET /oos/status — 查雲端 OOS 統計
  if (path === '/oos/status') {
    const data = await env.QUANTEX_KV.get(OOS_SHARED_KEY, { type: 'json' }) || {};
    const total = countOOSSamples(data);
    const symCount = Object.keys(data).length;
    return jsonResponse({ ok: true, totalSamples: total, symbols: symCount });
  }

  // DELETE /oos/clear — 清除雲端 OOS
  if (path === '/oos/clear' && (request.method === 'DELETE' || request.method === 'POST')) {
    await env.QUANTEX_KV.delete(OOS_SHARED_KEY);
    return jsonResponse({ ok: true, cleared: true });
  }

  return null;
}

function mergeOOS(a, b) {
  const out = {};
  const allSyms = new Set([
    ...Object.keys(a || {}),
    ...Object.keys(b || {})
  ]);
  allSyms.forEach(sym => {
    const aS = a[sym] || {}, bS = b[sym] || {};
    const allRk = new Set([...Object.keys(aS), ...Object.keys(bS)]);
    out[sym] = {};
    allRk.forEach(rk => {
      const aR = aS[rk] || { hits:0, total:0, hist:[] };
      const bR = bS[rk] || { hits:0, total:0, hist:[] };
      const seen = new Set();
      const histAll = [];
      [...(aR.hist || []), ...(bR.hist || [])].forEach(h => {
        if (!h || h.t == null) return;
        if (!seen.has(h.t)) {
          seen.add(h.t);
          histAll.push(h);
        }
      });
      histAll.sort((x, y) => x.t - y.t);
      const capped = histAll.slice(-200); // 每個 (sym, rk) 最多 200 筆
      out[sym][rk] = {
        hist: capped,
        total: capped.length,
        hits: capped.filter(h => h.c).length
      };
    });
  });
  return out;
}

function countOOSSamples(oos) {
  let n = 0;
  Object.keys(oos || {}).forEach(s => {
    Object.keys(oos[s] || {}).forEach(r => {
      n += ((oos[s][r] && oos[s][r].hist) || []).length;
    });
  });
  return n;
}

// ════════════════════════════════════════════════════════
// Devices Registry (v2.4)
// 雲端共享的裝置註冊表,讓所有裝置看到統一名稱
// 結構: { "id1": {name, ua, lastSeen, createdAt}, ... }
// ════════════════════════════════════════════════════════
async function handleDevices(request, env, path) {
  if (!env.QUANTEX_KV) {
    return jsonResponse({ ok: false, error: 'KV not bound' }, 500);
  }

  // GET /devices/list — 列出所有註冊裝置
  if (path === '/devices/list') {
    const data = await env.QUANTEX_KV.get(DEVICES_KEY, { type: 'json' }) || {};
    return jsonResponse({ ok: true, devices: data });
  }

  // POST /devices/register — 註冊或更新裝置(每次啟動都會打一次)
  // body: { id, name, ua }
  if (path === '/devices/register' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { id, name, ua } = body;
      if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
      
      const data = await env.QUANTEX_KV.get(DEVICES_KEY, { type: 'json' }) || {};
      const existing = data[id] || {};
      data[id] = {
        name: name || existing.name || id,
        ua: ua || existing.ua || '',
        lastSeen: Date.now(),
        createdAt: existing.createdAt || Date.now()
      };
      await env.QUANTEX_KV.put(DEVICES_KEY, JSON.stringify(data));
      return jsonResponse({ ok: true, device: data[id], devices: data });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // POST /devices/rename — 改名稱
  // body: { id, name }
  if (path === '/devices/rename' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { id, name } = body;
      if (!id || !name) return jsonResponse({ ok: false, error: 'id and name required' }, 400);
      
      const data = await env.QUANTEX_KV.get(DEVICES_KEY, { type: 'json' }) || {};
      if (!data[id]) {
        data[id] = { createdAt: Date.now(), ua: '' };
      }
      data[id].name = name;
      data[id].lastSeen = Date.now();
      await env.QUANTEX_KV.put(DEVICES_KEY, JSON.stringify(data));
      return jsonResponse({ ok: true, device: data[id] });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // POST /devices/forget — 從註冊表移除
  // body: { id }
  if ((path === '/devices/forget' || path === '/devices/delete') && (request.method === 'POST' || request.method === 'DELETE')) {
    try {
      let id;
      if (request.method === 'POST') {
        const body = await request.json();
        id = body.id;
      } else {
        const url = new URL(request.url);
        id = url.searchParams.get('id');
      }
      if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
      
      const data = await env.QUANTEX_KV.get(DEVICES_KEY, { type: 'json' }) || {};
      delete data[id];
      await env.QUANTEX_KV.put(DEVICES_KEY, JSON.stringify(data));
      return jsonResponse({ ok: true, removed: id });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}

// ════════════════════════════════════════════════════════
// 雲端備份 Sync(OOS / AutoBT / Paper Track)
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
// v2.3: 跨裝置 OOS 同步 handler
// /oos/push   POST  body: {userId, oos, deviceLabel?}  → 上傳該裝置的 OOS
// /oos/pull   GET   ?userIds=u-A,u-B,u-C            → 拉取多裝置 OOS 合併
// /oos/list   GET                                       → 列出所有有資料的 user_id
// /oos/clear  POST  body: {userId}                  → 清除該 user_id 資料
// ════════════════════════════════════════════════════════

async function handleOOSSync(request, env, path, params) {
  if (!env.QUANTEX_KV) {
    return jsonResponse({ ok: false, error: 'KV not bound' }, 500);
  }
  
  // GET /oos/list — 列出所有 user_id
  if (path === '/oos/list') {
    const list = await env.QUANTEX_KV.list({ prefix: OOS_USER_META_PREFIX });
    const users = [];
    for (const k of list.keys) {
      const userId = k.name.substring(OOS_USER_META_PREFIX.length);
      const meta = await env.QUANTEX_KV.get(k.name, { type: 'json' });
      users.push({ userId, ...(meta || {}) });
    }
    users.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return jsonResponse({ ok: true, users });
  }
  
  // POST /oos/push — 上傳本機 OOS
  if (path === '/oos/push' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { userId, oos, deviceLabel } = body;
      if (!userId || !/^u-[a-zA-Z0-9_-]{4,32}$/.test(userId)) {
        return jsonResponse({ ok: false, error: 'invalid userId format (expected u-xxxx)' }, 400);
      }
      if (!oos || typeof oos !== 'object') {
        return jsonResponse({ ok: false, error: 'invalid oos data' }, 400);
      }
      
      // ─ 速率限制(每 user 每分鐘最多 2 次 push) ─
      const minute = Math.floor(Date.now() / 60000);
      const rateKey = OOS_RATE_PREFIX + userId + ':' + minute;
      const curRate = parseInt(await env.QUANTEX_KV.get(rateKey) || '0', 10);
      if (curRate >= 2) {
        return jsonResponse({ ok: false, error: 'rate limit (2/min)' }, 429);
      }
      await env.QUANTEX_KV.put(rateKey, String(curRate + 1), { expirationTtl: 120 });
      
      // ─ 資料大小限制(5MB) ─
      const dataStr = JSON.stringify(oos);
      if (dataStr.length > 5 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: 'data too large (>5MB)' }, 400);
      }
      
      // 計算紀錄總數(供 metadata)
      let recordCount = 0;
      try {
        Object.keys(oos).forEach(sym => {
          Object.keys(oos[sym] || {}).forEach(rk => {
            const arr = (oos[sym][rk] || {}).records;
            if (Array.isArray(arr)) recordCount += arr.length;
          });
        });
      } catch(e) {}
      
      const meta = {
        ts: Date.now(),
        count: recordCount,
        size: dataStr.length,
        deviceLabel: (deviceLabel || '').substring(0, 50)
      };
      
      await env.QUANTEX_KV.put(OOS_USER_PREFIX + userId, dataStr);
      await env.QUANTEX_KV.put(OOS_USER_META_PREFIX + userId, JSON.stringify(meta));
      
      return jsonResponse({ ok: true, userId, ...meta });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }
  
  // GET /oos/pull?userIds=u-A,u-B — 拉取多裝置 OOS
  if (path === '/oos/pull') {
    const userIdsStr = params.get('userIds') || '';
    const userIds = userIdsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (userIds.length === 0) {
      return jsonResponse({ ok: false, error: 'userIds required (comma-separated)' }, 400);
    }
    if (userIds.length > 10) {
      return jsonResponse({ ok: false, error: 'max 10 userIds per request' }, 400);
    }
    
    const results = {};
    for (const uid of userIds) {
      if (!/^u-[a-zA-Z0-9_-]{4,32}$/.test(uid)) {
        results[uid] = { error: 'invalid format' };
        continue;
      }
      const data = await env.QUANTEX_KV.get(OOS_USER_PREFIX + uid, { type: 'json' });
      const meta = await env.QUANTEX_KV.get(OOS_USER_META_PREFIX + uid, { type: 'json' });
      results[uid] = {
        oos: data || null,
        meta: meta || null
      };
    }
    return jsonResponse({ ok: true, results });
  }
  
  // POST /oos/clear — 清除指定 user_id
  if (path === '/oos/clear' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { userId } = body;
      if (!userId || !/^u-[a-zA-Z0-9_-]{4,32}$/.test(userId)) {
        return jsonResponse({ ok: false, error: 'invalid userId' }, 400);
      }
      await env.QUANTEX_KV.delete(OOS_USER_PREFIX + userId);
      await env.QUANTEX_KV.delete(OOS_USER_META_PREFIX + userId);
      return jsonResponse({ ok: true, cleared: userId });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }
  
  return null;
}

async function handleSync(request, env, path, params) {
  if (!env.QUANTEX_KV) {
    return jsonResponse({ ok: false, error: 'KV not bound' }, 500);
  }

  // GET /sync/status - 列出三種備份的狀態
  if (path === '/sync/status') {
    const result = {};
    for (const [kind, key] of Object.entries(SYNC_KEYS)) {
      const meta = await env.QUANTEX_KV.get(key + '_meta', { type: 'json' });
      result[kind] = meta || null;
    }
    return jsonResponse({ ok: true, status: result });
  }

  // POST /sync/upload - 上傳備份
  // body: { kind: 'oos'|'autobt'|'papertrack', data: {...}, count: 234 }
  if (path === '/sync/upload' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { kind, data, count } = body;
      const key = SYNC_KEYS[kind];
      if (!key) return jsonResponse({ ok: false, error: 'invalid kind: ' + kind }, 400);
      
      const dataStr = JSON.stringify(data || {});
      // KV 單筆上限 25MB,我們設 5MB 上限保險
      if (dataStr.length > 5 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: 'data too large (>5MB)' }, 400);
      }
      
      const meta = {
        ts: Date.now(),
        size: dataStr.length,
        count: count || 0
      };
      
      await env.QUANTEX_KV.put(key, dataStr);
      await env.QUANTEX_KV.put(key + '_meta', JSON.stringify(meta));
      
      return jsonResponse({ ok: true, kind, ...meta });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // GET /sync/download?kind=oos - 下載備份
  if (path === '/sync/download') {
    const kind = params.get('kind');
    const key = SYNC_KEYS[kind];
    if (!key) return jsonResponse({ ok: false, error: 'invalid kind' }, 400);
    
    const data = await env.QUANTEX_KV.get(key, { type: 'json' });
    const meta = await env.QUANTEX_KV.get(key + '_meta', { type: 'json' });
    
    if (data === null) return jsonResponse({ ok: false, error: 'no backup' }, 404);
    return jsonResponse({ ok: true, kind, data, meta: meta || {} });
  }

  // DELETE /sync/clear?kind=xxx - 清除備份
  if (path === '/sync/clear' && (request.method === 'DELETE' || request.method === 'POST')) {
    const kind = params.get('kind') || 'all';
    if (kind === 'all') {
      for (const key of Object.values(SYNC_KEYS)) {
        await env.QUANTEX_KV.delete(key);
        await env.QUANTEX_KV.delete(key + '_meta');
      }
      return jsonResponse({ ok: true, cleared: 'all' });
    }
    const key = SYNC_KEYS[kind];
    if (!key) return jsonResponse({ ok: false, error: 'invalid kind' }, 400);
    await env.QUANTEX_KV.delete(key);
    await env.QUANTEX_KV.delete(key + '_meta');
    return jsonResponse({ ok: true, cleared: kind });
  }

  return null;
}

// ════════════════════════════════════════════════════════
// 雲端 ML 引擎(Random Forest)
// ════════════════════════════════════════════════════════

async function handleML(request, env, path) {
  if (!env.QUANTEX_KV) {
    return jsonResponse({ ok: false, error: 'KV not bound' }, 500);
  }

  if (path === '/ml/status') {
    const modelJson = await env.QUANTEX_KV.get(ML_KV_KEY);
    if (!modelJson) return jsonResponse({ ok: true, hasModel: false });
    const model = JSON.parse(modelJson);
    return jsonResponse({
      ok: true, hasModel: true,
      info: {
        trainedAt: model.trainedAt, nSamples: model.nSamples,
        nTrees: model.trees ? model.trees.length : 0, nFeatures: model.nFeatures
      }
    });
  }

  if (path === '/ml/train' && request.method === 'POST') {
    try {
      const body = await request.json();
      const X = body.X, y = body.y;
      if (!X || !y || X.length < 30) {
        return jsonResponse({ ok: false, error: '需要 ≥ 30 筆訓練資料,當前: ' + (X ? X.length : 0) }, 400);
      }
      const model = trainRF(X, y, { nTrees: 8, maxDepth: 5, minSplit: 4 });
      await env.QUANTEX_KV.put(ML_KV_KEY, JSON.stringify(model));
      return jsonResponse({
        ok: true,
        model: {
          trainedAt: model.trainedAt, nSamples: model.nSamples,
          nTrees: model.trees.length, nFeatures: model.nFeatures
        }
      });
    } catch(e) { return jsonResponse({ ok: false, error: e.message }, 500); }
  }

  if (path === '/ml/predict' && request.method === 'POST') {
    try {
      const body = await request.json();
      const X = body.X;
      const modelJson = await env.QUANTEX_KV.get(ML_KV_KEY);
      if (!modelJson) return jsonResponse({ ok: false, error: '尚未訓練模型' }, 404);
      const model = JSON.parse(modelJson);
      const input = Array.isArray(X[0]) ? X : [X];
      const predictions = input.map(x => predictRF(model, x));
      return jsonResponse({
        ok: true, predictions,
        modelInfo: { trainedAt: model.trainedAt, nSamples: model.nSamples }
      });
    } catch(e) { return jsonResponse({ ok: false, error: e.message }, 500); }
  }

  if (path === '/ml/upload' && request.method === 'POST') {
    try {
      const model = await request.json();
      if (!model.trees || !Array.isArray(model.trees)) {
        return jsonResponse({ ok: false, error: 'invalid model' }, 400);
      }
      model.uploadedAt = Date.now();
      if (!model.trainedAt) model.trainedAt = Date.now();
      await env.QUANTEX_KV.put(ML_KV_KEY, JSON.stringify(model));
      return jsonResponse({
        ok: true,
        model: {
          trainedAt: model.trainedAt, uploadedAt: model.uploadedAt,
          nSamples: model.nSamples, nTrees: model.trees.length
        }
      });
    } catch(e) { return jsonResponse({ ok: false, error: e.message }, 500); }
  }

  if (path === '/ml/clear' && (request.method === 'DELETE' || request.method === 'POST')) {
    await env.QUANTEX_KV.delete(ML_KV_KEY);
    return jsonResponse({ ok: true, cleared: true });
  }

  return null;
}

// ── ML helper functions ──
function buildTree(X, y, depth, maxDepth, minSplit) {
  if (depth >= maxDepth || X.length < minSplit) return { leaf: true, value: avg(y) };
  let bestGain = -Infinity, bestF = 0, bestT = 0;
  for (let f = 0; f < X[0].length; f++) {
    const values = X.map(x => x[f]).sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(values.length / 6));
    for (let i = step; i < values.length; i += step) {
      const t = (values[i-1] + values[i]) / 2;
      const leftY = [], rightY = [];
      for (let j = 0; j < X.length; j++) {
        if (X[j][f] < t) leftY.push(y[j]); else rightY.push(y[j]);
      }
      if (leftY.length < 2 || rightY.length < 2) continue;
      const gain = variance(y) - (leftY.length / y.length) * variance(leftY) - (rightY.length / y.length) * variance(rightY);
      if (gain > bestGain) { bestGain = gain; bestF = f; bestT = t; }
    }
  }
  if (bestGain <= 0) return { leaf: true, value: avg(y) };
  const leftX = [], leftY = [], rightX = [], rightY = [];
  for (let k = 0; k < X.length; k++) {
    if (X[k][bestF] < bestT) { leftX.push(X[k]); leftY.push(y[k]); }
    else { rightX.push(X[k]); rightY.push(y[k]); }
  }
  return {
    leaf: false, feature: bestF, threshold: bestT,
    left: buildTree(leftX, leftY, depth + 1, maxDepth, minSplit),
    right: buildTree(rightX, rightY, depth + 1, maxDepth, minSplit)
  };
}
function predictTree(node, x) {
  if (node.leaf) return node.value;
  return x[node.feature] < node.threshold ? predictTree(node.left, x) : predictTree(node.right, x);
}
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function variance(arr) { const m = avg(arr); return avg(arr.map(v => (v - m) ** 2)); }
function trainRF(X, y, opts) {
  opts = opts || {};
  const trees = [];
  for (let t = 0; t < (opts.nTrees || 8); t++) {
    const subX = [], subY = [];
    for (let i = 0; i < X.length; i++) {
      const r = Math.floor(Math.random() * X.length);
      subX.push(X[r]); subY.push(y[r]);
    }
    trees.push(buildTree(subX, subY, 0, opts.maxDepth || 5, opts.minSplit || 4));
  }
  return { trees, trainedAt: Date.now(), nFeatures: X[0].length, nSamples: X.length };
}
function predictRF(model, x) { return avg(model.trees.map(t => predictTree(t, x))); }

// ════════════════════════════════════════════════════════
// 原有 API 函式
// ════════════════════════════════════════════════════════

async function proxyYahoo(params) {
  const symbols = params.get('symbols');
  if (!symbols) return jsonResponse({ error: 'symbols required' }, 400);
  const symList = symbols.split(',').map(s => s.trim()).filter(Boolean);

  try {
    const batchUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symList.join(','))}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month,fiftyTwoWeekHigh,fiftyTwoWeekLow,fiftyTwoWeekChangePercent,regularMarketPreviousClose,sharesOutstanding`;
    const batchRes = await fetch(batchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      cf: { cacheTtl: 300 }
    });
    if (batchRes.ok) {
      const batchData = await batchRes.json();
      const quotes = batchData?.quoteResponse?.result || [];
      const map = {};
      quotes.forEach(q => {
        map[q.symbol] = {
          symbol: q.symbol,
          regularMarketPrice: q.regularMarketPrice || 0,
          regularMarketChangePercent: q.regularMarketChangePercent || 0,
          regularMarketVolume: q.regularMarketVolume || 0,
          averageDailyVolume3Month: q.averageDailyVolume3Month || 0,
          fiftyTwoWeekHigh: q.fiftyTwoWeekHigh || 0,
          fiftyTwoWeekLow: q.fiftyTwoWeekLow || 0,
          fiftyTwoWeekChangePercent: q.fiftyTwoWeekChangePercent || 0,
          regularMarketPreviousClose: q.regularMarketPreviousClose || 0,
          sparkline: null, trailingPE: null, returnOnEquity: null,
          revenueGrowth: null, earningsGrowth: null,
        };
      });
      return jsonResponse({ quoteResponse: { result: Object.values(map) } });
    }
  } catch(e) {}

  const results = await Promise.all(symList.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        cf: { cacheTtl: 300 }
      });
      const data = await res.json();
      const q = data.chart.result[0];
      const m = q.meta;
      const price = m.regularMarketPrice || m.previousClose || 0;
      const prev = m.chartPreviousClose || m.previousClose || price;
      const chgPct = prev > 0 ? ((price - prev) / prev * 100) : 0;
      const vol = q.indicators.quote[0].volume;
      const closes = q.indicators.quote[0].close.filter(c => c);
      const high52 = m.fiftyTwoWeekHigh || 0;
      const low52 = m.fiftyTwoWeekLow || 0;
      const chg52 = low52 > 0 ? (price - low52) / low52 : 0;
      const avgVol = vol && vol.length > 0 ? vol.filter(v => v).reduce((a, b) => a + b, 0) / vol.filter(v => v).length : 0;
      const curVol = vol && vol.length > 0 ? (vol[vol.length-1] || 0) : 0;
      const allCloses = closes.filter(c => c != null);
      const step = Math.max(1, Math.floor(allCloses.length / 52));
      const sparkline = allCloses.filter((_, i) => i % step === 0).slice(-52);
      return {
        symbol: sym, regularMarketPrice: price, regularMarketChangePercent: chgPct,
        regularMarketVolume: curVol, averageDailyVolume3Month: avgVol,
        fiftyTwoWeekHigh: high52, fiftyTwoWeekLow: low52, fiftyTwoWeekChangePercent: chg52,
        regularMarketPreviousClose: prev, sparkline,
        trailingPE: null, returnOnEquity: null, revenueGrowth: null, earningsGrowth: null,
      };
    } catch(e) { return { symbol: sym, regularMarketPrice: 0, regularMarketChangePercent: 0 }; }
  }));
  return jsonResponse({ quoteResponse: { result: results, error: null } });
}

async function proxyTWSE_Institution(params) {
  const date = params.get('date') || getTodayTW();
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
    cf: { cacheTtl: 3600 }
  });
  const data = await res.json();
  const result = {};
  if (data.data) {
    data.data.forEach(row => {
      const symbol = row[0].trim();
      result[symbol] = {
        symbol, name: row[1].trim(),
        foreign_net: parseInt(row[4].replace(/,/g, '')) || 0,
        trust_net: parseInt(row[7].replace(/,/g, '')) || 0,
        dealer_net: parseInt(row[10].replace(/,/g, '')) || 0,
        total_net: parseInt(row[11].replace(/,/g, '')) || 0,
      };
    });
  }
  return jsonResponse({ date, data: result });
}

async function proxyTWSE_Margin(params) {
  const date = params.get('date') || getTodayTW();
  const url = `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${date}&selectType=ALL`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
    cf: { cacheTtl: 3600 }
  });
  const data = await res.json();
  const result = {};
  if (data.data) {
    data.data.forEach(row => {
      const symbol = row[0].trim();
      result[symbol] = {
        symbol, name: row[1].trim(),
        margin_balance: parseInt(row[4].replace(/,/g, '')) || 0,
        short_balance: parseInt(row[10].replace(/,/g, '')) || 0,
      };
    });
  }
  return jsonResponse({ date, data: result });
}

async function proxyTWSE_PE(params) {
  const date = params.get('date') || getTodayTW();
  const url = `https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date=${date}&selectType=ALL`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
    cf: { cacheTtl: 3600 }
  });
  const data = await res.json();
  const result = {};
  if (data.data) {
    data.data.forEach(row => {
      const symbol = row[0].trim();
      result[symbol] = {
        symbol, name: row[1].trim(),
        pe: parseFloat(row[4]) || null,
        pb: parseFloat(row[5]) || null,
        yield: parseFloat(row[2]) || null,
      };
    });
  }
  return jsonResponse({ date, data: result });
}

async function proxyYahooHistory(params) {
  const symbol = params.get('symbol');
  if (!symbol) return jsonResponse({ error: 'symbol required' }, 400);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=max`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    cf: { cacheTtl: 3600 }
  });
  const data = await res.json();
  try {
    const q = data.chart.result[0];
    const times = q.timestamp;
    const closes = q.indicators.quote[0].close;
    const volumes = q.indicators.quote[0].volume || [];
    const hist = [];
    for (let i = 0; i < times.length; i++) {
      if (closes[i]) {
        hist.push({
          d: new Date(times[i]*1000).toLocaleDateString('zh-TW', { month:'numeric', day:'numeric' }),
          c: closes[i], v: volumes[i] || 0
        });
      }
    }
    return jsonResponse({ symbol, hist });
  } catch(e) { return jsonResponse({ symbol, hist: [] }); }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function getTodayTW() {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = tw.getFullYear();
  const m = String(tw.getMonth() + 1).padStart(2, '0');
  const d = String(tw.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
