# Testing / 測試

This project has two test tiers. / 本專案有兩層測試。

| Tier / 層 | What it covers / 覆蓋範圍 | Externals / 外部依賴 | Speed / 速度 |
|---|---|---|---|
| **Tier 1 — fast** / 快速 | Pure logic: formatter, schedule math, analyzer JSON/fallback, keywords | None (Anthropic SDK mocked) / 無 | **seconds / 秒** |
| **Tier 2 — live** / 實時 | Real WhatsApp connect/ready, scrape, full `runScan`, reconnect | Real WhatsApp + Chrome + Claude + SMTP / 全真實 | minutes / 分鐘 |

---

## Tier 1 — fast (default) / 快速層（預設）

```bash
npm test            # run once / 跑一次
npm run test:watch  # watch mode / 監看模式
```

Run only what you changed / 只跑你改動的部分:

```bash
npm test -- formatter          # only formatter.test.ts
npm test -- -t "fallback"      # only tests whose name matches "fallback"
```

These never touch WhatsApp, so editing the real `CRON_SCHEDULE` (9am/5pm) never
affects them and they never wait for a cron tick — schedule tests inject their
own times.
這些測試不碰 WhatsApp，所以改動真實的 `CRON_SCHEDULE`（早上9點/下午5點）不會影響它們，
也不會等 cron 觸發 —— 調度測試會注入自己的時間。

**Workflow / 工作流:** edit code → `npm test -- <area>` → result in seconds.
改完代碼 → `npm test -- <範圍>` → 幾秒出結果。

---

## Tier 2 — live (on demand) / 實時層（按需）

Real account, **read-only** on your groups. Gated by `LIVE_TESTS` so it never
runs by accident.
真實帳號，對群組**唯讀**。由 `LIVE_TESTS` 門控，不會誤觸發。

### Prerequisites / 前置條件
1. A valid session in `.wwebjs_auth` — run `npm run dev` once and scan the QR.
   `.wwebjs_auth` 內有有效會話 —— 先跑一次 `npm run dev` 掃碼。
2. `.env` populated (`ANTHROPIC_API_KEY`, `SMTP_*`, `CRON_SCHEDULE`, …).
3. `LIVE_TEST_EMAIL` — a safe inbox the report is redirected to (real recipients
   are never emailed during tests). / 報告改寄到的安全信箱（測試期間不會寄給真實收件人）。

### Run / 執行

**PowerShell** (this machine's default / 本機預設):
```powershell
$env:LIVE_TESTS=1; $env:LIVE_TEST_EMAIL="you@example.com"; npm run test:live
```

**Bash / Git Bash:**
```bash
LIVE_TESTS=1 LIVE_TEST_EMAIL=you@example.com npm run test:live
```

Without `LIVE_TESTS`, `npm run test:live` simply skips all live tests.
不設 `LIVE_TESTS` 時，`npm run test:live` 會跳過所有實時測試。

### What it checks (in order) / 檢查項目（依序）
1. **Ready** — reaches the WhatsApp `ready` state (the flaky path). / 達到就緒狀態。
2. **Scrape** — real groups return a well-formed `ScanResult`. / 真實抓取結構完整。
3. **Pipeline** — full `runScan`: WhatsApp → Claude → email to `LIVE_TEST_EMAIL`. / 全流水線。
4. **Reconnect** — recovers readiness after a forced disconnect. / 斷線後恢復就緒。

### Run a single live test / 單獨執行某個實時測試
Filter by name with `-t`. Only **test 3** needs `LIVE_TEST_EMAIL`.
用 `-t` 按名稱過濾。只有 **測試 3** 需要 `LIVE_TEST_EMAIL`。

**PowerShell:**
```powershell
# 1 — Ready / 就緒
$env:LIVE_TESTS=1; npm run test:live -- -t "ready state"

# 2 — Scrape / 抓取 (read-only / 唯讀)
$env:LIVE_TESTS=1; npm run test:live -- -t "scrapes real groups"

# 3 — Full pipeline / 全流水線 (sends email to your test inbox / 會寄到測試信箱)
$env:LIVE_TESTS=1; $env:LIVE_TEST_EMAIL="you@example.com"; npm run test:live -- -t "full scan pipeline"

# 4 — Reconnect / 重連
$env:LIVE_TESTS=1; npm run test:live -- -t "recovers readiness"
```

**Bash / Git Bash:**
```bash
LIVE_TESTS=1 npm run test:live -- -t "ready state"            # 1
LIVE_TESTS=1 npm run test:live -- -t "scrapes real groups"    # 2
LIVE_TESTS=1 LIVE_TEST_EMAIL=you@example.com npm run test:live -- -t "full scan pipeline"  # 3
LIVE_TESTS=1 npm run test:live -- -t "recovers readiness"     # 4
```

> **Note / 注意:** even when filtering to one test, `beforeAll` still boots Chrome
> and connects to WhatsApp first (can take a minute+). The filter only narrows
> which assertions run, not the connection setup.
> 即使只過濾一個測試，`beforeAll` 仍會先啟動 Chrome 並連接 WhatsApp（可能要一分鐘以上）。
> 過濾只縮小執行哪些斷言，不影響連接初始化。

---

## Layout / 目錄結構
```
tests/
  fixtures/builders.ts        # message / entry builders (Tier 1)
  unit/                       # Tier 1 — fast
    schedule.test.ts
    keywords.test.ts
    formatter.test.ts
    analyzer.test.ts
  live/                       # Tier 2 — live
    setup.ts                  # loads .env
    integration.test.ts
vitest.config.mts             # Tier 1 config (default)
vitest.live.config.mts        # Tier 2 config
```
