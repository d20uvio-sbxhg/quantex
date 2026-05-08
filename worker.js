// QUANTEX Pro - Cloudflare Worker (含雲端 ML v2.0)
// 代理台灣證交所 + Yahoo Finance API,解決 CORS 問題
// + 雲端 ML 引擎 (Random Forest 訓練 + 預測,結果存 KV)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

const ML_KV_KEY = 'quantex_ml_model_v1';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    try {
      // ════════════ ML 雲端路由(優先) ════════════
      if (path.startsWith('/ml/')) {
        const r = await handleML(request, env, path);
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

      if (path === '/health') {
        return jsonResponse({ status: 'ok', version: 'v2.0-with-ml', time: new Date().toISOString(), mlAvailable: !!env.QUANTEX_KV });
      }

      return jsonResponse({ error: 'Unknown endpoint' }, 404);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

// ════════════════════════════════════════════════════════
// 雲端 ML 引擎(Random Forest)
// ════════════════════════════════════════════════════════

async function handleML(request, env, path) {
  if (!env.QUANTEX_KV) {
    return jsonResponse({ ok: false, error: 'KV not bound (請檢查 wrangler.toml)' }, 500);
  }

  // GET /ml/status - 取得模型狀態
  if (path === '/ml/status') {
    const modelJson = await env.QUANTEX_KV.get(ML_KV_KEY);
    if (!modelJson) return jsonResponse({ ok: true, hasModel: false });
    const model = JSON.parse(modelJson);
    return jsonResponse({
      ok: true,
      hasModel: true,
      info: {
        trainedAt: model.trainedAt,
        nSamples: model.nSamples,
        nTrees: model.trees ? model.trees.length : 0,
        nFeatures: model.nFeatures
      }
    });
  }

  // POST /ml/train - 接收 OOS 資料訓練模型
  if (path === '/ml/train' && request.method === 'POST') {
    try {
      const body = await request.json();
      const X = body.X, y = body.y;
      if (!X || !y || X.length < 30) {
        return jsonResponse({ ok: false, error: '需要 ≥ 30 筆訓練資料,當前: ' + (X ? X.length : 0) }, 400);
      }
      // Free plan CPU 限制 10ms,所以樹數量 + 深度都壓低
      const model = trainRF(X, y, { nTrees: 8, maxDepth: 5, minSplit: 4 });
      await env.QUANTEX_KV.put(ML_KV_KEY, JSON.stringify(model));
      return jsonResponse({
        ok: true,
        model: {
          trainedAt: model.trainedAt,
          nSamples: model.nSamples,
          nTrees: model.trees.length,
          nFeatures: model.nFeatures
        }
      });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // POST /ml/predict - 用最新模型預測
  if (path === '/ml/predict' && request.method === 'POST') {
    try {
      const body = await request.json();
      const X = body.X;
      const modelJson = await env.QUANTEX_KV.get(ML_KV_KEY);
      if (!modelJson) return jsonResponse({ ok: false, error: '尚未訓練模型,請先 POST /ml/train' }, 404);
      const model = JSON.parse(modelJson);
      const input = Array.isArray(X[0]) ? X : [X];
      const predictions = input.map(function(x) { return predictRF(model, x); });
      return jsonResponse({
        ok: true,
        predictions: predictions,
        modelInfo: { trainedAt: model.trainedAt, nSamples: model.nSamples }
      });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // POST /ml/upload - 直接從 client 上傳訓練好的模型(免雲端訓練,Free plan 友好)
  if (path === '/ml/upload' && request.method === 'POST') {
    try {
      const model = await request.json();
      if (!model.trees || !Array.isArray(model.trees)) {
        return jsonResponse({ ok: false, error: 'invalid model: missing trees array' }, 400);
      }
      model.uploadedAt = Date.now();
      if (!model.trainedAt) model.trainedAt = Date.now();
      await env.QUANTEX_KV.put(ML_KV_KEY, JSON.stringify(model));
      return jsonResponse({
        ok: true,
        model: {
          trainedAt: model.trainedAt,
          uploadedAt: model.uploadedAt,
          nSamples: model.nSamples,
          nTrees: model.trees.length
        }
      });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // DELETE /ml/clear - 清除模型
  if (path === '/ml/clear' && (request.method === 'DELETE' || request.method === 'POST')) {
    await env.QUANTEX_KV.delete(ML_KV_KEY);
    return jsonResponse({ ok: true, cleared: true });
  }

  return null;
}

// ── 輕量 Decision Tree ──
function buildTree(X, y, depth, maxDepth, minSplit) {
  if (depth >= maxDepth || X.length < minSplit) {
    return { leaf: true, value: avg(y) };
  }
  let bestGain = -Infinity, bestF = 0, bestT = 0;
  const nFeat = X[0].length;
  for (let f = 0; f < nFeat; f++) {
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
    leaf: false,
    feature: bestF,
    threshold: bestT,
    left: buildTree(leftX, leftY, depth + 1, maxDepth, minSplit),
    right: buildTree(rightX, rightY, depth + 1, maxDepth, minSplit)
  };
}

function predictTree(node, x) {
  if (node.leaf) return node.value;
  return x[node.feature] < node.threshold ? predictTree(node.left, x) : predictTree(node.right, x);
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function variance(arr) {
  const m = avg(arr);
  return avg(arr.map(v => (v - m) * (v - m)));
}

// ── Random Forest ──
function trainRF(X, y, opts) {
  opts = opts || {};
  const nTrees = opts.nTrees || 8;
  const maxDepth = opts.maxDepth || 5;
  const minSplit = opts.minSplit || 4;
  const trees = [];
  for (let t = 0; t < nTrees; t++) {
    const subX = [], subY = [];
    for (let i = 0; i < X.length; i++) {
      const r = Math.floor(Math.random() * X.length);
      subX.push(X[r]); subY.push(y[r]);
    }
    trees.push(buildTree(subX, subY, 0, maxDepth, minSplit));
  }
  return { trees, trainedAt: Date.now(), nFeatures: X[0].length, nSamples: X.length };
}

function predictRF(model, x) {
  return avg(model.trees.map(t => predictTree(t, x)));
}

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
          sparkline: null,
          trailingPE: null,
          returnOnEquity: null,
          revenueGrowth: null,
          earningsGrowth: null,
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
        symbol: sym,
        regularMarketPrice: price,
        regularMarketChangePercent: chgPct,
        regularMarketVolume: curVol,
        averageDailyVolume3Month: avgVol,
        fiftyTwoWeekHigh: high52,
        fiftyTwoWeekLow: low52,
        fiftyTwoWeekChangePercent: chg52,
        regularMarketPreviousClose: prev,
        sparkline,
        trailingPE: null,
        returnOnEquity: null,
        revenueGrowth: null,
        earningsGrowth: null,
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
        symbol,
        name: row[1].trim(),
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
        symbol,
        name: row[1].trim(),
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
        symbol,
        name: row[1].trim(),
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
          c: closes[i],
          v: volumes[i] || 0
        });
      }
    }
    return jsonResponse({ symbol, hist });
  } catch(e) {
    return jsonResponse({ symbol, hist: [] });
  }
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
