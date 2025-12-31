# Bitget 合约计划委托附带止盈止损（CCXT）验证脚本

## 目标

验证在 Bitget 合约交易（模拟盘）中，通过 CCXT 下达“计划委托”（触发单）时，能够在同一笔计划委托上附加止盈止损参数，并能通过接口查询到对应字段。

脚本文件：

- [bitget-plan-tpsl-e2e.ts](file:///f:/project/llm-trade/src/scripts/bitget-plan-tpsl-e2e.ts)

## 前置条件

1. Node.js + npm 已安装。
2. 项目依赖已安装：

```bash
npm install
```

3. 模拟盘环境变量（脚本通过 [config.ts](file:///f:/project/llm-trade/src/config/config.ts) 读取）：

- `IS_SANDBOX=true`
- `EXCHANGE_ID=bitget`（可选，默认 bitget）
- `DEMO_API_KEY=...`
- `DEMO_API_SECRET=...`
- `DEMO_API_PASSWORD=...`（如果你的 API Key 需要 passphrase）

## 运行方式

从项目根目录运行：

```bash
npx ts-node src/scripts/bitget-plan-tpsl-e2e.ts --scenario all
```

常用场景：

```bash
# 只跑“成功附加止盈止损”的计划委托
npx ts-node src/scripts/bitget-plan-tpsl-e2e.ts --scenario success

# 只跑“无效参数”的错误处理
npx ts-node src/scripts/bitget-plan-tpsl-e2e.ts --scenario invalid

# 只跑“订单状态查询”（可传入已有的 orderId/clientOid）
npx ts-node src/scripts/bitget-plan-tpsl-e2e.ts --scenario query --orderId <orderId>
```

## 参数说明

- `--scenario`: `success | invalid | query | all`，默认 `all`
- `--symbol`: 交易对（统一符号），例如 `ETH/USDT:USDT`。不传则自动挑选一个 USDT 永续（优先 ETH，其次 BTC）
- `--amount`: 下单数量，不传则使用交易所最小数量或 `0.01`
- `--side`: `buy | sell`，仅对 `success` 场景生效，默认 `buy`
- `--pollSeconds`: 查询轮询总时长（秒），默认 `20`
- `--pollIntervalMs`: 查询轮询间隔（毫秒），默认 `2000`
- `--keepOrder`: 传入该开关表示不撤销创建的计划委托（默认会在查询场景结束时尝试撤销）
- `--orderId`: 在 `query` 场景中指定计划委托 `orderId`
- `--clientOid`: 在 `query` 场景中指定计划委托 `clientOid`

## 验证点（对应 Bitget API 与 CCXT 行为）

1. 下单

- 使用 `exchange.createOrder(symbol, 'market', side, amount, undefined, params)`
- 通过 `params.triggerPrice` 触发 CCXT 将请求路由至 Bitget 的 `v2/mix/order/place-plan-order`
- 通过 `params.stopLoss` / `params.takeProfit`（对象）让 CCXT 组装并下发止盈止损字段（例如 `stopLossTriggerPrice`、`stopSurplusTriggerPrice` 等）

2. 验证

- 通过 Bitget 的 `获取当前计划委托` 接口对应的 CCXT 隐式方法 `privateMixGetV2MixOrderOrdersPlanPending`
- 在响应的 `entrustedList` 中按 `orderId/clientOid` 定位订单
- 验证字段存在且与下单时计算的止损/止盈触发价一致：
  - `stopLossTriggerPrice`
  - `stopSurplusTriggerPrice`

3. 查询与状态跟踪

- 周期性调用 `orders-plan-pending`，输出 `planStatus` 变化

## 日志与调试输出

- 脚本启用 CCXT `verbose` 并将其输出重定向到项目日志系统（`logs/` 目录），同时会对签名/密钥等敏感字段做脱敏
- 输出内容包括：
  - 原始下单参数（不包含密钥）
  - Bitget 接口请求与响应（verbose）
  - `orders-plan-pending` 原始请求参数与响应
  - 计划委托状态轮询与变更

查看最新日志：

- 目录：`logs/`
- 文件名：`log_YYYY-MM-DD_HH-mm-ss.log`

## 风险提示

- 脚本默认将触发价设置在当前价的较远位置（避免计划委托被意外触发）。但仍建议在模拟盘中运行。
- 如需彻底避免触发，可将 `--side buy` 场景下的触发价倍率进一步调高后再运行。
