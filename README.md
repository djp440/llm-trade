# LLM-Trade: AI 驱动的价格行为交易系统

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/runtime-Node.js-green.svg)](https://nodejs.org/)

**LLM-Trade** 是一个基于 **Al Brooks 价格行为学 (Price Action)** 的自动化交易实验项目。它结合了传统量化交易框架与现代大语言模型 (LLM)，利用任何兼容 OpenAI API 的模型的图表理解与逻辑推理能力，实现全自动的加密货币交易决策与执行。

> 👀 **使用建议**：建议您使用拥有视觉能力的 LLM 以获得完整分析功能。

> ⚠️ **风险提示**：本项目包含真实下单能力，请务必先在 **模拟盘 (Sandbox)** 环境下充分测试。**您需要自行评估交易风险，作者不对任何资金损失或财务风险负责**。

---

## 核心特性

- **🤖 LLM 驱动决策**：

  - 将 K 线数据转化为 **ASCII 图表** 与结构化数据，投喂给 LLM。
  - 由 LLM 分析市场背景、趋势与形态，输出严格的 JSON 交易信号 (`APPROVE`/`REJECT`)。
  - 支持 **DeepSeek**、OpenAI 等兼容 API。

- **⚡ 智能订单路由 ("沃尔玛交易法")**：

  - **突破单 (Stop Market)**：价格未突破信号 K 线高低点时，挂出触发单等待突破。
  - **市价单 (Market)**：若价格已突破，直接市价追入，避免踏空。
  - **自动风控**：下单同时自动关联 **止盈 (TP)** 与 **止损 (SL)** 委托。

- **🛡️ 严格风控管理**：

  - **动态仓位计算**：基于账户权益百分比 (Risk Per Trade) 与止损距离自动计算下单数量。
  - **交易所校验**：自动适配交易所的最小下单数量、精度限制与名义价值要求。

- **🔄 多币种并行**：

  - 基于状态机模型，支持同时监控多个交易对 (e.g., `BTC/USDT`, `ETH/USDT`)。
  - 独立的状态循环：收盘检测 -> 数据拉取 -> LLM 分析 -> 信号执行 -> 持仓监控。

- **📊 完备的工程化**：
  - **TypeScript** 开发，提供完整的类型安全。
  - **CCXT** 集成，支持 Bitget 等主流交易所（易于扩展）。
  - **TOML + Env** 双层配置管理。
  - 完善的日志系统，支持控制台与文件双写。

---

## 技术架构

```text
llm-trade/
├── src/
│   ├── config/           # 配置加载 (Env + TOML)
│   ├── executor/         # 交易执行 (下单、撤单、仓位计算)
│   ├── llm/              # LLM 交互 (Prompt 构建、ASCII 绘图、信号解析)
│   ├── market/           # 行情管理 (CCXT 封装、K 线拉取)
│   ├── monitor/          # 监控模块 (WebSocket 状态监听)
│   ├── scripts/          # 独立验证脚本
│   ├── utils/            # 工具库 (日志、指标计算)
│   ├── index.ts          # 程序主入口
│   └── trade-manager.ts  # 核心交易状态机
├── doc/                  # 项目文档
├── .env.example          # 环境变量模板
└── config.toml.example   # 策略参数模板
```

---

## 快速开始

### 1. 环境准备

- **Node.js**: >= 18.0.0 (推荐 LTS 版本)
- **包管理器**: npm 或 yarn

### 2. 安装依赖

```bash
npm install
```

### 3. 配置文件

#### 环境变量 (.env)

复制模板并配置交易所 API 和 LLM 密钥：

```bash
cp .env.example .env
# Windows PowerShell:
# Copy-Item .env.example .env
```

关键配置项：

- `IS_SANDBOX=true`：开启模拟盘模式（推荐初次运行时使用）。
- `EXCHANGE_ID`：默认 `bitget`。
- `LLM_API_KEY` & `LLM_BASE_URL`：配置你的 LLM 提供商。

#### 策略配置 (config.toml)

复制模板并调整策略参数：

```bash
cp config.toml.example config.toml
# Windows PowerShell:
# Copy-Item config.toml.example config.toml
```

关键配置项：

- `strategy.timeframe`：K 线周期 (如 `15m`)。
- `strategy.risk_per_trade`：单笔交易风险比例 (如 `0.01` 代表 1%)。
- `symbols.active`：启用的交易对列表。

### 4. 启动程序

```bash
npm start
```

启动后，程序将：

1. 加载配置并自检。
2. 连接交易所并验证 API 权限。
3. 测试 LLM 连接。
4. 为每个配置的交易对启动独立的交易循环。

---

## 开发与验证

本项目提供了一系列脚本用于独立验证各个模块的功能。

### 类型检查

```bash
npm run check
```

### E2E 验证 (Bitget 计划委托 + 止盈止损)

在运行主程序前，建议先运行此脚本验证交易所的下单接口是否正常：

```bash
# 验证所有场景 (市价、限价、触发单)
npx ts-node src/scripts/bitget-plan-tpsl-e2e.ts --scenario all
```

更多详情请参考 [Bitget E2E 验证文档](doc/bitget-plan-tpsl-e2e.md)。

---

## 文档索引

- **[开发设计文档 (DEV_DOC.md)](doc/DEV_DOC.md)**: 详细的系统架构、模块设计与核心流程说明。
- **[已完成工作 (Completed.md)](doc/Completed.md)**: 开发进度与功能变更记录。

---

## 常见问题 (FAQ)

**Q: 为什么启动时提示无法加载 config.toml?**
A: 请确保你已经将 `config.toml.example` 复制为 `config.toml`，该文件是策略运行的必需配置文件。

**Q: LLM 返回的信号不稳定怎么办?**
A: 可以在 `config.toml` 中调整 `lookback_candles` (回看 K 线数量) 或尝试更换更强大的模型 (如 GPT-4 或 Claude-3.5-Sonnet，如果 DeepSeek 表现不佳)。同时，Prompt 的微调也是优化方向之一。

**Q: 如何切换实盘?**
A: 在 `.env` 中设置 `IS_SANDBOX=false`，并填入 `PROD_API_KEY` 等实盘密钥。**请务必小资金测试。**

---

## License

本项目基于 [Apache-2.0](LICENSE) 协议开源。
