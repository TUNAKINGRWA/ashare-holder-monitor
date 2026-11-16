# AGENTS.md — AI 协作与二次开发上下文指南

欢迎（适用于 **WorkBuddy**、Cursor、Claude Code、Trae、Windsurf、Codex 等 AI 智能体）！当用户要求你部署、启动或修改本项目时，请优先遵循以下架构说明与工程约束。

---

## 1. 技术栈与核心原则

- **运行环境**：Node.js `>= 20.0.0`（原生支持 `fetch`、ES Modules 与 `node:test`）。
- **零外部依赖（Zero npm dependencies）**：`package.json` 不依赖任何第三方 npm 包，克隆后**无需执行 `npm install`**，直接 `npm start` 即可运行。除非用户明确要求引入重型第三方 SDK，否则新增功能（如飞书/钉钉/企微 Webhook 推送、CSV 导出、自定义选股公式）请优先使用 Node.js 原生内置模块（`fetch`、`node:fs`、`node:crypto` 等）保持开箱即用。
- **三端自适应运行架构**：
  1. **本地常驻模式 (`local`)**：入口为 `src/server.mjs`（默认端口 `3688`，自动顺延空闲端口），使用 `SSE (/api/stream)` 毫秒级实时推送 + `src/tunnel.mjs` 免注册公网穿透。
  2. **Vercel 云函数模式 (`vercel`)**：入口为 `api/index.mjs` + `vercel.json`，使用 `/tmp/holder-monitor-data` 与 `data/seed-store.json` 预热。
  3. **纯静态网页模式 (`gh-pages`)**：前端 `public/app.js` 在无后端 `/api` 时自动切换至 `public/browserEngine.mjs`，在浏览器端跨域直连东方财富 CORS 接口。

---

## 2. 目录结构与职责映射（改哪里找哪个文件？）

```text
├── src/
│   ├── server.mjs            # 本地 HTTP + SSE 服务器入口（端口 3688，API 路由定义）
│   ├── monitor.mjs           # 核心调度中枢：五源轮询、多期时间轴融合、KPI统计、新披露告警触发
│   ├── parser.mjs            # 董秘问答 NLP 语义解析器（提取股东户数、截止日期、拒答/旧季报过滤、笔误纠偏）
│   ├── accuracy.mjs          # 16大类53组黄金对抗基准集 + 跨源真值自动对账引擎
│   ├── qrcode.mjs            # 零依赖离线 SVG 二维码生成器（供服务端使用）
│   ├── tunnel.mjs            # 局域网 IP 探测 + localhost.run / Pinggy 免注册 HTTPS 公网穿透
│   ├── exportSeeds.mjs       # 导出云端预热种子数据脚本 (npm run export-seeds)
│   └── fetchers/             # 五大实时数据源采集器
│       ├── eastmoney.mjs     # 东方财富股东户数中心 + F10底层库(补齐A+B/A+H股) + push2毫秒级实时行情
│       ├── szseIrm.mjs       # 深交所「互动易」一手董秘问答直连采集
│       ├── sseInfo.mjs       # 上交所「上证e互动」一手董秘问答直连采集
│       └── p5w.mjs           # 全景网沪深北投资者关系聚合采集
├── api/
│   └── index.mjs             # Vercel Serverless Functions 后端入口
├── public/
│   ├── index.html            # 看板主界面 HTML（响应式布局 + PWA 手机全屏支持）
│   ├── styles.css            # 桌面端与移动端样式表（色值变量集中在 :root）
│   ├── app.js                # 前端状态管理、筹码筛选排序、双轴 Canvas 趋势图、Web Audio 提示音
│   ├── browserEngine.mjs     # 纯浏览器端东财实时直连引擎（供 GitHub Pages 静态环境使用）
│   └── qrcode.mjs            # 浏览器端 SVG 二维码模块
├── test/
│   └── parser.test.mjs       # 单元测试与 53 组对抗基准验证套件
├── 启动监测看板.command       # macOS 双击一键启动脚本（含防休眠守护）
└── 启动监测看板_Windows.bat   # Windows 双击一键启动脚本
```

---

## 3. 高频二次开发修改锚点

1. **接入飞书 / 企业微信 / 钉钉 / Bark / Telegram 消息推送**：
   - 在 `src/monitor.mjs` 的 `poll()` 方法末尾，`newAlerts` 数组包含了本轮刚刚发现的所有新鲜有效股东户数披露（每项含 `stockCode`、`stockName`、`holderNum`、`holderChangeRatio`、`endDate`、`postCutoffChrate`、`answer`、`isWatched`）。
   - 直接在 `if (newAlerts.length > 0)` 处调用原生 `fetch(WEBHOOK_URL, { method: 'POST', ... })` 即可实现无人值守群消息推送。
2. **调整「筹码背离 / 黄金潜伏」或集中度筛选公式**：
   - 前端卡片过滤与排序逻辑位于 `public/app.js` 的 `isDivergenceItem(item)` 与 `filterAndSortItems()`。
   - 顶部 KPI 统计口径位于 `src/monitor.mjs` 的 `computeSummary()`（以及静态模式下的 `public/browserEngine.mjs`）。
   - 当前默认「黄金潜伏」定义为：`holderChangeRatio <= -2`（户数降 ≥ 2%），且统计期涨跌 `intervalChrate <= 3%`，且统计截止日后至今涨跌 `postCutoffChrate <= 3.5%`。
3. **新增数据源或调整轮询频率**：
   - 轮询间隔选项位于 `public/index.html` 的 `#intervalSelect`，最小下限校验位于 `src/monitor.mjs` 的 `updateSettings()`（当前允许 `15 ~ 3600` 秒）。
4. **修改解析规则（`src/parser.mjs`）时的铁律**：
   - 任何对 `src/parser.mjs` 正则或排除词的修改，**必须运行 `npm test`**，确保 53 组黄金对抗基准集保持 `100%` 通过率（零误报、零漏报）。

---

## 4. 常用命令与自检流程

```bash
# 1. 启动本地实时监测服务（默认 http://127.0.0.1:3688）
npm start

# 2. 开发热重载模式（修改后端代码自动重启）
npm run dev

# 3. 运行语法与 53 组黄金基准单元测试（修改代码后必跑！）
npm test
```
