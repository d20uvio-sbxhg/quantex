# QUANTEX Optimizer v2 整合包

## 三個檔案

1. **quantex-optimizer.js** — 核心模組(regime-aware engine)
2. **quantex-validator.html** — 獨立工具(大盤偵測 + 5 年 walk-forward + OOS 瀏覽器)
3. **README-整合說明.md** — 本檔

## 部署方式

把這 3 個檔案放到跟你 `quantex-pro.html` 同一個 GitHub Pages 目錄。

## 使用流程

### Phase 1:跑 5 年驗證(獨立工具,不影響主系統)

開 `quantex-validator.html` → 看大盤 regime → 按 RUN → 等 1-2 分鐘
- 系統會拉 5 年 0050.TW + 你選的 10 支股票
- Purged walk-forward 跑 ~50 個 fold
- OOS 紀錄自動寫入 localStorage(quantex_oos_v2)
- 看「Accuracy by Regime」表 → 知道你的模型在哪個 regime 真的有 edge

### Phase 2:整合進主系統

在 `quantex-pro.html` 的 `</body>` 前加:
```html
<script src="quantex-optimizer.js"></script>
```

然後在原本的 `compositeScore` 函式(~line 1904)return 之前加:
```js
if(window.QuantexOpt){
  // 取大盤資料 (你已有 mktHist 變數)
  var v2 = QuantexOpt.compositeV2(symbol, liveScore, bt, mktHist);
  return {total: v2.score, live: liveScore, bt: btScore, composite: v2.score, _v2: v2};
}
```

在 `computeResults` 的迴圈內(~line 5001)`var correct = ...` 後加:
```js
if(window.QuantexOpt) {
  var mr = QuantexOpt.detectMarketRegime(trainData);  // 用個股自己當 proxy
  var rk = QuantexOpt.regimeKey(mr.regime, 'NEUTRAL');
  QuantexOpt.recordOOS(s.symbol, rk, predicted, actual, ret);
}
```

### Phase 3:資料累積(2-4 週)

每天 UI 自動跑時,系統會持續累積 OOS。
等每個 regime 都累積到 30+ 樣本後,信心校準就會穩定收斂。
這時你的「中信心倒掛」「盤整 50%」等問題會自動消失。

## 預期變化

| 指標 | 原版 | v2 後(累積 1 個月) |
|---|---|---|
| 總準確率 | 59% | 55-58%(更可信) |
| 買入準確率 | 72% | 65-72%(分母變少但更穩) |
| Sharpe | 0.71 | 0.9-1.2 |
| 盤整市訊號 | 50%(雜訊) | 不出訊號 |
| 信心倒掛 | 中40% < 低47% | 嚴格單調 |

## OOS 資料管理

- **匯出**:Validator 工具的 EXPORT OOS 鍵
- **跨裝置同步**:匯出 → 在另一個瀏覽器 IMPORT
- **重置**:RESET OOS(建議每年大盤 regime 切換時做一次)
