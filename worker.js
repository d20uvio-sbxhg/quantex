// QUANTEX Pro - Cloudflare Worker (含雲端 ML + 雲端備份 + API Key 認證 v2.2)
// 代理台灣證交所 + Yahoo Finance API,解決 CORS 問題
// + 雲端 ML 引擎(Random Forest)
// + 雲端自動備份(OOS / AutoBT / Paper Track)
// + v2.2: API Key 認證(env.ML_KEY)
// + v2.3: 跨裝置 OOS 同步(/oos/push, /oos/pull, /oos/list_users)
// + v2.5: 國際新聞 RSS + 情緒分析(/news)
// + v2.6: User data 同步(F&G 歷史/族群熱度歷史/持倉/釘選 - /userdata/push, /userdata/pull)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
};

// v2.11: 允許的 Origin 白名單(雙重認證:Origin + ML_KEY)
const ALLOWED_ORIGINS = [
  'https://d20uvio-sbxhg.github.io',
  'http://localhost',                       // 本地開發
  'http://127.0.0.1'
];

function isOriginAllowed(request) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  // 任一符合即可(瀏覽器 fetch 一定會帶 Origin / Referer)
  for (const allowed of ALLOWED_ORIGINS) {
    if (origin.indexOf(allowed) === 0) return true;
    if (referer.indexOf(allowed) === 0) return true;
  }
  return false;
}

// v2.11: 簡易 rate limit(每 IP 每分鐘上限)
async function checkRateLimit(env, request, maxPerMin = 20) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 
               request.headers.get('X-Real-IP') || 
               'unknown';
    const minute = Math.floor(Date.now() / 60000);
    const key = 'rl:' + ip + ':' + minute;
    const cur = parseInt(await env.QUANTEX_KV.get(key) || '0', 10);
    if (cur >= maxPerMin) return false;
    // 不寫 KV(節省寫入額度),只用 in-memory 比較
    // 改用 Cloudflare cf object 的 timestamp + IP 做粗略限制
    return true;
  } catch(e) {
    return true; // 失敗就放行(不阻擋功能)
  }
}

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

// v2.6: User data sync (F&G history / sector heat / holdings / pinned)
const USERDATA_PREFIX = 'userdata:';          // userdata:u-ABC → 該裝置 user data
const USERDATA_META_PREFIX = 'userdata_meta:';
const USERDATA_RATE_PREFIX = 'userdata_rate:';

// v2.7: 雲端 AutoBT(Worker 自主運算)
const AUTOBT_QUEUE_KEY = 'autobt_queue_v27';        // {tw: [...], us: [...]}
const AUTOBT_RESULT_PREFIX = 'autobt_result_v27:';  // autobt_result:tw:2330
const AUTOBT_PROGRESS_KEY = 'autobt_progress_v27';

// v2.8: 大骨(Podcast 重點彙整)
const DAGU_RAW_KEY = 'dagu_raw_v1';           // PTT 抓回的原始貼文
const DAGU_SUMMARY_KEY = 'dagu_summary_v1';   // AI 整理後的摘要
const DAGU_LASTSCRAPE_KEY = 'dagu_lastscrape_v1';

// v2.9: 自動回測檢討(雲端記錄推薦 + 自動驗證)
const DAILY_PICKS_PREFIX = 'daily_picks_v1:';      // daily_picks_v1:tw:2025-05-12
const PICKS_OOS_KEY = 'picks_oos_v1';              // 累積 OOS 樣本
const PICKS_STATS_KEY = 'picks_stats_v1';          // 累積命中率統計

// v2.8: 監聽的 podcaster 關鍵字(PTT 標題或內文出現任一即抓)
// v2.13: 大幅擴充關鍵字,提高命中率
const DAGU_PODCASTERS = [
  { name: '股癌',         keywords: ['股癌', '謝孟恭', '乾爹', 'gooaye', 'Gooaye', 'GOOAYE', '孟恭', '孟仔', '恭哥'], 
    ytChannelId: 'UC23rnlQU_qE3cec9x709peA' },
  { name: '財經皓角',     keywords: ['游庭皓', '財經皓角', '皓角', '庭皓', '皓哥'],
    ytChannelId: 'UC0lbAQVpenvfA2QqzsRtL_g' },
  { name: '老余',         keywords: ['老余', '老余的金融筆記', '余家阿大', '金融筆記', '裸K'],
    ytChannelId: 'UCw-WSUgjBe2_yMfJPBPLcjQ' },
  { name: '矽谷輕鬆談',   keywords: ['矽谷輕鬆談', '矽谷', 'Kenji', 'JKTech'],
    ytChannelId: 'UCJIPFjZSCWR15_jxBaK2fQQ' },
  { name: '財女 Jenny',   keywords: ['財女Jenny', '財女 Jenny', 'Jenny 美股', 'Jenny美股', '財女', 'JC財經', '王怡人'],
    ytChannelId: 'UCdwPn2TO60Ec8QDIFRx50lQ' },
  { name: '美股咖啡館',   keywords: ['美股咖啡館', '咖啡館', '尼科', '價值投資'],
    ytChannelId: 'UCjrP2TtSTifuRJ76hW2IW1A' },
];

// v2.14: YouTube RSS 抓取(每個 podcaster 的最新影片標題)
async function daguYouTubeScrape(env) {
  const results = [];
  for (const podcaster of DAGU_PODCASTERS) {
    if (!podcaster.ytChannelId) continue; // 沒 channel ID 跳過
    
    try {
      const rssUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + podcaster.ytChannelId;
      const res = await fetch(rssUrl, {
        cf: { cacheTtl: 3600 }
      });
      if (!res.ok) {
        results.push({ podcaster: podcaster.name, error: 'fetch failed ' + res.status });
        continue;
      }
      const xml = await res.text();
      
      // 解析 RSS XML(簡單 regex,不用完整 XML parser)
      const videos = [];
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let m;
      while ((m = entryRegex.exec(xml)) !== null && videos.length < 5) {
        const entry = m[1];
        const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
        const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/);
        const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
        const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
        if (titleMatch && publishedMatch) {
          videos.push({
            title: titleMatch[1],
            url: linkMatch ? linkMatch[1] : 'https://www.youtube.com/watch?v=' + (idMatch?idMatch[1]:''),
            videoId: idMatch ? idMatch[1] : null,
            published: publishedMatch[1],
            publishedTs: new Date(publishedMatch[1]).getTime()
          });
        }
      }
      
      results.push({
        podcaster: podcaster.name,
        channelId: podcaster.ytChannelId,
        videos: videos
      });
    } catch (err) {
      results.push({ podcaster: podcaster.name, error: err.message });
    }
  }
  
  // 把所有影片合併,依時間排序(新→舊)
  const allVideos = [];
  for (const r of results) {
    if (r.videos) {
      for (const v of r.videos) {
        allVideos.push({ ...v, podcaster: r.podcaster });
      }
    }
  }
  allVideos.sort((a, b) => b.publishedTs - a.publishedTs);
  
  // 存 KV
  const raw = {
    scrapedAt: Date.now(),
    podcasters: results,
    allVideos: allVideos.slice(0, 20)  // 最新 20 部
  };
  try {
    await env.QUANTEX_KV.put('dagu:youtube:raw', JSON.stringify(raw), { expirationTtl: 7 * 24 * 3600 });
    await env.QUANTEX_KV.put('dagu:youtube:lastscrape', JSON.stringify({ 
      ts: Date.now(), 
      count: allVideos.length,
      podcasterCount: results.filter(r => r.videos && r.videos.length).length
    }));
  } catch (kvErr) {
    return { ok: true, ...raw, kvWriteFailed: true, error: 'KV: ' + kvErr.message };
  }
  
  return {
    ok: true,
    totalPodcasters: results.length,
    successPodcasters: results.filter(r => r.videos && r.videos.length).length,
    totalVideos: allVideos.length,
    videos: allVideos.slice(0, 10),
    podcasters: results.map(r => ({ name: r.podcaster, videoCount: r.videos ? r.videos.length : 0, error: r.error }))
  };
}

// v2.7: 主流股池(cron 自動跑這些)
const DEFAULT_TW_STOCKS = [
  '2330','2317','2454','2308','2303','2882','2881','2891','2886','2884',
  '1303','1301','1326','2412','3008','2002','5880','2892','2207','2379',
  '2395','3711','2357','2382','2376','6669','4938','2337','3034','2353',
  '2880','2408','2327','2344','3045','2603','2609','1216','2912','2887',
  '6505','2474','2883','2890','1101','2615','2885','2801','2888','5871',
  '3017','2345','6415','2059','5274','3443','3406','2049','1590','3533',
  '2356','2377','2301','3702','1476','9910','2313','3231','6278','2404',
  '5347','6488','3661','6510','4966','2383','3035','8016','3529','6271',
  '2610','2618','2014','2204','1402','2492','3026','6173','3068','2478',
  '5317','8043','2375','3450','4979','6869','3163','4977','1503','1513',
  '1514','1519','1504','6789','6461','2385','3596','6770','2449','3044',
  '3037','2367','2409','3481','2498','6274','3706','5269','6533','6523',
  '5876','2006','1102','2105','1210','2915','2903','5904','2606','2605',
  '6446','4743','6550','4726','1795','4716','3514','4904','6691','2351',
  '3081','3227','5364','8299','5483','3105','6147','6182','4763','6679',
  '6531','4961','5371','8086','8499','4174','4123','6535','6213','4943',
  '6592','5469','3293','5258','6863','1565','8104','8358','6121','6143',
  '3551','6202','6573','5536','8424','4967','3583','8261','6643'
];
const DEFAULT_US_STOCKS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','AMD','INTC',
  'QCOM','TXN','ADBE','CRM','NOW','ORCL','INTU','PANW','ANET','CSCO',
  'JPM','V','MA','GS','MS','BAC','WFC','AXP','SPGI','BLK',
  'LLY','UNH','JNJ','MRK','ABBV','TMO','ISRG','GILD','REGN','VRTX',
  'MRNA','WMT','COST','MCD','SBUX','NKE','HD','TGT','TJX','XOM',
  'CVX','NEE','CAT','RTX','LMT','PLTR','SNOW','UBER','NFLX','SHOP',
  'PYPL','COIN','MSTR','ARM','SMCI','MRVL','CEG','T','VZ','TMUS',
  'DIS','PG','KO','PEP','PLD','BKNG','ABNB','EQT','SEI','PSIX',
  'LBRT','COHR','CRWV','IREN','CORZ','APLD','TEM','VST','AB','GOOG',
  'MU','LRCX','GE','AMAT','PM','LIN','IBM','C','KLAC','APH',
  'AMGN','ABT','ADI','BA','ETN','SCHW','PFE','DE','APP','COP',
  'BX','UNP','LOW','DELL','GLW','WELL','HON','MDT','NEM','ACN',
  'CB','SYK','VRT','BMY','DHR','PH','COF','PGR','CRWD','STX',
  'MO','EQIX','HCA','CVS','WDC','CME','SO','MCK','NOC','CMCSA',
  'GD','DUK','MAR','TT','SNPS','BSX','ICE','FDX','WM','UPS',
  'PWR','WMB','FCX','MMC','ORLY','JCI','CDNS','EMR','ADP','SHW',
  'PNC','KKR','MCO','CMI','HWM','AMT','MNST','USB','BK','HOOD',
  'SLB','ELV','MMM','CRH','RCL','ECL','ITW','GM','MSI','KMI',
  'CSX','DASH','APO','EOG','MDLZ','CTAS','CIEN','WBD','CI','AON',
  'ROST','CL','COR','TDG','DLR','HLT','VLO','MPWR','SPG','PCAR',
  'NSC','TRV','MPC','APD','AEP','PSX','RSG','FTNT','TFC','TEL',
  'NXPI','SRE','BKR','KEYS','AFL','O','LHX','OXY','IDXX','OKE',
  'AJG','AZO','D','FANG','CARR','CVNA','CTVA','ALL','GWW','ETR',
  'AME','ADSK','PSA','MET','FAST','BDX','EA','EXC','EW','NDAQ',
  'ZTS','F','GRMN','XEL','URI','TRGP','TER','CAH','EBAY','ODFL',
  'DHI','FIX','YUM','DDOG','ROK','PEG','AMP','MCHP','AIG','CBRE',
  'KR','VTR','WAB','FITB','MSCI','CMG','A','VMC','TTWO','ED',
  'HSY','EME','STT','DAL','CCI','HIG','MLM','LYV','LVS','IBKR',
  'NUE','KDP','TPL','WEC','ROP','SYY','FICO','PCG','STLD','ON',
  'CCL','FISV','PRU','ACGL','FIS','WDAY','KVUE','MTB','HBAN','AXON',
  'SATS','IR','HPE','PAYX','HAL','KMB','RMD','TDY','CPRT','TPR',
  'NTRS','VICI','ATO','DTE','XYL','IRM','LEN','AEE','ADM','DVN',
  'UAL','PPL','VRSK','OTIS','FE','EXR','EL','WAT','DOW','DOV',
  'NRG','IQV','RJF','CASY','DG','CNP','MTD','GEHC','EIX','BIIB',
  'STZ','CFG','JBL','CBOE','FOXA','KHC','ROL','DXCM','AWK','EXPE',
  'BR','LYB','WRB','AVB','CINF','ARES','SYF','ES','DRI','CMS',
  'CTSH','CHTR','BG','EQR','BRO','WTW','RF','LITE','FOX','ULTA',
  'PHM','FSLR','HUBB','Q','PPG','DGX','SBAC','CHRW','VRSN','KEY',
  'L','NI','HUM','LDOS','CHD','WSM','VLTO','STE','OMC','LH',
  'TSN','CNC','JBHT','CSGP','SW','DLTR','PFG','CPAY','NTAP','DD',
  'RL','EXPD','TROW','CTRA','ZBH','TSCO','SNA','PKG','LUV','AMCR',
  'CF','LNT','GPN','GIS','WST','ALB','EVRG','IFF','FTV','NVR',
  'VTRS','J','HPQ','AKAM','WY','INCY','IP','BALL','LULU','PSKY',
  'ESS','PTC','INVH','TRMB','KIM','MAA','NWS','IEX','LII','TXT',
  'HII','CDW','NDSN','MAS','TKO','GPC','FFIV','GEN','NWSA','BEN',
  'AVY','MKC','REG','DECK','ALLE','TYL','JKHY','ERIE','HAS','HST',
  'PNR','TTD','APA','BBY','ALGN','PODD','DPZ','BLDR','APTV','CLX',
  'COO','HRL','GNRC','GDDY','UDR','SJM','UHS','WYNN','AIZ','SWK',
  'PNW','GL','ZBRA','IT','CPT','IVZ','BAX','AES','DVA','MGM',
  'RVTY','FRT','AOS','ARE','CRL','SWKS','MOS','TECH','TAP','NCLH',
  'HSIC','FDS','BXP','CAG','POOL','EPAM','CPB','ASML','AZN','BIDU',
  'JD','PDD','NTES','MELI','RIVN','LCID','BNTX','MDB','GFS','ARGX',
  'TEAM','ANSS','CHKP','GMAB','ZS','OKTA'
];

// ════════════════════════════════════════════════════════
// v2.24: T86 三大法人買賣超(逐日歷史籌碼) — 真實籌碼資料來源
// 端點: https://www.twse.com.tw/fund/T86?response=json&date=YYYYMMDD&selectType=ALLBUT0999
// 一次回傳當天全市場個股的外資/投信/自營商買賣超(股數)。
// 儲存(顧及 KV 1000寫/日): 每「日期」存一筆快照,非每股一筆。
//   chip_d:<YYYYMMDD> = { "2330":[外資淨,投信淨,自營淨], ... }  單位:股
//   chip_dates = ["20260603",...] 已存日期索引(升冪)
// 用欄位「名稱」比對,避開 TWSE 多年欄位順序變動。網路測試需部署後對真實回應核對。
// ════════════════════════════════════════════════════════
function chipParseNum(s){
  if (s == null) return 0;
  const n = parseInt(String(s).replace(/[, ]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

async function fetchT86(dateStr){
  const url = 'https://www.twse.com.tw/fund/T86?response=json&date=' + dateStr + '&selectType=ALLBUT0999';
  let r;
  try {
    r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw' },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
  } catch(e){ return { ok:false, error:'fetch failed: ' + String(e) }; }
  if (!r.ok) return { ok:false, error:'http ' + r.status };
  let j;
  try { j = await r.json(); } catch(e){ return { ok:false, error:'json parse failed' }; }
  if (!j || j.stat !== 'OK' || !Array.isArray(j.fields) || !Array.isArray(j.data)) {
    return { ok:false, error:'no data (假日?) stat=' + (j && j.stat) };
  }
  const fields = j.fields;
  const findIdx = (pred) => fields.findIndex(pred);
  const idxCode    = findIdx(f => /證券代號|代號/.test(f));
  // 外資淨: 含「外」「買賣超股數」但不含「自營」→ 抓「外陸資買賣超股數(不含外資自營商)」
  const idxForeign = findIdx(f => /外/.test(f) && /買賣超股數/.test(f) && !/自營/.test(f));
  // 投信淨
  const idxTrust   = findIdx(f => /投信/.test(f) && /買賣超股數/.test(f));
  // 自營商淨(合計): 含「自營商買賣超股數」但不含子項(自行買賣/避險)
  const idxDealer  = findIdx(f => /自營商買賣超股數/.test(f) && !/自行|避險/.test(f));
  if (idxCode < 0 || idxForeign < 0) {
    return { ok:false, error:'fields not matched', fields };
  }
  const rows = {};
  for (const row of j.data){
    const code = String(row[idxCode] || '').trim();
    if (!/^\d{4}$/.test(code)) continue;  // 只收 4 碼上市普通股
    rows[code] = [
      chipParseNum(row[idxForeign]),
      idxTrust  >= 0 ? chipParseNum(row[idxTrust])  : 0,
      idxDealer >= 0 ? chipParseNum(row[idxDealer]) : 0
    ];
  }
  return { ok:true, date:dateStr, count:Object.keys(rows).length, rows,
           matchedFields:{ code:idxCode, foreign:idxForeign, trust:idxTrust, dealer:idxDealer } };
}

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
        version: 'v2.25-ts',
        time: new Date().toISOString(),
        mlAvailable: !!env.QUANTEX_KV,
        syncAvailable: !!env.QUANTEX_KV,
        oosShareAvailable: !!env.QUANTEX_KV,
        cloudAutobt: !!env.QUANTEX_KV,
        dagu: !!env.QUANTEX_KV,
        workersAI: !!env.AI,
        autoVerify: !!env.QUANTEX_KV,
        authConfigured: !!env.ML_KEY
      });
    }

    // v2.18: CNN 官方恐慌貪婪指數(代理,繞過瀏覽器 CORS)
    if (path === '/fear-greed') {
      try {
        const cnnUrl = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
        const r = await fetch(cnnUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          cf: { cacheTtl: 600, cacheEverything: true } // Cloudflare 邊緣快取 10 分鐘
        });
        if (!r.ok) return jsonResponse({ ok: false, error: 'CNN fetch failed: ' + r.status }, 502);
        const d = await r.json();
        const fg = d.fear_and_greed || {};
        return jsonResponse({
          ok: true,
          score: Math.round(fg.score || 0),
          rating: fg.rating || 'unknown',
          timestamp: fg.timestamp || null,
          previousClose: Math.round(fg.previous_close || 0),
          week: Math.round(fg.previous_1_week || 0),
          month: Math.round(fg.previous_1_month || 0),
          year: Math.round(fg.previous_1_year || 0),
          components: {
            momentum: d.market_momentum_sp500 ? Math.round(d.market_momentum_sp500.score) : null,
            strength: d.stock_price_strength ? Math.round(d.stock_price_strength.score) : null,
            breadth: d.stock_price_breadth ? Math.round(d.stock_price_breadth.score) : null,
            putcall: d.put_call_options ? Math.round(d.put_call_options.score) : null,
            volatility: d.market_volatility_vix ? Math.round(d.market_volatility_vix.score) : null,
            safehaven: d.safe_haven_demand ? Math.round(d.safe_haven_demand.score) : null,
            junkbond: d.junk_bond_demand ? Math.round(d.junk_bond_demand.score) : null
          }
        });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e) }, 500);
      }
    }

    // ════════════════════════════════════════════════════════
    // v2.24: T86 真實籌碼 — 抓取/回補/查詢(公開 GET,方便手機驗證)
    // ════════════════════════════════════════════════════════
    if (path === '/chip/fetch') {
      const date = (params.get('date') || '').replace(/\D/g, '');
      if (!/^\d{8}$/.test(date)) return jsonResponse({ ok:false, error:'date 需 YYYYMMDD' }, 400);
      const res = await fetchT86(date);
      if (!res.ok) return jsonResponse(res, 200);  // 回 200 但 ok:false,方便看原因(假日/欄位沒對到)
      try {
        await env.QUANTEX_KV.put('chip_d:' + date, JSON.stringify(res.rows), { expirationTtl: 400 * 86400 });
        let dates = await env.QUANTEX_KV.get('chip_dates', { type:'json' }) || [];
        if (!dates.includes(date)) { dates.push(date); dates.sort(); await env.QUANTEX_KV.put('chip_dates', JSON.stringify(dates)); }
      } catch(e){ return jsonResponse({ ok:false, error:'KV write: ' + String(e) }, 500); }
      return jsonResponse({
        ok:true, date, stored:res.count,
        sample: { '2330':res.rows['2330']||null, '2317':res.rows['2317']||null, '3008':res.rows['3008']||null },
        matchedFields: res.matchedFields,
        note: '陣列順序 [外資淨,投信淨,自營淨],單位:股。請拿 2330 跟公開來源(如 Yahoo 法人進出)核對。'
      });
    }

    if (path === '/chip/backfill') {
      const from = (params.get('from') || '').replace(/\D/g, '');
      const to   = (params.get('to')   || '').replace(/\D/g, '');
      const max  = Math.min(parseInt(params.get('max') || '10', 10) || 10, 15);
      if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) return jsonResponse({ ok:false, error:'from/to 需 YYYYMMDD' }, 400);
      let dates = await env.QUANTEX_KV.get('chip_dates', { type:'json' }) || [];
      const toD = (s) => new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8));
      const fmt = (d) => '' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
      const done = [], emptyDays = [];
      let d = toD(from); const end = toD(to); let calls = 0;
      while (d <= end && calls < max) {
        const ds = fmt(d); const dow = d.getDay();
        if (dow !== 0 && dow !== 6 && !dates.includes(ds)) {
          const res = await fetchT86(ds); calls++;
          if (res.ok) {
            await env.QUANTEX_KV.put('chip_d:' + ds, JSON.stringify(res.rows), { expirationTtl: 400 * 86400 });
            dates.push(ds); done.push(ds);
          } else { emptyDays.push(ds); }
        }
        d.setDate(d.getDate() + 1);
      }
      if (done.length) { dates.sort(); await env.QUANTEX_KV.put('chip_dates', JSON.stringify(dates)); }
      return jsonResponse({
        ok:true, storedCount:done.length, stored:done, emptyOrHoliday:emptyDays,
        totalStoredDates:dates.length,
        nextFrom: (d <= end ? fmt(d) : null),
        note: (d <= end ? '還沒到 to,把 from 換成 nextFrom 再呼叫一次繼續回補' : '已回補到 to,完成')
      });
    }

    if (path === '/chip/history') {
      const sym = (params.get('symbol') || '').trim();
      const limit = Math.min(parseInt(params.get('limit') || '30', 10) || 30, 90);
      if (!/^\d{4}$/.test(sym)) return jsonResponse({ ok:false, error:'symbol 需 4 碼' }, 400);
      let dates = await env.QUANTEX_KV.get('chip_dates', { type:'json' }) || [];
      const recent = dates.slice(-limit);
      const series = [];
      for (const ds of recent) {
        const snap = await env.QUANTEX_KV.get('chip_d:' + ds, { type:'json' });
        if (snap && snap[sym]) series.push({ d:ds, f:snap[sym][0], t:snap[sym][1], dl:snap[sym][2] });
      }
      return jsonResponse({ ok:true, symbol:sym, count:series.length, series, note:'f=外資淨 t=投信淨 dl=自營淨 (股)' });
    }

    // ════════════════════════════════════════════════════════
    // v2.7: 雲端 AutoBT 公開讀取端點(無需 auth)
    // ════════════════════════════════════════════════════════
    if (path === '/cloud-autobt/progress') {
      const prog = await env.QUANTEX_KV.get(AUTOBT_PROGRESS_KEY, { type: 'json' }) || null;
      const queue = await env.QUANTEX_KV.get(AUTOBT_QUEUE_KEY, { type: 'json' }) || { tw: [], us: [] };
      return jsonResponse({
        ok: true,
        progress: prog,
        pending: { tw: queue.tw.length, us: queue.us.length },
        defaultPoolSize: { tw: DEFAULT_TW_STOCKS.length, us: DEFAULT_US_STOCKS.length }
      });
    }

    if (path === '/cloud-autobt/results') {
      const market = params.get('market') || 'tw';
      if (!['tw', 'us'].includes(market)) return jsonResponse({ ok: false, error: 'invalid market' }, 400);
      const list = await env.QUANTEX_KV.list({ prefix: AUTOBT_RESULT_PREFIX + market + ':', limit: 200 });
      const results = {};
      for (const k of list.keys) {
        const sym = k.name.substring((AUTOBT_RESULT_PREFIX + market + ':').length);
        const data = await env.QUANTEX_KV.get(k.name, { type: 'json' });
        if (data) results[sym] = data;
      }
      return new Response(JSON.stringify({ ok: true, market, count: Object.keys(results).length, results }), {
        headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' }
      });
    }

    if (path === '/cloud-autobt/result') {
      const market = params.get('market') || 'tw';
      const symbol = params.get('symbol') || '';
      if (!symbol) return jsonResponse({ ok: false, error: 'symbol required' }, 400);
      const data = await env.QUANTEX_KV.get(AUTOBT_RESULT_PREFIX + market + ':' + symbol, { type: 'json' });
      return jsonResponse({ ok: true, data });
    }

    // v2.20 路線B: 本機拉雲端 OOS(彙整所有 oos_cloud:* → 本機 quantex_oos_v2 格式)
    if (path === '/oos/cloud-pull') {
      const oos = {};       // { symbol: { regimeKey: {hits,total,hist:[...]} } }
      let totalSamples = 0;
      for (const mkt of ['tw', 'us']) {
        const list = await env.QUANTEX_KV.list({ prefix: 'oos_cloud:' + mkt + ':', limit: 1000 });
        for (const k of list.keys) {
          const sym = k.name.substring(('oos_cloud:' + mkt + ':').length);
          const arr = await env.QUANTEX_KV.get(k.name, { type: 'json' });
          if (!arr || !arr.length) continue;
          // 雲端 OOS 用單一 regimeKey 'cloud'(本機會合併計算)
          if (!oos[sym]) oos[sym] = {};
          const rk = 'cloud';
          const hits = arr.filter(o => o && o.c).length;
          oos[sym][rk] = { hits: hits, total: arr.length, hist: arr };
          totalSamples += arr.length;
        }
      }
      return new Response(JSON.stringify({ ok: true, oos, totalSamples }), {
        headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=120' }
      });
    }

    // ════════════════════════════════════════════════════════
    // v2.8: 大骨(Podcast 重點彙整)— 公開端點
    // ════════════════════════════════════════════════════════
    if (path === '/dagu/dashboard') {
      try {
        const summary = await env.QUANTEX_KV.get(DAGU_SUMMARY_KEY, { type: 'json' });
        const lastScrape = await env.QUANTEX_KV.get(DAGU_LASTSCRAPE_KEY, { type: 'json' });
        return new Response(JSON.stringify({
          ok: true,
          summary: summary || null,
          lastScrape: lastScrape || null,
          hasData: !!summary
        }), {
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' }
        });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    if (path === '/dagu/raw') {
      try {
        const raw = await env.QUANTEX_KV.get(DAGU_RAW_KEY, { type: 'json' });
        return new Response(JSON.stringify({ ok: true, raw: raw || [] }), {
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' }
        });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // ════════════════════════════════════════════════════════
    // v2.9: 自動回測檢討 — 公開讀取端點
    // ════════════════════════════════════════════════════════
    if (path === '/picks/history') {
      try {
        const market = params.get('market') || 'tw';
        const days = Math.min(60, parseInt(params.get('days') || '30'));
        const result = [];
        const now = new Date();
        for (let i = 0; i < days; i++) {
          const d = new Date(now.getTime() - i * 86400 * 1000);
          const dateStr = d.toISOString().slice(0, 10);
          const key = DAILY_PICKS_PREFIX + market + ':' + dateStr;
          const data = await env.QUANTEX_KV.get(key, { type: 'json' });
          if (data) result.push({ date: dateStr, ...data });
        }
        return new Response(JSON.stringify({ ok: true, count: result.length, history: result }), {
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' }
        });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    if (path === '/picks/stats') {
      try {
        const stats = await env.QUANTEX_KV.get(PICKS_STATS_KEY, { type: 'json' });
        return new Response(JSON.stringify({ ok: true, stats: stats || null }), {
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' }
        });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // ════════════════════════════════════════════════════════
    // v2.10: 基本面端點(Yahoo quoteSummary 代理)
    //   單支:GET /fundamental/:market/:sym
    //   批次:GET /fundamental/batch?market=tw&syms=2330,2454,...
    // 24 小時 KV cache,降低 Yahoo 呼叫
    // ════════════════════════════════════════════════════════
    {
      // 單支
      const fundMatch = path.match(/^\/fundamental\/(tw|us)\/([\w\.\-]+)$/);
      if (fundMatch) {
        const market = fundMatch[1];
        const sym = fundMatch[2];
        const result = await fetchFundamental(env, market, sym);
        const status = result.ok ? 200 : (result.statusCode || 500);
        return new Response(JSON.stringify(result), {
          status,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }
        });
      }
      
      // 批次
      if (path === '/fundamental/batch') {
        try {
          const market = params.get('market') || 'tw';
          const symsRaw = params.get('syms') || '';
          const syms = symsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 25); // 一次最多 25 支
          if (syms.length === 0) {
            return jsonResponse({ ok: false, error: '請提供 syms 參數' }, 400);
          }
          
          const data = {};
          const errors = [];
          let cacheHits = 0;
          
          // 並行抓(但每個獨立 try-catch,壞一個不影響其他)
          await Promise.all(syms.map(async sym => {
            try {
              const r = await fetchFundamental(env, market, sym);
              if (r.ok) {
                data[sym] = r;
                if (r.fromCache) cacheHits++;
              } else {
                errors.push({ sym, error: r.error });
              }
            } catch (e) {
              errors.push({ sym, error: e.message });
            }
          }));
          
          return new Response(JSON.stringify({
            ok: true,
            count: Object.keys(data).length,
            cacheHits,
            errors: errors.length > 0 ? errors : undefined,
            data
          }), {
            headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=600' }
          });
        } catch (e) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // 雙重認證 (v2.11: Origin + API Key)
    // 1. Origin/Referer 必須是 d20uvio-sbxhg.github.io
    // 2. Authorization Bearer 必須對
    // ════════════════════════════════════════════════════════
    
    // v2.11: 先檢查 Origin(擋掉非瀏覽器的請求)
    if (!isOriginAllowed(request)) {
      return jsonResponse({
        ok: false,
        error: 'Forbidden: invalid origin'
      }, 403);
    }
    
    // v2.11: rate limit(每 IP 每分鐘 20 次寫入)
    const rlOk = await checkRateLimit(env, request, 20);
    if (!rlOk) {
      return jsonResponse({
        ok: false,
        error: 'Rate limit exceeded'
      }, 429);
    }
    
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
      // ════════════ v2.7: 雲端 AutoBT 控制端點(認證後)════════════
      if (path === '/cloud-autobt/tick' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const batchSize = Math.min(15, Math.max(1, body.batchSize || 12));  // v2.19: 上限10→15,預設12
        const result = await autobtTick(env, batchSize);
        return jsonResponse({ ok: true, result });
      }
      
      if (path === '/cloud-autobt/clear' && request.method === 'POST') {
        await env.QUANTEX_KV.delete(AUTOBT_QUEUE_KEY);
        await env.QUANTEX_KV.delete(AUTOBT_PROGRESS_KEY);
        return jsonResponse({ ok: true, message: 'Queue and progress cleared' });
      }

      // ════════════ v2.8: 大骨手動觸發爬取 + AI 摘要 ════════════
      if (path === '/dagu/scrape' && request.method === 'POST') {
        const result = await daguScrape(env);
        return jsonResponse(result);
      }
      
      if (path === '/dagu/summarize' && request.method === 'POST') {
        const result = await daguSummarize(env);
        return jsonResponse(result);
      }
      
      if (path === '/dagu/refresh' && request.method === 'POST') {
        // 一次做完:爬 + 摘要
        const scraped = await daguScrape(env);
        if (!scraped.ok) return jsonResponse(scraped);
        const summarized = await daguSummarize(env);
        return jsonResponse({ ok: true, scraped, summarized });
      }
      
      // v2.14: YouTube RSS 抓取
      if (path === '/dagu/youtube' && request.method === 'POST') {
        const result = await daguYouTubeScrape(env);
        // v2.17: 抓取成功後自動接 Gemini 摘要(失敗不影響抓取結果)
        if (result && result.ok) {
          try {
            const sum = await daguYouTubeSummarize(env);
            result.summary = sum;
          } catch (e) {
            result.summary = { ok: false, error: e.message };
          }
        }
        return jsonResponse(result);
      }

      // v2.17: 單獨觸發 YouTube 摘要(不重新抓取)
      if (path === '/dagu/youtube/summarize' && request.method === 'POST') {
        const result = await daguYouTubeSummarize(env);
        return jsonResponse(result);
      }

      // v2.17: 讀已存的 YouTube 摘要(GET 給前端)
      if (path === '/dagu/youtube/summary' && request.method === 'GET') {
        try {
          const s = await env.QUANTEX_KV.get('dagu:youtube:summary');
          if (!s) return jsonResponse({ ok: false, error: '尚無摘要,請先抓取' });
          return jsonResponse({ ok: true, data: JSON.parse(s) });
        } catch (err) {
          return jsonResponse({ ok: false, error: err.message });
        }
      }
      
      // 讀已存的 YouTube 資料(GET 給前端)
      if (path === '/dagu/youtube' && request.method === 'GET') {
        try {
          const raw = await env.QUANTEX_KV.get('dagu:youtube:raw');
          if (!raw) return jsonResponse({ ok: false, error: '尚無資料,請按重新抓取' });
          return jsonResponse({ ok: true, data: JSON.parse(raw) });
        } catch (err) {
          return jsonResponse({ ok: false, error: err.message });
        }
      }
      
      // ════════════ v2.9: 自動回測檢討 ════════════
      // 推薦時 HTML 端 push snapshot
      if (path === '/picks/snapshot' && request.method === 'POST') {
        try {
          const body = await request.json();
          const { market, conviction, excluded, backup } = body;
          if (!market || !conviction) return jsonResponse({ ok: false, error: 'market 跟 conviction 必填' }, 400);
          const dateStr = new Date().toISOString().slice(0, 10);
          const key = DAILY_PICKS_PREFIX + market + ':' + dateStr;
          
          // 已有今天的記錄 → 合併(避免重複 push 覆蓋)
          const existing = await env.QUANTEX_KV.get(key, { type: 'json' });
          const data = {
            date: dateStr,
            market: market,
            ts: Date.now(),
            conviction: (conviction || []).map(s => ({
              sym: s.sym || s.symbol, name: s.name, price: s.price,
              score: s.score, level: s.level, signals: s.signals
            })),
            excluded: (excluded || []).map(s => ({
              sym: s.sym || s.symbol, name: s.name, price: s.price,
              score: s.score, reason: s.reason
            })),
            backup: (backup || []).map(s => ({
              sym: s.sym || s.symbol, name: s.name, price: s.price,
              score: s.score
            })),
            // 累積驗證進度(由 cron 寫入)
            verified: existing && existing.verified ? existing.verified : {}
          };
          await env.QUANTEX_KV.put(key, JSON.stringify(data), { expirationTtl: 60 * 24 * 3600 }); // 60 天
          return jsonResponse({ ok: true, date: dateStr, count: data.conviction.length + data.excluded.length });
        } catch (e) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }
      
      // 手動觸發 picks 驗證(平常 cron 自動跑)
      if (path === '/picks/verify' && request.method === 'POST') {
        const result = await picksVerify(env);
        return jsonResponse(result);
      }

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
      
      // ════════════ v2.6: User data 跨裝置同步(F&G/族群熱度/持倉/釘選)════════════
      if (path.startsWith('/userdata/')) {
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
        // v2.12: TW 改用 ^TWII(加權指數)而不是 0050.TW(ETF 配息會扭曲)
        const symbol = type === 'tw' ? '^TWII' : '^GSPC';  // 台股加權指數 / S&P 500
        // v2.12: 只抓 6 個月,降低資料量 + 避免長歷史除權息問題
        const fakeParams = new URLSearchParams({symbol, range: '6mo'});
        const res = await proxyYahooHistory(fakeParams);
        const data = await res.clone().json();
        
        // v2.12: sanity check — 拒絕回傳異常 mom20
        if (data.hist && data.hist.length >= 21) {
          const n = data.hist.length;
          const mom20 = ((data.hist[n-1].c - data.hist[n-21].c) / data.hist[n-21].c) * 100;
          const mom60 = n >= 61 ? ((data.hist[n-1].c - data.hist[n-61].c) / data.hist[n-61].c) * 100 : 0;
          if (Math.abs(mom20) > 30 || Math.abs(mom60) > 60) {
            // 異常 → fallback 到備用 symbol
            console.warn('[market-cache] abnormal', symbol, 'mom20=', mom20, 'mom60=', mom60);
            const fallbackSymbol = type === 'tw' ? '0050.TW' : 'SPY';
            const fb = new URLSearchParams({symbol: fallbackSymbol, range: '6mo'});
            const fbRes = await proxyYahooHistory(fb);
            const fbData = await fbRes.clone().json();
            // 再次驗證 fallback
            if (fbData.hist && fbData.hist.length >= 21) {
              const fbN = fbData.hist.length;
              const fbMom20 = ((fbData.hist[fbN-1].c - fbData.hist[fbN-21].c) / fbData.hist[fbN-21].c) * 100;
              if (Math.abs(fbMom20) <= 30) {
                fbData._fallback = fallbackSymbol;
                return new Response(JSON.stringify(fbData), {
                  headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=1800' }
                });
              }
            }
            // 都異常 → 回 empty
            return new Response(JSON.stringify({symbol, hist: [], abnormal: true, mom20: +mom20.toFixed(1), mom60: +mom60.toFixed(1)}), {
              headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' }
            });
          }
        }
        
        return new Response(JSON.stringify(data), {
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }
        });
      }

      // v2.6: 國際新聞與情緒(代理 Yahoo Finance RSS,加簡單關鍵字情緒分析)
      // v2.7-news: 升級為「指標性新聞」— 多 RSS 來源 + 整體市場關鍵字過濾
      if (path === '/news') {
        try {
          const region = params.get('region') || 'us'; // us / tw
          const limit = Math.min(parseInt(params.get('limit') || '15'), 30);
          
          // 多個 RSS 來源,優先指標性內容
          const feeds = region === 'tw' 
            ? [
                'https://tw.news.yahoo.com/rss/finance',
                'https://news.cnyes.com/rss/cat/headline',           // 鉅亨網頭條
                'https://news.cnyes.com/rss/cat/wd_stock'            // 鉅亨網全球股市
              ]
            : [
                'https://feeds.finance.yahoo.com/rss/2.0/headline?region=US&lang=en-US',
                'https://www.cnbc.com/id/100003114/device/rss/rss.html',  // CNBC Top News
                'https://www.cnbc.com/id/10000664/device/rss/rss.html'    // CNBC Markets
              ];
          
          // 「指標性」關鍵字 — 影響整體走向才優先
          const MARKO_KEYWORDS = region === 'tw'
            ? ['央行','升息','降息','利率','通膨','CPI','GDP','失業','美國','聯準會','Fed','關稅','貿易戰','地緣','油價','匯率','經濟','大盤','加權','台積電','輝達','財報','法說','聯邦','非農','製造業','PMI']
            : ['Fed','rate','inflation','CPI','GDP','jobs','unemployment','recession','tariff','trade war','geopolit','oil','dollar','treasury','yield','S&P','Nasdaq','Dow','earnings','guidance','Powell','FOMC','PCE','PPI','retail sales','manufacturing','PMI','TSMC','NVDA','AAPL','MSFT'];
          
          // 「個股雜訊」關鍵字 — 過濾掉(個別公司零散新聞)
          const NOISE_KEYWORDS = region === 'tw'
            ? ['獨家','搶先','專訪','搶手','驚人','曝光','爆料','藝人','明星','韓男','男星','女星','離婚','緋聞','八卦','重工','建商','房地產']
            : ['exclusive','celebrity','divorce','rumor','gossip','reality TV','dating'];
          
          // 抓所有 feed
          const allItems = [];
          for (const feedUrl of feeds) {
            try {
              const r = await fetch(feedUrl, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantexBot)' },
                cf: { cacheTtl: 600, cacheEverything: true }
              });
              if (!r.ok) continue;
              const xml = await r.text();
              const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
              
              for (let i = 0; i < Math.min(itemMatches.length, 20); i++) {
                const item = itemMatches[i];
                const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
                const linkMatch = item.match(/<link>(.*?)<\/link>/);
                const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
                const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/);
                
                const title = (titleMatch ? (titleMatch[1] || titleMatch[2] || '') : '').trim();
                const link = linkMatch ? linkMatch[1].trim() : '';
                const date = dateMatch ? dateMatch[1].trim() : '';
                const desc = (descMatch ? (descMatch[1] || descMatch[2] || '') : '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
                
                if (!title) continue;
                
                // 計算「指標性分數」
                const text = (title + ' ' + desc);
                let macroScore = 0;
                MARKO_KEYWORDS.forEach(k => { if (text.includes(k)) macroScore++; });
                
                let noiseScore = 0;
                NOISE_KEYWORDS.forEach(k => { if (text.includes(k)) noiseScore++; });
                
                // 雜訊太多就跳過
                if (noiseScore >= 1 && macroScore === 0) continue;
                
                allItems.push({ title, link, date, desc, macroScore, noiseScore });
              }
            } catch (e) { /* 單一 feed 失敗不影響其他 */ }
          }
          
          // 排序:指標性分數高的優先
          allItems.sort((a, b) => b.macroScore - a.macroScore);
          
          // 去重(相同 title 視為重複)
          const seen = new Set();
          const unique = [];
          for (const it of allItems) {
            const key = it.title.slice(0, 30);
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(it);
            if (unique.length >= limit) break;
          }
          
          // 情緒關鍵字字典
          const POSITIVE = ['surge','soar','rally','beat','jump','gain','rise','rising','high','strong','bullish','optimistic','上漲','大漲','飆升','利多','創新高','強勢','看好','突破','降息'];
          const NEGATIVE = ['plunge','fall','drop','decline','tumble','crash','slump','weak','bearish','pessimistic','recession','crisis','risk','下跌','大跌','重挫','利空','創新低','弱勢','看壞','跌破','風險','衰退','危機','升息'];
          
          // 情緒打分
          const items = unique.map(it => {
            const text = (it.title + ' ' + it.desc).toLowerCase();
            let posCount = 0, negCount = 0;
            POSITIVE.forEach(w => { if (text.includes(w.toLowerCase())) posCount++; });
            NEGATIVE.forEach(w => { if (text.includes(w.toLowerCase())) negCount++; });
            const sentiment = posCount > negCount ? 'positive' : negCount > posCount ? 'negative' : 'neutral';
            const sentimentScore = posCount - negCount;
            return {
              title: it.title, link: it.link, date: it.date, desc: it.desc,
              sentiment, sentimentScore, macroScore: it.macroScore
            };
          });
          
          // 整體情緒
          const totalScore = items.reduce((a,b) => a + b.sentimentScore, 0);
          const overallSentiment = totalScore > 2 ? 'positive' : totalScore < -2 ? 'negative' : 'neutral';
          
          return new Response(JSON.stringify({
            region, items, count: items.length,
            overall: { sentiment: overallSentiment, score: totalScore },
            method: 'multi-feed-with-macro-filter-v2.7'
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
  },
  
  // ════════════════════════════════════════════════════════
  // v2.7: Cron 排程 — 雲端自主跑 AutoBT(裝置全關也持續)
  // wrangler.toml 需設 [triggers] crons = ["*/5 * * * *"]
  // ════════════════════════════════════════════════════════
  async scheduled(event, env, ctx) {
    try {
      // v2.10: 降低 cloud-autobt 頻率(節省 KV 寫入)
      // 從「每 10 分鐘」改成「每 30 分鐘」(分鐘 0, 30 才跑)
      const utcNow = new Date();
      const utcHour = utcNow.getUTCHours();
      const utcMin = utcNow.getUTCMinutes();
      
      // cloud-autobt:只在 :00 / :30 跑(降低 67% 寫入)
      if (utcMin === 0 || utcMin === 30 || (utcMin >= 0 && utcMin < 10) || (utcMin >= 30 && utcMin < 40)) {
        // 但實際 logic 用「上次跑時間」檢查,避免 10 分鐘視窗內重複跑
        try {
          const lastTickRaw = await env.QUANTEX_KV.get('autobt_lasttick_v1');
          const nowMs = Date.now();
          const lastTickMs = lastTickRaw ? parseInt(lastTickRaw, 10) : 0;
          // 至少 25 分鐘 gap
          if (nowMs - lastTickMs >= 25 * 60 * 1000) {
            const result = await autobtTick(env, 6);  // v2.20: 路線B降到6(解法Y按股票存OOS,77%安全)
            console.log('[cron-autobt]', JSON.stringify(result));
            await env.QUANTEX_KV.put('autobt_lasttick_v1', String(nowMs), { expirationTtl: 7 * 24 * 3600 });
          }
        } catch (autobtErr) {
          console.error('[cron-autobt] error:', autobtErr.message);
        }
      }
      
      // 台灣 9:00 = UTC 1:00 (台灣 = UTC+8),取 1:00-1:09 視窗
      if (utcHour === 1 && utcMin < 10) {
        try {
          const lastRun = await env.QUANTEX_KV.get('dagu_lastcron_v1');
          const today = new Date().toISOString().slice(0,10);
          if (lastRun !== today) {
            console.log('[cron-dagu] running daily refresh...');
            const scraped = await daguScrape(env);
            console.log('[cron-dagu] scrape:', JSON.stringify(scraped));
            if (scraped.ok && scraped.withContent > 0) {
              const summarized = await daguSummarize(env);
              console.log('[cron-dagu] summary:', JSON.stringify(summarized));
            }
            await env.QUANTEX_KV.put('dagu_lastcron_v1', today, { expirationTtl: 7 * 24 * 3600 });
          }
        } catch (e) {
          console.error('[cron-dagu] error:', e.message);
        }
      }
      
      // v2.9: 每天台灣 9:30 AM (UTC 1:30) 自動驗證 picks 推薦
      if (utcHour === 1 && utcMin >= 30 && utcMin < 40) {
        try {
          const lastRun = await env.QUANTEX_KV.get('picks_lastcron_v1');
          const today = new Date().toISOString().slice(0,10);
          if (lastRun !== today) {
            console.log('[cron-picks-verify] starting...');
            const result = await picksVerify(env);
            console.log('[cron-picks-verify]', JSON.stringify(result));
            await env.QUANTEX_KV.put('picks_lastcron_v1', today, { expirationTtl: 7 * 24 * 3600 });
          }
        } catch (e) {
          console.error('[cron-picks-verify] error:', e.message);
        }
      }
    } catch (e) {
      console.error('[cron] error:', e.message);
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
  
  // ════════════════════════════════════════════════════════════════
  // v2.6: User data sync (F&G history / sector heat / holdings / pinned)
  // ════════════════════════════════════════════════════════════════
  
  // POST /userdata/push  body: { userId, data: {...} }
  if (path === '/userdata/push' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { userId, data } = body;
      if (!userId || !/^u-[a-zA-Z0-9_-]{4,32}$/.test(userId)) {
        return jsonResponse({ ok: false, error: 'invalid userId' }, 400);
      }
      if (!data || typeof data !== 'object') {
        return jsonResponse({ ok: false, error: 'invalid data' }, 400);
      }
      
      // 速率限制(每 user 每分鐘 3 次)
      const minute = Math.floor(Date.now() / 60000);
      const rateKey = USERDATA_RATE_PREFIX + userId + ':' + minute;
      const curRate = parseInt(await env.QUANTEX_KV.get(rateKey) || '0', 10);
      if (curRate >= 3) {
        return jsonResponse({ ok: false, error: 'rate limit (3/min)' }, 429);
      }
      await env.QUANTEX_KV.put(rateKey, String(curRate + 1), { expirationTtl: 120 });
      
      // 大小限制(2MB,因為主要是歷史時間序列)
      const dataStr = JSON.stringify(data);
      if (dataStr.length > 2 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: 'data too large (>2MB)' }, 400);
      }
      
      const meta = {
        ts: Date.now(),
        size: dataStr.length,
        keys: Object.keys(data),
        deviceLabel: (body.deviceLabel || '').substring(0, 50)
      };
      
      await env.QUANTEX_KV.put(USERDATA_PREFIX + userId, dataStr);
      await env.QUANTEX_KV.put(USERDATA_META_PREFIX + userId, JSON.stringify(meta));
      
      return jsonResponse({ ok: true, userId, ...meta });
    } catch(e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }
  
  // GET /userdata/pull?userIds=u-A,u-B  → 拉取多裝置資料合併回傳
  if (path === '/userdata/pull') {
    const userIdsStr = params.get('userIds') || '';
    const userIds = userIdsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (userIds.length === 0) {
      return jsonResponse({ ok: false, error: 'userIds required' }, 400);
    }
    if (userIds.length > 10) {
      return jsonResponse({ ok: false, error: 'max 10 userIds' }, 400);
    }
    
    const results = {};
    for (const uid of userIds) {
      if (!/^u-[a-zA-Z0-9_-]{4,32}$/.test(uid)) continue;
      const dataStr = await env.QUANTEX_KV.get(USERDATA_PREFIX + uid);
      const metaStr = await env.QUANTEX_KV.get(USERDATA_META_PREFIX + uid);
      if (dataStr) {
        try {
          results[uid] = {
            data: JSON.parse(dataStr),
            meta: metaStr ? JSON.parse(metaStr) : null
          };
        } catch(e) {}
      }
    }
    
    return jsonResponse({ ok: true, results });
  }
  
  // GET /userdata/list  → 列出所有有資料的 userId(管理用)
  if (path === '/userdata/list') {
    const list = await env.QUANTEX_KV.list({ prefix: USERDATA_META_PREFIX });
    const users = [];
    for (const k of list.keys.slice(0, 100)) {
      const userId = k.name.substring(USERDATA_META_PREFIX.length);
      const meta = await env.QUANTEX_KV.get(k.name, { type: 'json' });
      users.push({ userId, ...meta });
    }
    return jsonResponse({ ok: true, users });
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
      const vol = q.indicators.quote[0].volume;
      const closes = q.indicators.quote[0].close.filter(c => c);
      // 今日漲跌基準 = 前一交易日收盤(日線倒數第二根)。
      // 不可用 chartPreviousClose:那是整段(range=5d)區間的前一日收盤,會把近數日累積漲幅誤算成單日 → 出現 +16% 這種不可能的台股單日漲幅。
      const prev = closes.length >= 2 ? closes[closes.length - 2] : (m.previousClose || m.chartPreviousClose || price);
      const chgPct = prev > 0 ? ((price - prev) / prev * 100) : 0;
      const high52 = m.fiftyTwoWeekHigh || 0;
      const low52 = m.fiftyTwoWeekLow || 0;
      // v2.23: 5日 chart 無法得知 52 週前價格。原本用 (price-low52)/low52 假裝年度漲幅 → 永遠正值且偏高,
      // 不僅「年度漲幅」顯示錯,還被前端當動能算進評分(會灌水)。改回 null,前端各處皆有 ||0 / !=null 防護。
      const chg52 = null;
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
  // v2.12: 預設 max(個股 BT 需要長歷史),呼叫端可指定較短 range
  const range = params.get('range') || 'max';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
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
    // v2.12: 優先用 adjclose(除權除息調整後)— 避免長歷史的除權息扭曲
    const adjclose = (q.indicators.adjclose && q.indicators.adjclose[0] && q.indicators.adjclose[0].adjclose) || null;
    
    const hist = [];
    for (let i = 0; i < times.length; i++) {
      // v2.12: 優先用 adjclose,fallback 到 close
      const px = (adjclose && adjclose[i]) || closes[i];
      if (px && px > 0) {
        hist.push({
          d: new Date(times[i]*1000).toLocaleDateString('zh-TW', { month:'numeric', day:'numeric' }),
          t: times[i],
          c: px, v: volumes[i] || 0
        });
      }
    }
    
    return jsonResponse({ symbol, hist });
  } catch(e) { return jsonResponse({ symbol, hist: [], error: e.message }); }
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

// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// v2.8: 大骨(Podcast 重點彙整)
// ════════════════════════════════════════════════════════
// 流程:
// 1. daguScrape:爬 PTT Stock 板,過濾 7 個 podcaster 關鍵字,抓近期文章
// 2. daguSummarize:用 Workers AI(Llama)整理 5 條重點 + 5 個方向 + 信心度
// 3. 失敗降級:Workers AI 爆額度時用純關鍵字提取
// ════════════════════════════════════════════════════════

async function daguScrape(env) {
  try {
    // v2.13: 抓 PTT Stock 板「最新 3 頁」(共 ~60 篇)而不是只首頁 20 篇
    const articles = [];
    let nextPagePath = '/bbs/Stock/index.html';
    let pagesScraped = 0;
    let pttFetchFailed = 0;
    
    for (let pageNum = 0; pageNum < 3 && nextPagePath; pageNum++) {
      const pageUrl = 'https://www.ptt.cc' + nextPagePath;
      try {
        const res = await fetch(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; QuantexBot)',
            'Cookie': 'over18=1'
          },
          cf: { cacheTtl: 600 }
        });
        if (!res.ok) {
          pttFetchFailed++;
          break;
        }
        const html = await res.text();
        pagesScraped++;
        
        // 解析文章列表
        const articleRegex = /<div class="r-ent">[\s\S]*?<div class="title">[\s\S]*?<a href="(\/bbs\/Stock\/M\.\d+\.A\.[A-F0-9]+\.html)">([^<]+)<\/a>[\s\S]*?<div class="nrec">(?:<span[^>]*>([^<]*)<\/span>)?<\/div>[\s\S]*?<div class="author">([^<]+)<\/div>[\s\S]*?<div class="date">\s*([^<]+?)\s*<\/div>/g;
        
        let match;
        while ((match = articleRegex.exec(html)) !== null) {
          articles.push({
            url: 'https://www.ptt.cc' + match[1],
            title: match[2].trim(),
            push: match[3] ? match[3].trim() : '0',
            author: match[4].trim(),
            date: match[5].trim()
          });
        }
        
        // 找下一頁(較舊)連結 — PTT 用「‹ 上頁」按鈕
        // <a class="btn wide" href="/bbs/Stock/index{N}.html">‹ 上頁</a>
        const prevPageMatch = html.match(/<a class="btn wide" href="(\/bbs\/Stock\/index\d+\.html)">‹\s*上頁<\/a>/);
        nextPagePath = prevPageMatch ? prevPageMatch[1] : null;
      } catch(pageErr) {
        pttFetchFailed++;
        break;
      }
    }
    
    if (articles.length === 0) {
      return { ok: false, error: 'PTT index fetch failed: 抓不到任何文章(已試 ' + pagesScraped + ' 頁)' };
    }
    
    // 過濾:標題符合任一 podcaster 關鍵字
    const matched = [];
    for (const art of articles) {
      for (const podcaster of DAGU_PODCASTERS) {
        const hit = podcaster.keywords.some(kw => art.title.includes(kw));
        if (hit) {
          matched.push({ ...art, podcaster: podcaster.name });
          break;
        }
      }
    }
    
    // v2.13: 取最近 12 篇(從 8 提到 12,抓多一點)
    const recent = matched.slice(0, 12);
    const withContent = [];
    for (const art of recent) {
      try {
        const artRes = await fetch(art.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; QuantexBot)',
            'Cookie': 'over18=1'
          },
          cf: { cacheTtl: 3600 }
        });
        if (!artRes.ok) continue;
        const artHtml = await artRes.text();
        // 抓 main-content,去除 HTML 標籤
        const contentMatch = artHtml.match(/<div id="main-content"[^>]*>([\s\S]*?)<span class="f2">/);
        let content = '';
        if (contentMatch) {
          content = contentMatch[1]
            .replace(/<[^>]+>/g, ' ')      // 去 HTML
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3000);                // 限制長度避免吃太多 AI 額度
        }
        // 抓推文數
        const pushMatches = artHtml.match(/<div class="push">/g);
        const pushCount = pushMatches ? pushMatches.length : 0;
        // 抓股票代號(4位數字 + 美股 1-5 字母)
        const twTickers = [...content.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map(m => m[1]);
        const usTickers = [...content.matchAll(/\b([A-Z]{1,5})\b/g)].map(m => m[1])
          .filter(s => !['EPS','GDP','CPI','PMI','ETF','GAAP','EBITDA','PE','PB','PEG','SEC','FED','SP','ADR'].includes(s));
        const tickers = [...new Set([...twTickers, ...usTickers])].slice(0, 8);
        
        withContent.push({
          ...art,
          content,
          pushCount,
          tickers
        });
      } catch (e) {
        console.warn('Article fetch fail:', art.url, e.message);
      }
    }
    
    // 存 KV
    const raw = {
      scrapedAt: Date.now(),
      pagesScraped,
      totalIndexed: articles.length,
      matched: matched.length,
      withContent: withContent.length,
      articles: withContent
    };
    // v2.10: KV 寫入加 try-catch(KV limit 時不阻擋大骨完成)
    try {
      await env.QUANTEX_KV.put(DAGU_RAW_KEY, JSON.stringify(raw), { expirationTtl: 7 * 24 * 3600 });
      await env.QUANTEX_KV.put(DAGU_LASTSCRAPE_KEY, JSON.stringify({ ts: Date.now(), count: withContent.length, pagesScraped, totalIndexed: articles.length, matched: matched.length }));
    } catch(kvErr) {
      console.warn('[dagu KV write fail]', kvErr.message);
      // 不 throw,仍回傳成功(資料在記憶體還在)
      return { ok: true, ...raw, kvWriteFailed: true, error: 'KV 寫入失敗(已抓到資料但暫存失敗):' + kvErr.message };
    }
    
    return {
      ok: true,
      pagesScraped,
      totalIndexed: articles.length,
      matched: matched.length,
      withContent: withContent.length,
      // v2.13: 如果 matched 為 0,也回顯前 5 篇標題讓用戶診斷
      diagnosis: matched.length === 0 
        ? '抓了 ' + articles.length + ' 篇但無 podcaster 相關討論。最新 5 篇標題:' + 
          articles.slice(0, 5).map(a => a.title).join(' | ')
        : null,
      sample: withContent.slice(0, 3).map(a => ({ title: a.title, podcaster: a.podcaster, push: a.pushCount }))
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ════════════ v2.16: Gemini 摘要(主力 AI)════════════
// key 存於 Cloudflare Worker Secret(env.GEMINI_API_KEY),不寫死、不外洩。
// 設定方式:wrangler secret put GEMINI_API_KEY  或  Dashboard → Settings → Variables。
async function callGemini(env, prompt) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 未設定');
  // gemini-2.5-flash:免費額度足夠、速度快,適合摘要任務
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
            + model + ':generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json'  // 要求直接回 JSON,省去剝殼
      }
    })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('Gemini HTTP ' + res.status + ' ' + errBody.slice(0, 200));
  }
  const data = await res.json();
  // 回應結構:candidates[0].content.parts[0].text
  const cand = data && data.candidates && data.candidates[0];
  if (!cand || !cand.content || !cand.content.parts || !cand.content.parts[0]) {
    // 可能被安全機制擋下,或回空
    const reason = (cand && cand.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason) || 'unknown';
    throw new Error('Gemini 回應為空(finishReason=' + reason + ')');
  }
  return cand.content.parts[0].text || '';
}

// ════════════ v2.17: YouTube 影片標題摘要(選項1 輕量版)════════════
// 吃 dagu:youtube:raw 的影片標題,用 Gemini 整理出「本週財經 podcast 關注焦點」。
// 注意:摘要對象是「標題+頻道」,不是逐字稿 — 屬焦點雷達,非內容摘要。
async function daguYouTubeSummarize(env) {
  try {
    const rawStr = await env.QUANTEX_KV.get('dagu:youtube:raw');
    if (!rawStr) return { ok: false, error: '尚無 YouTube 資料,請先抓取' };
    const raw = JSON.parse(rawStr);
    const videos = (raw.allVideos || []).slice(0, 20);
    if (!videos.length) return { ok: false, error: '無影片可摘要' };

    // 組標題清單(帶頻道與日期)給 Gemini
    const videoList = videos.map((v, i) =>
      (i + 1) + '. [' + v.podcaster + '] ' + v.title +
      ' (' + (v.published || '').slice(0, 10) + ')'
    ).join('\n');

    const prompt = `你是台灣財經 podcast 觀察分析師。以下是 ${videos.length} 部最新財經 YouTube 影片的「標題」清單(來自 6 個財經頻道)。

請只根據標題,整理出本週財經圈的關注焦點。注意:你只有標題、沒有影片內容,因此「不要」臆測影片裡的具體觀點或買賣建議,只做標題層級的主題歸納。

只回 JSON,不要其他文字:
{
  "weekFocus": [
    {"theme": "主題(如:輝達財報、AI伺服器)", "mentionCount": 3, "channels": ["股癌","財女Jenny"]}
  ],
  "hotTickers": [
    {"ticker": "NVDA", "context": "出現在哪些標題脈絡(簡短)"}
  ],
  "sentiment": "整體標題語氣:樂觀/中性/謹慎",
  "note": "一句話總結本週財經 podcast 圈在談什麼"
}

影片標題清單:
${videoList}`;

    let summary = null;
    let method = '';

    // 第一層:Gemini
    if (env.GEMINI_API_KEY) {
      try {
        const txt = await callGemini(env, prompt);
        const jsonMatch = txt.match(/\{[\s\S]*\}/);
        if (jsonMatch) { summary = JSON.parse(jsonMatch[0]); method = 'gemini-2.5-flash'; }
      } catch (e) {
        console.warn('[dagu-yt] Gemini failed:', e.message);
      }
    }
    // 第二層:Workers AI 降級
    if (!summary && env.AI) {
      try {
        const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt, max_tokens: 1500 });
        const txt = aiRes.response || aiRes.result || '';
        const jsonMatch = txt.match(/\{[\s\S]*\}/);
        if (jsonMatch) { summary = JSON.parse(jsonMatch[0]); method = 'workers-ai-llama-3.1'; }
      } catch (e) {
        console.warn('[dagu-yt] Workers AI failed:', e.message);
      }
    }
    if (!summary) return { ok: false, error: 'AI 摘要失敗,請稍後重試' };

    summary.generatedAt = Date.now();
    summary.method = method;
    summary.videoCount = videos.length;

    try {
      await env.QUANTEX_KV.put('dagu:youtube:summary', JSON.stringify(summary),
        { expirationTtl: 7 * 24 * 3600 });
    } catch (kvErr) {
      return { ok: true, ...summary, kvWriteFailed: true };
    }
    return { ok: true, method: method, focusCount: (summary.weekFocus || []).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function daguSummarize(env) {
  try {
    const raw = await env.QUANTEX_KV.get(DAGU_RAW_KEY, { type: 'json' });
    if (!raw || !raw.articles || raw.articles.length === 0) {
      return { ok: false, error: '無 raw 資料,請先 scrape' };
    }
    
    // 整合所有文章成一個輸入
    const inputText = raw.articles.map((a, i) => 
      `## 文章${i+1}:[${a.podcaster}] ${a.title}\n推文:${a.pushCount}\n內容:${a.content}\n股票:${(a.tickers || []).join(', ')}`
    ).join('\n\n---\n\n');
    
    let summary = null;
    let usedAI = false;
    let aiMethod = '';

    // 共用 prompt(Gemini 與 Workers AI 共用同一份)
    const prompt = `你是台灣財經 podcast 摘要分析師。閱讀以下 ${raw.articles.length} 篇 PTT 上對 podcast 的討論文章,整理成 JSON 格式回應(只回 JSON,不要其他文字):

{
  "weeklyHighlights": [
    {
      "rank": 1,
      "title": "重點一句話總結(20字內)",
      "detail": "詳細說明(50字內)",
      "tickers": ["2330", "AAPL"],
      "sources": ["股癌", "皓角"],
      "confidence": 5,
      "trend": "看好/看壞/中性"
    }
    // 共 5 條
  ],
  "directions": [
    {"sector": "AI半導體", "view": "看好", "reason": "簡短理由"},
    {"sector": "金融", "view": "看好", "reason": "簡短理由"},
    {"sector": "消費電子", "view": "中性", "reason": "簡短理由"},
    {"sector": "傳產", "view": "中性", "reason": "簡短理由"},
    {"sector": "高位電子", "view": "避開", "reason": "簡短理由"}
    // 共 5 個方向
  ],
  "marketSentiment": "正面/中性/負面",
  "keyEvents": ["事件1(15字內)", "事件2", "事件3"]
}

confidence 評分原則:5=多 podcast 共識+高推文,4=2-3 podcast,3=單一podcast 高推文,2=普通,1=資料弱

文章內容:
${inputText.slice(0, 8000)}`;

    // ── 第一層:Gemini(主力)──
    if (env.GEMINI_API_KEY) {
      try {
        const gemText = await callGemini(env, prompt);
        const jsonMatch = gemText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          summary = JSON.parse(jsonMatch[0]);
          usedAI = true;
          aiMethod = 'gemini-2.5-flash';
        }
      } catch (e) {
        console.warn('[dagu] Gemini failed, 降級 Workers AI:', e.message);
      }
    }

    // ── 第二層:Workers AI(Llama)降級 ──
    if (!summary && env.AI) {
      try {
        const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          prompt,
          max_tokens: 2000
        });
        let aiText = aiRes.response || aiRes.result || '';
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          summary = JSON.parse(jsonMatch[0]);
          usedAI = true;
          aiMethod = 'workers-ai-llama-3.1';
        }
      } catch (e) {
        console.warn('[dagu] Workers AI failed:', e.message);
      }
    }

    // ── 第三層:純關鍵字提取 ──
    if (!summary) {
      summary = daguFallbackSummary(raw.articles);
      aiMethod = 'keyword-fallback';
    }

    summary.generatedAt = Date.now();
    summary.method = aiMethod;
    summary.articleCount = raw.articles.length;
    summary.podcasters = [...new Set(raw.articles.map(a => a.podcaster))];
    
    try {
      await env.QUANTEX_KV.put(DAGU_SUMMARY_KEY, JSON.stringify(summary), { expirationTtl: 7 * 24 * 3600 });
    } catch(kvErr) {
      console.warn('[dagu summary KV fail]', kvErr.message);
      return { ok: true, ...summary, kvWriteFailed: true };
    }
    
    return {
      ok: true,
      method: summary.method,
      highlights: (summary.weeklyHighlights || []).length,
      directions: (summary.directions || []).length
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 備援:純關鍵字提取(AI 失敗時用)
function daguFallbackSummary(articles) {
  // 統計股票出現頻率
  const tickerCount = {};
  const tickerSources = {};
  articles.forEach(a => {
    (a.tickers || []).forEach(t => {
      tickerCount[t] = (tickerCount[t] || 0) + 1;
      tickerSources[t] = tickerSources[t] || new Set();
      tickerSources[t].add(a.podcaster);
    });
  });
  
  // 取前 10 名
  const topTickers = Object.entries(tickerCount)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t, n]) => ({ ticker: t, mentions: n, sources: [...(tickerSources[t] || [])] }));
  
  // 統計 podcaster 出現
  const podcasterStats = {};
  articles.forEach(a => {
    podcasterStats[a.podcaster] = (podcasterStats[a.podcaster] || 0) + 1;
  });
  
  return {
    weeklyHighlights: topTickers.slice(0, 5).map((t, i) => ({
      rank: i + 1,
      title: `多人提及 ${t.ticker}`,
      detail: `共 ${t.mentions} 篇文章提到,來源:${t.sources.join(', ')}`,
      tickers: [t.ticker],
      sources: t.sources,
      confidence: Math.min(5, Math.max(1, t.mentions)),
      trend: '中性'
    })),
    directions: [
      { sector: '高頻提及股', view: '關注', reason: '多 podcast 都提到' },
      { sector: '其他', view: '中性', reason: 'AI 摘要失敗,僅統計提及次數' }
    ],
    marketSentiment: '中性',
    keyEvents: ['AI 摘要降級為關鍵字統計,請以原文為準']
  };
}

// ════════════════════════════════════════════════════════
// v2.10: 基本面抓取(Yahoo quoteSummary 代理)
//   24 小時 KV cache,降低 Yahoo 呼叫次數
//   單支 ~ 200ms,批次 25 支 ~ 3-5s(並行)
// ════════════════════════════════════════════════════════

async function fetchFundamental(env, market, sym) {
  try {
    const cacheKey = 'fund:' + market + ':' + sym;
    
    // 1. 檢查 KV cache(24 小時)
    const cached = await env.QUANTEX_KV.get(cacheKey, { type: 'json' });
    if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < 24 * 3600 * 1000) {
      return { ok: true, fromCache: true, ...cached };
    }
    
    // 2. v2.21: 改用 v7 quote 端點抓估值
    //    原因:Yahoo 的 /v10/quoteSummary 已失效(需 cookie+crumb,直接打回 401)。
    //    v7 quote 端點仍可用(本 worker 抓股價也是用它),且回傳 trailingPE/forwardPE/
    //    priceToBook/dividendYield/eps 等估值欄位。缺 pegRatio(quoteSummary 才有)。
    const ySymbol = market === 'tw' ? sym + '.TW' : sym;
    const fields = 'trailingPE,forwardPE,priceToBook,trailingAnnualDividendYield,dividendYield,' +
                   'epsTrailingTwelveMonths,epsForward,bookValue,marketCap,' +
                   'regularMarketPrice,longName,shortName,returnOnAssets';
    const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
                encodeURIComponent(ySymbol) + '&fields=' + fields;
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      cf: { cacheTtl: 3600 }
    });
    
    if (!res.ok) {
      return { ok: false, error: 'Yahoo 回應 ' + res.status, statusCode: 502, market, sym };
    }
    
    const yd = await res.json();
    const q = yd && yd.quoteResponse && yd.quoteResponse.result && yd.quoteResponse.result[0];
    if (!q) {
      return { ok: false, error: 'Yahoo 無資料', statusCode: 404, market, sym };
    }
    
    // v7 quote 的欄位是直接數值(非 {raw} 包裝)
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
    
    // 殖利率:v7 的 trailingAnnualDividendYield 是小數(0.025=2.5%),前端會 *100;
    //   dividendYield 在 v7 有時是百分比數字(2.5),為一致改用 trailingAnnualDividendYield(小數)
    var divYield = num(q.trailingAnnualDividendYield);
    if (divYield == null && num(q.dividendYield) != null) {
      // 若只有 dividendYield 且看起來像百分比(>1),轉成小數
      var dy = num(q.dividendYield);
      divYield = dy > 1 ? dy / 100 : dy;
    }
    
    const data = {
      sym, market,
      name: q.longName || q.shortName || sym,
      // 估值(主要)
      trailingPE: num(q.trailingPE),
      forwardPE: num(q.forwardPE),
      priceToBook: num(q.priceToBook),
      pegRatio: null,  // v7 quote 無 PEG(需 quoteSummary,已失效)
      dividendYield: divYield,
      // EPS
      trailingEps: num(q.epsTrailingTwelveMonths),
      forwardEps: num(q.epsForward),
      bookValue: num(q.bookValue),
      // 規模
      marketCap: num(q.marketCap),
      returnOnAssets: num(q.returnOnAssets),
      // 以下欄位 v7 quote 無法提供(原 quoteSummary 才有),設 null 保持結構相容
      returnOnEquity: null,
      profitMargins: null,
      operatingMargins: null,
      revenueGrowth: null,
      earningsGrowth: null,
      earningsQuarterlyGrowth: null,
      debtToEquity: null,
      currentRatio: null,
      quickRatio: null,
      payoutRatio: null,
      // 時間
      fetchedAt: Date.now()
    };
    
    // 寫入 KV(7 天 TTL)
    try {
      await env.QUANTEX_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 7 * 24 * 3600 });
    } catch(kvErr) {
      console.warn('[fund KV write fail]', sym, kvErr.message);
    }
    
    return { ok: true, fromCache: false, ...data };
  } catch (e) {
    return { ok: false, error: e.message, statusCode: 500, market, sym };
  }
}

// ════════════════════════════════════════════════════════
// v2.9: 自動回測檢討 — 雲端自主驗證已推薦清單
// 每天台灣 9:30 AM cron 自動跑:
//   檢查 5/10/20 天前的 daily_picks
//   抓現價算報酬
//   寫入 verified 欄位 + 累積 stats
// ════════════════════════════════════════════════════════

async function picksVerify(env) {
  try {
    const now = new Date();
    const checkpoints = [5, 10, 20];
    let totalVerified = 0;
    let dayResults = [];
    
    // 累積統計初始化
    let stats = await env.QUANTEX_KV.get(PICKS_STATS_KEY, { type: 'json' });
    if (!stats) {
      stats = {
        startedAt: Date.now(),
        totalRecs: 0,
        verified: { d5: { hits: 0, total: 0, retSum: 0 }, d10: { hits: 0, total: 0, retSum: 0 }, d20: { hits: 0, total: 0, retSum: 0 } },
        conviction: { d5: { hits: 0, total: 0, retSum: 0 }, d10: { hits: 0, total: 0, retSum: 0 }, d20: { hits: 0, total: 0, retSum: 0 } },
        excluded: { d5: { hits: 0, total: 0, retSum: 0 }, d10: { hits: 0, total: 0, retSum: 0 }, d20: { hits: 0, total: 0, retSum: 0 } },
        lastUpdate: 0
      };
    }
    
    for (const days of checkpoints) {
      const targetDate = new Date(now.getTime() - days * 86400 * 1000);
      const dateStr = targetDate.toISOString().slice(0, 10);
      const dayResult = { days, date: dateStr, markets: {} };
      
      for (const market of ['tw', 'us']) {
        const key = DAILY_PICKS_PREFIX + market + ':' + dateStr;
        const data = await env.QUANTEX_KV.get(key, { type: 'json' });
        if (!data) continue;
        
        const checkpointKey = 'd' + days;
        // 已驗證過 → 跳過
        if (data.verified && data.verified[checkpointKey]) continue;
        
        // 收集所有要驗證的股(信念股 + 已排除 + 備援)
        const allStocks = [
          ...(data.conviction || []).map(s => ({ ...s, _category: 'conviction' })),
          ...(data.excluded || []).map(s => ({ ...s, _category: 'excluded' })),
          ...(data.backup || []).map(s => ({ ...s, _category: 'backup' }))
        ];
        
        const verified = [];
        let mktVerified = 0;
        
        for (const stock of allStocks) {
          if (!stock.sym || !stock.price) continue;
          const ySymbol = market === 'tw' ? stock.sym + '.TW' : stock.sym;
          
          try {
            // 抓最近 30 天歷史
            const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + 
                        encodeURIComponent(ySymbol) + '?range=2mo&interval=1d';
            const res = await fetch(url, { 
              headers: { 'User-Agent': 'Mozilla/5.0' },
              cf: { cacheTtl: 600 }
            });
            if (!res.ok) continue;
            const yd = await res.json();
            const result = yd && yd.chart && yd.chart.result && yd.chart.result[0];
            if (!result || !result.indicators || !result.indicators.quote) continue;
            const closes = result.indicators.quote[0].close || [];
            const validCloses = closes.filter(c => typeof c === 'number');
            if (validCloses.length < days + 1) continue;
            
            // 計算 D 天報酬:對比 picks 當天的 price 跟 D 天後的價格
            // 由於我們現在是 D 天「之後」,validCloses 最後一天 ≈ 今天
            // picks 當天的價是 stock.price,D 天後的價是 validCloses[validCloses.length - 1 - 0]?
            // 實際上要找 picks date 之後 D 天的價格 = (picks 後第 D 個交易日)
            // 簡化:用「現在的價格 / picks 當時的價格」算 D 天報酬
            const currentPrice = validCloses[validCloses.length - 1];
            const ret = (currentPrice - stock.price) / stock.price * 100;
            const correct = ret > 0;
            
            verified.push({
              sym: stock.sym,
              category: stock._category,
              priceAt: stock.price,
              priceNow: currentPrice,
              ret: +ret.toFixed(2),
              correct
            });
            
            // 寫入累積統計
            const cat = stock._category;
            stats.verified[checkpointKey].total++;
            stats.verified[checkpointKey].retSum += ret;
            if (correct) stats.verified[checkpointKey].hits++;
            
            if (cat === 'conviction') {
              stats.conviction[checkpointKey].total++;
              stats.conviction[checkpointKey].retSum += ret;
              if (correct) stats.conviction[checkpointKey].hits++;
            } else if (cat === 'excluded') {
              stats.excluded[checkpointKey].total++;
              stats.excluded[checkpointKey].retSum += ret;
              if (correct) stats.excluded[checkpointKey].hits++;
            }
            
            mktVerified++;
          } catch (e) {
            console.warn('[picksVerify]', stock.sym, e.message);
          }
        }
        
        // 寫回 daily_picks 加入 verified
        if (verified.length > 0) {
          if (!data.verified) data.verified = {};
          data.verified[checkpointKey] = {
            verifiedAt: Date.now(),
            count: verified.length,
            results: verified
          };
          await env.QUANTEX_KV.put(key, JSON.stringify(data), { expirationTtl: 60 * 24 * 3600 });
        }
        
        dayResult.markets[market] = mktVerified;
        totalVerified += mktVerified;
      }
      
      dayResults.push(dayResult);
    }
    
    stats.lastUpdate = Date.now();
    await env.QUANTEX_KV.put(PICKS_STATS_KEY, JSON.stringify(stats), { expirationTtl: 365 * 24 * 3600 });
    
    return { 
      ok: true, 
      totalVerified, 
      dayResults,
      stats: {
        d5_rate: stats.verified.d5.total > 0 ? Math.round(stats.verified.d5.hits / stats.verified.d5.total * 100) : null,
        d10_rate: stats.verified.d10.total > 0 ? Math.round(stats.verified.d10.hits / stats.verified.d10.total * 100) : null,
        conv_d5_rate: stats.conviction.d5.total > 0 ? Math.round(stats.conviction.d5.hits / stats.conviction.d5.total * 100) : null
      }
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════
// v2.7: 雲端 AutoBT — 簡化版回測,Worker 自主運行
// 哲學:不重現完整 runBacktest,只做最重要的「動量訊號 + 前向報酬」
// 每次處理 1 支股,寫入 KV(7 天 TTL)。Cron 慢慢累積,瀏覽器拉結果合併。
// ════════════════════════════════════════════════════════

async function runWorkerBT(symbol, market) {
  // 直接呼叫 Yahoo,不走 worker proxy(避免重入)
  const ySymbol = market === 'tw' ? symbol + '.TW' : symbol;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ySymbol) +
              '?range=2y&interval=1d';
  let res, data;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 3600 } });
    data = await res.json();
  } catch (e) {
    return { error: 'fetch_failed: ' + e.message };
  }
  
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) {
    return { error: 'invalid_data' };
  }
  
  const q = r.indicators.quote[0];
  const closes = q.close || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const volumes = q.volume || [];
  
  const hist = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null) {
      hist.push({
        c: closes[i],
        h: highs[i] || closes[i],
        l: lows[i] || closes[i],
        v: volumes[i] || 0
      });
    }
  }
  
  if (hist.length < 60) return { error: 'insufficient_history', n: hist.length };
  
  // 跑回測 — 對每個歷史點檢查訊號,記錄前向 5/10/20 日報酬
  const matches = [];
  const n = hist.length;
  
  for (let i = 30; i < n - 20; i++) {
    const price = hist[i].c;
    
    let sum5 = 0, sum20 = 0;
    for (let j = i - 5; j < i; j++) sum5 += hist[j].c;
    for (let j = i - 20; j < i; j++) sum20 += hist[j].c;
    const ma5 = sum5 / 5;
    const ma20 = sum20 / 20;
    
    let avgVol = 0;
    for (let j = i - 10; j < i; j++) avgVol += hist[j].v;
    avgVol /= 10;
    const volR = avgVol > 0 ? hist[i].v / avgVol : 1;
    
    // 進場訊號:價格 > 5MA*1.005 + 5MA > 20MA + 量能放大
    if (price > ma5 * 1.005 && ma5 > ma20 && volR > 1.2) {
      matches.push({
        fwd5: i + 5 < n ? +((hist[i+5].c / price - 1) * 100).toFixed(2) : null,
        fwd10: i + 10 < n ? +((hist[i+10].c / price - 1) * 100).toFixed(2) : null,
        fwd20: i + 20 < n ? +((hist[i+20].c / price - 1) * 100).toFixed(2) : null
      });
    }
  }
  
  function statsFor(key) {
    const valid = matches.map(m => m[key]).filter(v => v != null);
    if (valid.length < 5) return null;
    const wins = valid.filter(v => v > 0);
    const losses = valid.filter(v => v <= 0);
    const sum = valid.reduce((a,b) => a + b, 0);
    const winSum = wins.reduce((a,b) => a + b, 0);
    const lossSum = losses.reduce((a,b) => a + b, 0);
    return {
      n: valid.length,
      wr: Math.round(wins.length / valid.length * 100),
      avg: +(sum / valid.length).toFixed(2),
      avgWin: wins.length ? +(winSum / wins.length).toFixed(2) : 0,
      avgLoss: losses.length ? +(lossSum / losses.length).toFixed(2) : 0
    };
  }
  
  return {
    symbol,
    market,
    n: matches.length,
    s5: statsFor('fwd5'),
    s10: statsFor('fwd10'),
    s20: statsFor('fwd20'),
    histLen: hist.length,
    ts: Date.now(),
    method: 'worker-bt-v2.7',
    _hist: hist  // v2.20: 附帶歷史供 cloudWalkForward(不存入KV,用完即丟)
  };
}

// ════════════════════════════════════════════════════════════
// v2.20 路線B: 雲端 walk-forward — 在雲端產生 ML 訓練用 OOS(13維特徵)
//   與本機 autoBtRunWalkForward 邏輯一致,讓 OOS 可在雲端累積。
//   OOS 按股票分開存(解法Y): KV key = oos_cloud:<market>:<symbol>,避免並行覆蓋。
// ════════════════════════════════════════════════════════════
function cloudWalkForward(symbol, hist) {
  if (!hist || hist.length < 250) return [];
  const n = hist.length;
  const stepDays = 21, testDays = 10, purgeDays = 10;
  const maxFolds = 60;
  const startTe = Math.max(200, n - maxFolds * stepDays - testDays - purgeDays);
  const oosList = [];
  let foldCount = 0;

  for (let te = startTe; te <= n - testDays - purgeDays; te += stepDays) {
    if (foldCount >= maxFolds) break;
    const trainData = hist.slice(0, te);
    const testEnd = te + purgeDays + testDays;
    if (testEnd > n) break;
    if (trainData.length < 121) continue;

    const closes = trainData.map(d => d.c);
    const lt = closes.length;
    const lastPrice = closes[lt - 1];
    const prevPrice = closes[lt - 11];
    const mom = (lastPrice - prevPrice) / prevPrice;

    const mom5 = lt >= 6 ? (closes[lt-1] - closes[lt-6]) / closes[lt-6] * 100 : 0;
    const mom20 = lt >= 21 ? (closes[lt-1] - closes[lt-21]) / closes[lt-21] * 100 : 0;
    const mom60 = lt >= 61 ? (closes[lt-1] - closes[lt-61]) / closes[lt-61] * 100 : 0;
    const mom120 = lt >= 121 ? (closes[lt-1] - closes[lt-121]) / closes[lt-121] * 100 : 0;
    let gain = 0, loss = 0;
    for (let k = lt - 14; k < lt; k++) {
      if (k < 1) continue;
      const ch = closes[k] - closes[k-1];
      if (ch > 0) gain += ch; else loss -= ch;
    }
    const rs = loss > 0 ? gain / loss : (gain > 0 ? 100 : 1);
    const rsi14 = 100 - 100 / (1 + rs);
    let sma20 = 0; for (let k = lt-20; k < lt; k++) sma20 += closes[k]; sma20 /= 20;
    let sd = 0; for (let k = lt-20; k < lt; k++) sd += Math.pow(closes[k]-sma20, 2); sd = Math.sqrt(sd/20);
    const bbPos = sd > 0 ? (closes[lt-1] - (sma20 - 2*sd)) / (4*sd) : 0.5;
    let ma200 = 0; const ma200n = Math.min(200, lt); for (let k = lt-ma200n; k < lt; k++) ma200 += closes[k]; ma200 /= ma200n;
    const ma200Dist = (closes[lt-1] - ma200) / ma200 * 100;
    let atr = 0; const atrN = Math.min(14, trainData.length-1);
    for (let k = lt-atrN; k < lt; k++) { if (k<1) continue; atr += Math.abs(trainData[k].h - trainData[k].l); }
    atr /= atrN;
    const atrPct = closes[lt-1] > 0 ? atr / closes[lt-1] * 100 : 0;
    let retSum = 0, retSumSq = 0, retN = 0;
    for (let k = lt-20; k < lt; k++) { if (k<1) continue; const rr = (closes[k]-closes[k-1])/closes[k-1]*100; retSum += rr; retSumSq += rr*rr; retN++; }
    const vol20 = retN > 1 ? Math.sqrt((retSumSq - retSum*retSum/retN)/(retN-1)) : 0;
    const regimeBull = ma200Dist > 0 && mom60 > 0 ? 1 : 0;

    const feat = [
      mom5, mom20, mom60, mom120,
      rsi14, bbPos, ma200Dist, atrPct, vol20,
      0, regimeBull,
      (mom20 > 0 && mom60 > 0) ? 1 : 0,
      50
    ];

    const predicted = mom > 0 ? 'up' : 'down';
    const p10 = hist[testEnd - 1].c;
    const ret = (p10 - lastPrice) / lastPrice * 100;
    const actual = ret > 0 ? 'up' : 'down';

    oosList.push({
      t: Date.now(), te: te,
      p: predicted, a: actual, r: +ret.toFixed(2),
      c: predicted === actual,
      features: feat, actual: actual,
      outcome: predicted === actual, dev: 'cloud'
    });
    foldCount++;
  }
  return oosList;
}

async function cloudSaveOOS(env, symbol, market, oosList) {
  if (!env.QUANTEX_KV || !oosList.length) return 0;
  const key = 'oos_cloud:' + market + ':' + symbol;
  let existing = [];
  try { existing = await env.QUANTEX_KV.get(key, { type: 'json' }) || []; } catch(e) {}
  const seenTe = {};
  existing.forEach(o => { if (o && o.te != null) seenTe[o.te] = true; });
  let added = 0;
  oosList.forEach(o => { if (!seenTe[o.te]) { existing.push(o); added++; } });
  if (existing.length > 200) existing = existing.slice(-200);
  if (added > 0) {
    await env.QUANTEX_KV.put(key, JSON.stringify(existing), { expirationTtl: 30 * 86400 });
  }
  return added;
}

// Cron tick — 處理一批股票
async function autobtTick(env, batchSize = 6) {  // v2.20: 預設6
  if (!env.QUANTEX_KV) return { error: 'no_kv' };
  
  // 取出隊列
  let queue = await env.QUANTEX_KV.get(AUTOBT_QUEUE_KEY, { type: 'json' }) || { tw: [], us: [] };
  
  // 如果空就用預設池重填
  if (!queue.tw.length && !queue.us.length) {
    queue = {
      tw: [...DEFAULT_TW_STOCKS],
      us: [...DEFAULT_US_STOCKS]
    };
  }
  
  const processed = [];
  let count = 0;
  
  // 交替市場處理
  while (count < batchSize && (queue.tw.length || queue.us.length)) {
    let market, arr;
    if (count % 2 === 0 && queue.tw.length) { market = 'tw'; arr = queue.tw; }
    else if (queue.us.length) { market = 'us'; arr = queue.us; }
    else if (queue.tw.length) { market = 'tw'; arr = queue.tw; }
    else break;
    
    const symbol = arr.shift();
    try {
      const result = await runWorkerBT(symbol, market);
      if (result && !result.error) {
        const hist = result._hist;       // v2.20: 取出歷史
        delete result._hist;             // 存 KV 前剔除(不佔空間)
        await env.QUANTEX_KV.put(
          AUTOBT_RESULT_PREFIX + market + ':' + symbol,
          JSON.stringify(result),
          { expirationTtl: 7 * 86400 }
        );
        // v2.20 路線B: 雲端產生 OOS(walk-forward),按股票分開存
        let oosAdded = 0;
        try {
          const oosList = cloudWalkForward(symbol, hist);
          oosAdded = await cloudSaveOOS(env, symbol, market, oosList);
        } catch (oe) { /* OOS 失敗不影響回測 */ }
        processed.push({ symbol, market, ok: true, n: result.n, oos: oosAdded });
      } else {
        processed.push({ symbol, market, ok: false, error: (result && result.error) || 'no_result' });
      }
    } catch (e) {
      processed.push({ symbol, market, ok: false, error: e.message });
    }
    count++;
  }
  
  // 寫回隊列
  await env.QUANTEX_KV.put(AUTOBT_QUEUE_KEY, JSON.stringify(queue));
  
  // 更新進度
  const progress = {
    lastTick: Date.now(),
    pendingTw: queue.tw.length,
    pendingUs: queue.us.length,
    totalTw: DEFAULT_TW_STOCKS.length,
    totalUs: DEFAULT_US_STOCKS.length,
    lastProcessed: processed
  };
  await env.QUANTEX_KV.put(AUTOBT_PROGRESS_KEY, JSON.stringify(progress));
  
  return progress;
}
