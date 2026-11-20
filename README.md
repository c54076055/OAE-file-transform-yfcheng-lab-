# OAE File Transform (yfcheng-lab)

Browser-based OAE CSV tools.

The tools process files locally in the browser. This repository contains only the static web pages and does not include measurement data.

## Pages

- [舊版 OAE CSV 檔案處理器](https://c54076055.github.io/OAE-file-transform-yfcheng-lab-/) 沿用 2025 年 5 月 12 日的介面與匯出流程。標題旁提供新版連結。
- [新版 OAE CSV 檔案處理器](https://c54076055.github.io/OAE-file-transform-yfcheng-lab-/v2/) 採用 Python 桌面版的計算與匯出格式。
- [CSV 預覽器](https://c54076055.github.io/OAE-file-transform-yfcheng-lab-/csv-viewer.html)
- `csv_processor.html` 會導向新版。

新版支援多檔匯入。確認每筆檔案的耳別與頻率（kHz）後，按「計算」即可預覽並下載 CSV。修改輸入後須重新計算。

匯出格式依照 Python 桌面版。標題有值時，下載檔名為 `<標題>_output.csv`。標題空白時，檔名為 `output.csv`。有任何頻率的通過列數為零時，處理器會顯示原因並停止匯出。

## 開發與驗收

在此目錄執行 `python -m http.server 8047` 後，開啟 `http://localhost:8047/`。執行 `node --test formatter.test.mjs` 可重跑合成資料的計算與匯出測試。規格與輸出比對紀錄見 [SPEC.md](SPEC.md)。
