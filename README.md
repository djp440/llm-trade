# llm-trade

基于 **LLM + Al Brooks 价格行为（Price Action）** 的自动化交易实验项目：使用 **CCXT** 对接交易所（默认 Bitget），在每根 K 线收盘后拉取行情，构造上下文请求大模型（DeepSeek / 任何 OpenAI API 兼容端点），由模型输出严格 JSON 信号，并由程序执行突破单/市价单及止盈止损。

> 风险提示：本项目包含真实下单能力。请务必先在模拟盘运行，并自行评估交易风险。作者不对任何资金损失负责。

## 功能特性

- **多交易对并行**：按 `config.toml` 中的 `symbols.active` 并行启动交易循环
- **收盘驱动**：按 `strategy.timeframe` 等待 K 线收盘 + 缓冲后再分析
- **LLM 信号输出**：大模型按严格 JSON 输出 `APPROVE/REJECT`、`BUY/SELL`、入场/止损/止盈
- **风险仓位计算**：基于账户权益与单笔风险比例计算下单数量，并应用交易所精度/最小名义价值校验
- **突破单逻辑**：价格未到达入场位时走触发单（Stop）；已突破则走市价兜底
- **挂单复核**：挂单未成交时，周期性请求 LLM 决定 `KEEP/CANCEL`
- **日志落盘**：默认写入 `./logs/log_YYYY-MM-DD_HH-mm-ss.log`

## 技术栈

- Node.js + TypeScript
- 交易所：CCXT
- LLM：OpenAI SDK（可配置 DeepSeek/其他兼容端点）
- 配置：`.env`（敏感信息）+ `config.toml`（策略参数，TOML）

## 快速开始

> 运行环境：建议使用 Node.js LTS（>= 18）。

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

从示例复制一份 `.env`：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

关键字段（示例见 [.env.example](./.env.example)）：

- `EXCHANGE_ID`：交易所 id（默认 `bitget`）
- `IS_SANDBOX`：`true` 使用模拟盘；`false` 使用实盘
- `DEMO_API_KEY/DEMO_API_SECRET/DEMO_API_PASSWORD`：模拟盘密钥（Bitget 需要 passphrase 时使用）
- `PROD_API_KEY/PROD_API_SECRET/PROD_API_PASSWORD`：实盘密钥
- `LLM_PROVIDER/LLM_API_KEY/LLM_BASE_URL/LLM_MODEL`：LLM 连接配置

### 3) 配置策略参数

从示例复制一份 `config.toml`：

```bash
cp config.toml.example config.toml
```

Windows PowerShell：

```powershell
Copy-Item config.toml.example config.toml
```

常用字段（示例见 [config.toml.example](./config.toml.example)）：

- `strategy.timeframe`：K 线周期（如 `15m`）
- `strategy.lookback_candles`：回看 K 线数量
- `strategy.risk_per_trade`：单笔风险（百分比制，示例 `1.0` 表示 1%）
- `symbols.active`：启用的交易对列表（如 `SOL/USDT:USDT`）
- `execution.min_notional`：最小名义价值（USDT）

### 4) 启动

```bash
npm start
```

程序入口为 [src/index.ts](./src/index.ts)。启动时会依次：加载配置 → 初始化交易所 → 测试连接 → 测试 LLM 连接 → 启动每个交易对的循环。

## 运行脚本

### 类型检查

```bash
npm run check
```

### Bitget 计划委托附带止盈止损（E2E 验证）

脚本见 [src/scripts/bitget-plan-tpsl-e2e.ts](./src/scripts/bitget-plan-tpsl-e2e.ts)，文档见 [doc/bitget-plan-tpsl-e2e.md](./doc/bitget-plan-tpsl-e2e.md)。

```bash
npx ts-node src/scripts/bitget-plan-tpsl-e2e.ts --scenario all
```

## 项目结构

```text
llm-trade/
  src/
    config/           # .env + config.toml 加载与类型
    executor/         # 下单与止盈止损执行
    llm/              # Prompt 构建、LLM 调用、信号解析
    market/           # 行情拉取与交易所封装
    monitor/          # 持仓/订单监控（扩展点）
    scripts/          # 独立验证/调试脚本
    utils/            # 日志、指标、图表等工具
    index.ts          # 主入口
    trade-manager.ts  # 状态机交易循环
  doc/                # 开发/验证文档
  .env.example
  config.toml.example
```

## 交易流程概览

每个交易对运行一个状态机（见 [TradeManager](./src/trade-manager.ts)）：

1. 等待 K 线收盘（基于交易所服务器时间）
2. 拉取“已确认收盘”的 OHLC（避免未收盘数据干扰）
3. 获取账户权益（默认按 USDT 口径）
4. 请求 LLM 输出交易信号（严格 JSON）
5. 生成交易计划并执行（突破触发单 / 市价兜底；止盈止损参数随单携带）
6. 挂单未成交则在下一周期请求 LLM 复核并决定是否取消

## 常见问题

### 启动时报错无法加载 config.toml

`config.toml` 为必需文件。请确认已执行：

```bash
cp config.toml.example config.toml
```

Windows PowerShell：

```powershell
Copy-Item config.toml.example config.toml
```

### 交易所连接失败 / 权限不足

- 确认 `.env` 中 `IS_SANDBOX` 与 API Key 类型一致
- 确认合约/现货权限、IP 白名单、passphrase 等配置完整
- 建议先运行 `bitget-plan-tpsl-e2e` 脚本验证下单与查询链路

### LLM 连接失败

- 确认 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` 正确
- 若使用非 DeepSeek 的 OpenAI 兼容服务，请确保返回格式与 OpenAI SDK 兼容

## 安全建议

- 不要提交 `.env`、`config.toml`、`logs/` 到仓库（已在 `.gitignore` 中忽略）
- 强烈建议仅在模拟盘测试；实盘运行前请添加更严格的风控与回撤保护
- 不要在共享机器/CI 中暴露密钥

## 文档

- 开发设计文档：[doc/DEV_DOC.md](./doc/DEV_DOC.md)
- 已完成工作记录：[doc/Completed.md](./doc/Completed.md)

## 未来计划

1. **持仓过程中通过 LLM 动态管理仓位**：在持仓期间，由 LLM 根据最新 K 线动态调整止盈止损或主动减仓/平仓。
2. **多 Agent 协同分析**：引入多个 Agent（如：趋势专家、波动率专家、宏观专家）共同参与决策，提高信号质量。
3. **前端面板**：开发 Web 端 UI 面板，实现交易监控、资产统计、策略配置的可视化。

## License

本项目使用 Apache-2.0 许可证，详见 [LICENSE](./LICENSE)。
