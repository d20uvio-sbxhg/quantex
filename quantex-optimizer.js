/* ==========================================================================
 * QUANTEX Pro — Algorithm Optimizer v2.0
 * ==========================================================================
 *  v2 重大升級:Regime-Conditional Ensemble
 *
 *  v1 解決:[1] 信心倒掛 [2] 盤整過濾 [3] 真 walk-forward [4] 部位管理
 *  v2 加上:[5] 大盤狀態自動分類(6 態)
 *           [6] 產業相對強弱
 *           [7] Regime-conditional OOS 校準
 *               (同一支股票在不同 regime 下分開記錄,因為一支在多頭可靠的股票
 *                在空頭可能完全失準 — 把資料混在一起會稀釋每個 regime 的訊號)
 *           [8] 動態策略選擇器(regime → strategy 映射)
 * ========================================================================== */

(function(global){
  'use strict';

  var OOS_KEY = 'quantex_oos_v2';
  var OOS = (function(){
    try {
      var raw = localStorage.getItem(OOS_KEY);
      if(raw) return JSON.parse(raw);
      // 從 v1 自動遷移
      var v1raw = localStorage.getItem('quantex_oos_v1');
      if(v1raw){
        var v1 = JSON.parse(v1raw);
        var migrated = {};
        for(var sym in v1){ migrated[sym] = {unknown: v1[sym]}; }
        return migrated;
      }
      return {};
    } catch(e) { return {}; }
  })();

  function persistOOS(){
    try { localStorage.setItem(OOS_KEY, JSON.stringify(OOS)); } catch(e) {}
  }

  // ══════════════════════════════════════════════════════════════════
  //  [5] 大盤狀態偵測(6 態分類器)
  // ══════════════════════════════════════════════════════════════════
  function detectMarketRegime(mktHist){
    if(!mktHist || mktHist.length < 50){
      return {regime: 'UNKNOWN', confidence: 0, metrics: {}};
    }
    var closes = mktHist.map(function(h){return h.c;});
    var n = closes.length;

    var ma200Period = Math.min(200, n - 1);
    var ma200 = closes.slice(-ma200Period).reduce(function(a,b){return a+b;}) / ma200Period;
    var ma200Dist = (closes[n-1] - ma200) / ma200;

    var mom5  = n >= 6  ? (closes[n-1] - closes[n-6])  / closes[n-6]  : 0;
    var mom20 = n >= 21 ? (closes[n-1] - closes[n-21]) / closes[n-21] : 0;
    var mom60 = n >= 61 ? (closes[n-1] - closes[n-61]) / closes[n-61] : mom20;

    var rets = [];
    for(var i = 1; i < closes.length; i++){
      rets.push((closes[i] - closes[i-1]) / closes[i-1]);
    }
    var stdOf = function(arr){
      if(arr.length < 2) return 0;
      var m = arr.reduce(function(a,b){return a+b;}) / arr.length;
      return Math.sqrt(arr.reduce(function(a,r){return a+Math.pow(r-m,2);},0) / arr.length);
    };
    var vol20 = stdOf(rets.slice(-20));
    var vol60 = stdOf(rets.slice(-60));
    var volRatio = vol60 > 0 ? vol20 / vol60 : 1;

    var regime;
    if(volRatio > 1.6){
      regime = 'HIGH_VOL';
    } else if(ma200Dist > 0.02 && mom20 > 0.02){
      regime = 'BULL_TREND';
    } else if(ma200Dist > 0.02 && mom20 < -0.03){
      regime = 'DISTRIBUTION';
    } else if(ma200Dist < -0.02 && mom20 < -0.02){
      regime = 'BEAR_TREND';
    } else if(ma200Dist < -0.02 && mom20 > 0.03){
      regime = 'RECOVERY';
    } else if(Math.abs(mom20) < 0.02 && volRatio < 1.1){
      regime = 'RANGE';
    } else {
      regime = mom20 > 0 ? 'BULL_TREND' : 'BEAR_TREND';
    }

    var confidence = 0.5;
    if(regime === 'BULL_TREND' && ma200Dist > 0.05 && mom20 > 0.05) confidence = 0.9;
    if(regime === 'BEAR_TREND' && ma200Dist < -0.05 && mom20 < -0.05) confidence = 0.9;
    if(regime === 'HIGH_VOL' && volRatio > 2.0) confidence = 0.95;
    if(regime === 'RANGE' && Math.abs(mom20) < 0.01) confidence = 0.85;

    return {
      regime: regime,
      confidence: +confidence.toFixed(2),
      metrics: {
        ma200Dist: +ma200Dist.toFixed(3),
        mom5: +mom5.toFixed(3), mom20: +mom20.toFixed(3), mom60: +mom60.toFixed(3),
        vol20: +vol20.toFixed(4), vol60: +vol60.toFixed(4), volRatio: +volRatio.toFixed(2)
      }
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  [6] 產業相對強弱
  // ══════════════════════════════════════════════════════════════════
  function detectSectorRegime(sectorStockHists, mktHist){
    if(!sectorStockHists || !sectorStockHists.length || !mktHist || mktHist.length < 30){
      return {regime: 'UNKNOWN', relStrength: 0};
    }
    var lookback = 20;
    var sectorMoms = sectorStockHists.map(function(hist){
      if(!hist || hist.length < lookback + 1) return null;
      var c = hist[hist.length - 1].c;
      var c0 = hist[hist.length - 1 - lookback].c;
      return (c - c0) / c0;
    }).filter(function(m){return m !== null;});

    if(!sectorMoms.length) return {regime: 'UNKNOWN', relStrength: 0};
    var sectorMom = sectorMoms.reduce(function(a,b){return a+b;}) / sectorMoms.length;

    var mc = mktHist.map(function(h){return h.c;});
    var mn = mc.length;
    var mktMom = mn >= lookback + 1 ? (mc[mn-1] - mc[mn-1-lookback]) / mc[mn-1-lookback] : 0;

    var diff = sectorMom - mktMom;
    var regime = diff > 0.03 ? 'STRONG' : diff < -0.03 ? 'WEAK' : 'NEUTRAL';
    return {
      regime: regime, relStrength: +diff.toFixed(3),
      sectorMom: +sectorMom.toFixed(3), mktMom: +mktMom.toFixed(3)
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  [7] Regime Key
  // ══════════════════════════════════════════════════════════════════
  function regimeKey(marketRegime, sectorRegime){
    if(marketRegime === 'BULL_TREND' && sectorRegime === 'STRONG') return 'BULL_STRONG';
    if(marketRegime === 'BULL_TREND') return 'BULL';
    if(marketRegime === 'BEAR_TREND') return 'BEAR';
    if(marketRegime === 'HIGH_VOL') return 'HIGH_VOL';
    if(marketRegime === 'RANGE') return 'RANGE';
    if(marketRegime === 'RECOVERY' || marketRegime === 'DISTRIBUTION') return 'TRANSITION';
    return 'unknown';
  }

  // ══════════════════════════════════════════════════════════════════
  //  [8] 動態策略選擇器
  // ══════════════════════════════════════════════════════════════════
  function selectStrategy(rkey){
    var map = {
      BULL_STRONG: {primary: 'trend',     maxExposure: 0.80, minWR: 55},
      BULL:        {primary: 'trend',     maxExposure: 0.60, minWR: 58},
      BEAR:        {primary: 'cash',      maxExposure: 0.10, minWR: 70},
      HIGH_VOL:    {primary: 'meanRev',   maxExposure: 0.30, minWR: 60},
      RANGE:       {primary: 'meanRev',   maxExposure: 0.40, minWR: 60},
      TRANSITION:  {primary: 'defensive', maxExposure: 0.30, minWR: 65},
      unknown:     {primary: 'defensive', maxExposure: 0.20, minWR: 65}
    };
    return map[rkey] || map.unknown;
  }

  // ══════════════════════════════════════════════════════════════════
  //  信心校準(regime-conditional)
  // ══════════════════════════════════════════════════════════════════
  function calibrateConfidence(symbol, bt, rkey){
    rkey = rkey || 'unknown';
    var stockOOS = OOS[symbol] || {};
    var rec = stockOOS[rkey] || {hits:0, total:0, hist:[]};
    var n = rec.total;
    var wr = n > 0 ? rec.hits / n : 0.5;

    var z = 1.645;
    var lower = 0, upper = 1;
    if(n > 0){
      var denom = 1 + z*z/n;
      var center = (wr + z*z/(2*n)) / denom;
      var spread = z * Math.sqrt(wr*(1-wr)/n + z*z/(4*n*n)) / denom;
      lower = Math.max(0, center - spread);
      upper = Math.min(1, center + spread);
    }

    var strat = selectStrategy(rkey);
    var minWRThresh = (strat.minWR - 5) / 100;
    var midWRThresh = Math.max(0.45, minWRThresh - 0.07);

    var level, shouldTrade;
    if(n < 8){
      level = 'none'; shouldTrade = false;
    } else if(lower >= minWRThresh){
      level = 'high'; shouldTrade = true;
    } else if(lower >= midWRThresh){
      level = 'mid';
      shouldTrade = bt && bt.s10 && bt.s10.wr >= strat.minWR;
    } else {
      level = 'low'; shouldTrade = false;
    }

    return {
      level: level, wr: Math.round(wr * 100), n: n,
      ci: [Math.round(lower*100), Math.round(upper*100)],
      shouldTrade: shouldTrade, rkey: rkey, strategy: strat.primary
    };
  }

  function recordOOS(symbol, rkey, predicted, actual, ret){
    rkey = rkey || 'unknown';
    if(!OOS[symbol]) OOS[symbol] = {};
    if(!OOS[symbol][rkey]) OOS[symbol][rkey] = {hits:0, total:0, hist:[]};
    var rec = OOS[symbol][rkey];
    var correct = (predicted === actual);
    rec.hits += correct ? 1 : 0;
    rec.total += 1;
    rec.hist.push({t: Date.now(), p: predicted, a: actual, r: ret, c: correct});
    if(rec.hist.length > 200) rec.hist = rec.hist.slice(-200);
    persistOOS();
  }

  // ══════════════════════════════════════════════════════════════════
  //  Regime-aware filter
  // ══════════════════════════════════════════════════════════════════
  function regimeFilter(bt, marketRegime){
    if(!bt || bt.curADX14 == null){
      return {action: 'abstain', reason: 'no_adx_data'};
    }
    var adx = bt.curADX14;
    var bbPos = bt.curBBpos != null ? bt.curBBpos : 0.5;
    var rsi = bt.curRSI || 50;

    if(marketRegime === 'BEAR_TREND'){
      if(!bt.s10 || bt.s10.wr < 70 || adx < 25){
        return {action: 'abstain', reason: 'bear_market_no_strong_signal'};
      }
      return {action: bt.s10.wr >= 50 ? 'buy' : 'sell', reason: 'bear_strong_signal', strategy: 'defensive'};
    }
    if(marketRegime === 'HIGH_VOL'){
      if(bbPos < 0.15 && rsi < 30) return {action: 'buy', reason: 'high_vol_oversold', strategy: 'meanRev'};
      if(bbPos > 0.85 && rsi > 70) return {action: 'sell', reason: 'high_vol_overbought', strategy: 'meanRev'};
      return {action: 'abstain', reason: 'high_vol_no_extreme'};
    }
    if(adx < 18) return {action: 'abstain', reason: 'range_market', adx: adx};
    if(adx < 20){
      if(bbPos < 0.2 && rsi < 35) return {action: 'buy', reason: 'mean_reversion_oversold', strategy: 'meanRev'};
      if(bbPos > 0.8 && rsi > 65) return {action: 'sell', reason: 'mean_reversion_overbought', strategy: 'meanRev'};
      return {action: 'abstain', reason: 'weak_trend_no_extreme'};
    }
    if(adx < 25){
      if(!bt.s10 || bt.s10.wr < 60) return {action: 'abstain', reason: 'transition_weak_signal'};
      return {action: bt.s10.wr >= 50 ? 'buy' : 'sell', reason: 'transition_strong', strategy: 'trend'};
    }
    if(!bt.s10) return {action: 'abstain', reason: 'no_backtest'};
    return {action: bt.s10.wr >= 50 ? 'buy' : 'sell', reason: 'trend_market', strategy: 'trend', adx: adx};
  }

  // ══════════════════════════════════════════════════════════════════
  //  Purged Walk-Forward(每 fold 帶 regime label)
  // ══════════════════════════════════════════════════════════════════
  function purgedWalkForward(hist, runBacktest, mktHist, opts){
    opts = opts || {};
    var trainMin  = opts.trainMin  || 250;
    var testDays  = opts.testDays  || 10;
    var purgeDays = opts.purgeDays || 10;
    var stepDays  = opts.stepDays  || 21;

    var folds = [];
    var n = hist.length;

    for(var te = trainMin; te <= n - testDays - purgeDays; te += stepDays){
      var trainData = hist.slice(0, te);
      var testStart = te + purgeDays;
      var testEnd   = testStart + testDays;
      if(testEnd > n) break;

      var mktSlice = (mktHist && mktHist.length) ? mktHist.slice(0, Math.min(te, mktHist.length)) : null;
      var mr = detectMarketRegime(mktSlice || trainData);
      var rkey = regimeKey(mr.regime, 'NEUTRAL');

      var bt = runBacktest(trainData, {}, mktSlice);
      if(!bt || !bt.s10 || bt.s10.n < 8) continue;

      var gate = regimeFilter(bt, mr.regime);
      if(gate.action === 'abstain') continue;

      var p0  = trainData[trainData.length - 1].c;
      var p10 = hist[testEnd - 1].c;
      var ret = (p10 - p0) / p0 * 100;
      var actual = ret > 0 ? 'up' : 'down';
      var predicted = gate.action === 'buy' ? 'up' : 'down';

      folds.push({
        trainEnd: te, testStart: testStart, adx: bt.curADX14,
        marketRegime: mr.regime, regimeKey: rkey, wrInSample: bt.s10.wr,
        predicted: predicted, actual: actual, ret: +ret.toFixed(2),
        correct: predicted === actual, strategy: gate.strategy, n: bt.s10.n
      });
    }

    if(!folds.length) return {folds: [], summary: null, byRegime: {}};

    var correct = folds.filter(function(f){return f.correct;}).length;
    var rets = folds.map(function(f){return f.ret;});
    var meanR = rets.reduce(function(a,b){return a+b;},0) / rets.length;
    var stdR = Math.sqrt(rets.reduce(function(a,r){return a+Math.pow(r-meanR,2);},0) / rets.length);
    var sharpe = stdR > 0 ? meanR / stdR : 0;

    var byRegime = {};
    folds.forEach(function(f){
      var k = f.regimeKey;
      if(!byRegime[k]) byRegime[k] = {n:0, correct:0, retSum:0};
      byRegime[k].n++;
      byRegime[k].correct += f.correct ? 1 : 0;
      byRegime[k].retSum += f.ret;
    });
    Object.keys(byRegime).forEach(function(k){
      var r = byRegime[k];
      r.acc = Math.round(r.correct / r.n * 100);
      r.avgRet = +(r.retSum / r.n).toFixed(2);
    });

    return {
      folds: folds, byRegime: byRegime,
      summary: {
        n: folds.length, accuracy: Math.round(correct / folds.length * 100),
        avgReturn: +meanR.toFixed(2), sharpe: +sharpe.toFixed(2)
      }
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  Position sizing(regime-aware)
  // ══════════════════════════════════════════════════════════════════
  function sizePosition(stock, bt, conf, opts){
    opts = opts || {};
    var bankroll = opts.bankroll || 1000000;
    var kellyFraction = opts.kellyFraction || 0.25;

    if(!conf || !conf.shouldTrade) return {weight: 0, shares: 0, reason: 'no_trade_signal'};
    if(!bt || !bt.s10) return {weight: 0, shares: 0, reason: 'no_backtest_data'};

    var strat = selectStrategy(conf.rkey || 'unknown');
    var maxPos = opts.maxPos || (strat.maxExposure / 5);

    var p = conf.ci[0] / 100;
    var q = 1 - p;
    var avgWin = bt.s10.avg > 0 ? bt.s10.avg : 5;
    var avgLoss = bt.s10.std || 5;
    var b = avgLoss > 0 ? avgWin / avgLoss : 1;
    var kelly = b > 0 ? Math.max(0, (p * b - q) / b) : 0;

    var stockAnnVol = bt.s10.std ? bt.s10.std / 10 * Math.sqrt(252/10) / 100 : 0.3;
    var targetVol = 0.20;
    var volScale = stockAnnVol > 0 ? Math.min(1, targetVol / stockAnnVol) : 1;
    var confMult = conf.level === 'high' ? 1.0 : conf.level === 'mid' ? 0.5 : 0;

    var rawWeight = kelly * kellyFraction * volScale * confMult;
    var weight = Math.min(maxPos, rawWeight);
    var dollars = bankroll * weight;
    var shares = stock.price > 0 ? Math.floor(dollars / stock.price) : 0;

    return {
      weight: +weight.toFixed(4), shares: shares, dollars: Math.round(dollars),
      kelly: +kelly.toFixed(3), volScale: +volScale.toFixed(3),
      confMult: confMult, maxPos: maxPos, regime: conf.rkey, reason: 'sized'
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  compositeV2(主入口)
  // ══════════════════════════════════════════════════════════════════
  function compositeV2(symbol, liveScore, bt, mktHist, sectorPeers){
    if(!bt || !bt.s10) return {score: liveScore, conf: null, gate: null, regime: null};

    var mr = mktHist ? detectMarketRegime(mktHist) : {regime: 'unknown', confidence: 0, metrics: {}};
    var sr = sectorPeers ? detectSectorRegime(sectorPeers, mktHist) : {regime: 'NEUTRAL', relStrength: 0};
    var rkey = regimeKey(mr.regime, sr.regime);

    var conf = calibrateConfidence(symbol, bt, rkey);
    var gate = regimeFilter(bt, mr.regime);

    if(gate.action === 'abstain'){
      return {
        score: 50, conf: conf, gate: gate,
        marketRegime: mr, sectorRegime: sr, rkey: rkey,
        explain: gate.reason + ' (mr=' + mr.regime + ')'
      };
    }

    var oosN = conf.n;
    var btWeight = oosN < 5 ? 0.20 : oosN < 15 ? 0.40 : oosN < 30 ? 0.55 : 0.65;
    var liveWeight = 1 - btWeight;

    var calibratedWR = oosN >= 8 ? conf.ci[0] : bt.s10.wr;
    var btScore = calibratedWR >= 65 ? 90 : calibratedWR >= 55 ? 70 : calibratedWR >= 50 ? 55 : calibratedWR >= 45 ? 35 : 15;

    var composite = Math.round(liveScore * liveWeight + btScore * btWeight);

    if(mr.regime === 'BEAR_TREND')   composite = Math.round(composite * 0.7 + 50 * 0.3);
    if(mr.regime === 'DISTRIBUTION') composite = Math.round(composite * 0.85);
    if(rkey === 'BULL_STRONG' && conf.level === 'high') composite = Math.min(100, composite + 5);

    if(conf.level === 'low')  composite = Math.round(composite * 0.5 + 50 * 0.5);
    if(conf.level === 'none') composite = 50;

    return {
      score: Math.max(0, Math.min(100, composite)),
      conf: conf, gate: gate,
      marketRegime: mr, sectorRegime: sr, rkey: rkey,
      btWeight: btWeight, btScore: btScore,
      explain: 'regime=' + rkey + ' | conf=' + conf.level + ' (n=' + oosN + ') | gate=' + gate.action
    };
  }

  global.QuantexOpt = {
    calibrateConfidence: calibrateConfidence,
    regimeFilter: regimeFilter,
    purgedWalkForward: purgedWalkForward,
    sizePosition: sizePosition,
    compositeV2: compositeV2,
    detectMarketRegime: detectMarketRegime,
    detectSectorRegime: detectSectorRegime,
    regimeKey: regimeKey,
    selectStrategy: selectStrategy,
    recordOOS: recordOOS,
    _getOOS: function(){ return OOS; },
    _resetOOS: function(){ for(var k in OOS) delete OOS[k]; persistOOS(); },
    _exportOOS: function(){ return JSON.stringify(OOS); },
    _importOOS: function(json){ try { OOS = JSON.parse(json); persistOOS(); return true; } catch(e){ return false; } },
    version: '2.0'
  };
})(typeof window !== 'undefined' ? window : this);
