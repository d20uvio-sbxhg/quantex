// QUANTEX Pro - Cloudflare Worker
// 代理台灣證交所 + Yahoo Finance API，解決 CORS 問題

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    try {
      // ── 路由 ──────────────────────────────────────
      
      // 1. Yahoo Finance 股價
      // GET /yahoo?symbols=NVDA,AAPL,2330.TW
      if (path === '/yahoo') {
        return await proxyYahoo(params);
      }

      // 2. 三大法人買賣超
      // GET /twse/institution?date=20250428
      if (path === '/twse/institution') {
        return await proxyTWSE_Institution(params);
      }

      // 3. 融資融券
      // GET /twse/margin?date=20250428
      if (path === '/twse/margin') {
        return await proxyTWSE_Margin(params);
      }

      // 4. 個股本益比/淨值比
      // GET /twse/pe?date=20250428
      if (path === '/twse/pe') {
        return await proxyTWSE_PE(params);
      }

      // 5. 歷史數據（供回測引擎使用）
      // GET /yahoo-history?symbol=2330.TW
      if (path === '/yahoo-history') {
        return await proxyYahooHistory(params);
      }

      // 6. 大盤指數（台股^TWII / 美股^GSPC）
      // GET /market?symbol=^TWII
      if (path === '/market') {
        return await proxyYahooHistory(params);
      }

      // 7. 預快取大盤數據（每小時更新）
      // GET /market-cache?type=tw|us
      if (path === '/market-cache') {
        const type = params.get('type') || 'tw';
        const symbol = type === 'tw' ? '0050.TW' : 'SPY';
        const fakeParams = new URLSearchParams({symbol});
        // Use longer cache for market data
        const res = await proxyYahooHistory(fakeParams);
        const data = await res.clone().json();
        return new Response(JSON.stringify(data), {
          headers: {
            ...CORS_HEADERS,
            'Cache-Control': 'public, max-age=3600', // 1 hour cache
          }
        });
      }

      // 8. 基本面數據（單支股票，帶快取）
      // GET /fundamentals?symbol=AAPL
      if (path === '/fundamentals') {
        const sym2 = params.get('symbol');
        if (!sym2) return jsonResponse({ error: 'symbol required' }, 400);
        try {
          const v10url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym2)}?modules=financialData,defaultKeyStatistics,summaryDetail`;
          const v10res = await fetch(v10url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            cf: { cacheTtl: 86400 } // 24小時快取（基本面不常變）
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
        } catch(e) {
          return jsonResponse({ error: e.message }, 500);
        }
      }

      // 9. 外資持股比例
      // GET /twse/holding
      if (path === '/twse/holding') {
        try {
          const url = 'https://www.twse.com.tw/fund/MI_QFIIS?response=json&selectType=ALLBUT0999';
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
            cf: { cacheTtl: 86400 } // 每日更新
          });
          const data = await res.json();
          const result = {};
          // 欄位: [股票代號, 股票名稱, 外資持股張數, 全體外資持股比例, 陸資持股比例, 外資+陸資比例, 法令限制比例, 可申購比率]
          if (data.data) {
            data.data.forEach(row => {
              const symbol = row[0].trim();
              result[symbol] = {
                foreign_hold_shares: parseInt((row[2]||'0').replace(/,/g,'')) || 0,
                foreign_hold_pct: parseFloat((row[3]||'0').replace(/%/,'')) || 0,  // %
                legal_limit_pct: parseFloat((row[6]||'0').replace(/%/,'')) || 0,   // 法令上限%
                available_pct: parseFloat((row[7]||'0').replace(/%/,'')) || 0,     // 可申購比率%
              };
            });
          }
          return jsonResponse({ data: result });
        } catch(e) {
          return jsonResponse({ error: e.message }, 500);
        }
      }

      // 10. 投信持股比例
      if (path === '/twse/trust') {
        try {
          const url = 'https://www.twse.com.tw/fund/TWT43U?response=json&selectType=ALL';
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
            cf: { cacheTtl: 86400 }
          });
          const data = await res.json();
          const result = {};
          // 欄位: [股票代號, 股票名稱, 買進, 賣出, 庫存張數, 庫存佔發行比例]
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
        } catch(e) {
          return jsonResponse({ error: e.message }, 500);
        }
      }

      // 11. 近5日法人買賣超累計
      if (path === '/twse/inst5d') {
        try {
          const symbol = params.get('symbol');
          if (!symbol) return jsonResponse({ error: 'symbol required' }, 400);
          // 抓最近5個交易日的法人數據
          const dates = [];
          let d = new Date();
          while (dates.length < 5) {
            d.setDate(d.getDate() - 1);
            const day = d.getDay();
            if (day !== 0 && day !== 6) {
              dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
            }
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
          const valid = results.filter(r => r !== null);
          return jsonResponse({ data: valid });
        } catch(e) {
          return jsonResponse({ error: e.message }, 500);
        }
      }

      // 12. 健康檢查
      if (path === '/health') {
        return jsonResponse({ status: 'ok', version: 'v1.7', time: new Date().toISOString() });
      }

      return jsonResponse({ error: 'Unknown endpoint' }, 404);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

// ── Yahoo Finance（用 v8 chart API 抓多支股票）────
async function proxyYahoo(params) {
  const symbols = params.get('symbols');
  if (!symbols) return jsonResponse({ error: 'symbols required' }, 400);

  const symList = symbols.split(',').map(s => s.trim()).filter(Boolean);

  // 同時抓所有股票（支援最多30支）
  const results = await Promise.all(symList.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        cf: { cacheTtl: 300 } // 5分鐘快取
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
      // 52週漲跌幅（近似）
      const chg52 = low52 > 0 ? (price - low52) / low52 : 0;
      // 平均成交量（用最近幾天）
      const avgVol = vol && vol.length > 0 ? vol.filter(v=>v).reduce((a,b)=>a+b,0)/vol.filter(v=>v).length : 0;
      const curVol = vol && vol.length > 0 ? (vol[vol.length-1] || 0) : 0;

      // 提取52週收盤價用於走勢圖（最多取52個點）
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
        sparkline: sparkline,  // 52週走勢數據
        trailingPE: null,
        returnOnEquity: null,
        revenueGrowth: null,
        earningsGrowth: null,
      };
    } catch(e) {
      return { symbol: sym, regularMarketPrice: 0, regularMarketChangePercent: 0 };
    }
  }));

  // 包裝成跟 v7 一樣的格式讓前端相容
  return jsonResponse({
    quoteResponse: { result: results, error: null }
  });
}

// ── 三大法人買賣超 ───────────────────────────────
async function proxyTWSE_Institution(params) {
  const date = params.get('date') || getTodayTW();
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
    cf: { cacheTtl: 3600 }
  });

  const data = await res.json();
  
  // 整理成易用格式
  // 欄位: [證券代號, 證券名稱, 外資買, 外資賣, 外資淨, 投信買, 投信賣, 投信淨, 自營買, 自營賣, 自營淨, 三大法人]
  const result = {};
  if (data.data) {
    data.data.forEach(row => {
      const symbol = row[0].trim();
      result[symbol] = {
        symbol,
        name: row[1].trim(),
        foreign_net: parseInt(row[4].replace(/,/g, '')) || 0,   // 外資淨買超（張）
        trust_net: parseInt(row[7].replace(/,/g, '')) || 0,     // 投信淨買超
        dealer_net: parseInt(row[10].replace(/,/g, '')) || 0,   // 自營商淨買超
        total_net: parseInt(row[11].replace(/,/g, '')) || 0,    // 三大法人合計
      };
    });
  }

  return jsonResponse({ date, data: result });
}

// ── 融資融券 ─────────────────────────────────────
async function proxyTWSE_Margin(params) {
  const date = params.get('date') || getTodayTW();
  const url = `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${date}&selectType=ALL`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
    cf: { cacheTtl: 3600 }
  });

  const data = await res.json();

  // 整理成易用格式
  const result = {};
  if (data.data) {
    data.data.forEach(row => {
      const symbol = row[0].trim();
      const marginBalance = parseInt(row[4].replace(/,/g, '')) || 0;  // 融資餘額
      const shortBalance = parseInt(row[10].replace(/,/g, '')) || 0;  // 融券餘額
      result[symbol] = {
        symbol,
        name: row[1].trim(),
        margin_balance: marginBalance,   // 融資餘額（千股）
        short_balance: shortBalance,     // 融券餘額（千股）
      };
    });
  }

  return jsonResponse({ date, data: result });
}

// ── 本益比/淨值比 ────────────────────────────────
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
        pe: parseFloat(row[4]) || null,   // 本益比
        pb: parseFloat(row[5]) || null,   // 股價淨值比
        yield: parseFloat(row[2]) || null, // 殖利率
      };
    });
  }

  return jsonResponse({ date, data: result });
}

// ── Yahoo Finance 歷史數據 ───────────────────────────
async function proxyYahooHistory(params) {
  const symbol = params.get('symbol');
  if (!symbol) return jsonResponse({ error: 'symbol required' }, 400);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    cf: { cacheTtl: 3600 } // 歷史數據快取1小時
  });

  const data = await res.json();
  try {
    const q = data.chart.result[0];
    const times = q.timestamp;
    const closes = q.indicators.quote[0].close;
    const hist = [];
    for (let i = 0; i < times.length; i++) {
      if (closes[i]) {
        hist.push({ d: new Date(times[i]*1000).toLocaleDateString('zh-TW',{month:'numeric',day:'numeric'}), c: closes[i] });
      }
    }
    return jsonResponse({ symbol, hist });
  } catch(e) {
    return jsonResponse({ symbol, hist: [] });
  }
}

// ── 工具函式 ─────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function getTodayTW() {
  // 台灣時間今天日期，格式 YYYYMMDD
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = tw.getFullYear();
  const m = String(tw.getMonth() + 1).padStart(2, '0');
  const d = String(tw.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
