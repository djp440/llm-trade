# AI 驱动的价格行为交易系统开发文档 (LLM-PriceAction-Bot)

## 0. 公告

封装好的日志系统已启用，可参见 Completed.md 文件

## 1. 项目概述

本项目旨在构建一个基于 **Al Brooks 价格行为学 (Price Action)** 的自动化交易程序。系统利用 **DeepSeek API** (或其他兼容 OpenAI 格式的大模型) 具备的图表理解与逻辑推理能力，结合传统的量化交易框架，实现 **15 分钟级别** 的日内波段/剥头皮交易。

### 核心理念

- **简单至上**: 保持代码逻辑清晰，避免过度工程化。
- **高扩展性**: 模块化设计，轻松适配不同交易所或 LLM 模型。
- **安全第一**: 严格的风险控制（单笔风险限制）与防御性编程。

## 2. 技术栈

- **运行环境**: Node.js (LTS 版本)
- **开发语言**: TypeScript
- **交易所接口**: CCXT (Bitget API, 支持切换实盘/模拟)
- **AI 交互**: OpenAI SDK (配置 DeepSeek 端点)
- **配置管理**: `dotenv` (.env) + `toml` (config.toml)
- **辅助工具**: ASCII Chart 生成库 (用于将 K 线转化为字符画)

## 3. 系统架构

系统采用 **事件驱动 + 轮询** 的混合架构，主要包含以下模块：

1.  **Market Data Manager (行情管理器)**: 负责多交易对的 K 线数据获取与维护。
2.  **LLM Brain (大脑)**: 负责构造 Prompt（包含 OHLC 数据 + ASCII 图表），发送请求并解析 JSON 信号。
3.  **Trade Executor (交易执行器)**: 负责订单路由、突破单挂单、市价单兜底、止盈止损挂单。
4.  **Position Monitor (持仓监控)**: 负责 WebSocket 状态监听，管理生命周期。
5.  **Config Loader (配置加载器)**: 处理环境与策略配置。

## 4. 核心业务流程 ("沃尔玛交易法")

程序对每个配置的交易对（Symbol）并行运行以下状态机循环：

### 阶段一：信号搜寻 (No Position)

1.  **数据同步**: 每根 **15 分钟 K 线收盘（可配置周期）** 时，通过 CCXT 获取最新 OHLC 数据。
    请注意，k 线收盘是交易所标准时间的 k 线收盘！直接调用 ccxt 的监听函数可能会在每分钟都得到数据。
2.  **上下文构建**:
    - 提取过去 N 根 K 线数据。（可配置）
    - **关键步骤**: 将这段 OHLC 数据转换为 **ASCII 字符画** (美国线/蜡烛图形式)，直观展示形态。
    - 获取当前账户权益 (Equity)。
3.  **LLM 分析**:
    - 发送 Prompt (含：ASCII 图、OHLC 数值、账户权益、风险偏好)。
    - 等待 LLM 返回 JSON 格式信号。
4.  **信号决策**:
    - **否决**: 如果 LLM 认为当前 K 线不具备入场条件，休眠至下一根 K 线收盘。
    - **通过**: LLM 返回 `Action: BUY/SELL`，包含 `EntryPrice`, `StopLoss`, `TakeProfit`, `Quantity` (由 LLM 根据风险计算)。

### 阶段二：订单执行 (Execution)

收到开仓信号后，进入执行逻辑：

1.  **价格检查**: 获取当前最新市场价格 (`CurrentPrice`)。
2.  **入场判断**:
    - **场景 A (突破单)**: 若 `CurrentPrice < SignalCandle.High` (做多为例)，在 `SignalCandle.High + 1 tick` 处挂 **止损买入单 (Stop Market/Limit)**。
      - _动作_: 挂单 -> 监听 WebSocket 订单状态。
    - **场景 B (市价追单)**: 若 `CurrentPrice >= SignalCandle.High` (价格已突破)，立即执行 **市价单 (Market Order)** 入场。
3.  **取消机制**: 若挂出的突破单在下一根 K 线收盘前未成交，则发送消息给 LLM 请求重新评估是否要保留该突破单。

### 阶段三：仓位管理 (Position Management)

一旦入场成交（无论是突破单成交还是市价成交）：

1.  **OCO/止盈止损**: 立即根据 LLM 提供的 `StopLoss` 和 `TakeProfit` 价格挂出平仓订单。
2.  **静默监控**:
    - 不再请求 LLM，仅通过 WebSocket 监听仓位变化。
    - 等待止损或止盈触发。
3.  **重置**: 仓位平仓后，重置状态，回到“阶段一”。

## 5. 配置管理

### 5.1 环境变量 (`.env`)

用于敏感信息与基础连接配置。

```env
# 交易所配置
EXCHANGE_ID=bitget
IS_SANDBOX=true  # true=使用模拟盘API, false=使用实盘API

# 实盘账户 (Live Account)
PROD_API_KEY=your_prod_api_key
PROD_API_SECRET=your_prod_api_secret
PROD_API_PASSWORD=your_prod_api_password

# 模拟账户 (Demo/Sandbox Account)
DEMO_API_KEY=your_demo_api_key
DEMO_API_SECRET=your_demo_api_secret
DEMO_API_PASSWORD=your_demo_api_password

# LLM 配置
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxxxxx
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

### 5.2 策略配置 (`config.toml`)

用于调整交易参数。

```toml
[strategy]
timeframe = "15m"
lookback_candles = 20      # 发送给LLM的K线数量
risk_per_trade = 0.01      # 单笔风险 (账户权益的 1%)
max_open_positions = 3     # 最大同时持仓币种数

[symbols]
# 启用的交易对列表
active = [
    "BTC/USDT:USDT",
    "ETH/USDT:USDT",
    "SOL/USDT:USDT"
]

[execution]
slippage_tolerance = 0.001 # 滑点容忍度
entry_offset_ticks = 1     # 突破单价格偏移 tick 数
```

## 6. 数据接口定义 (TypeScript)

### LLM 输入 Prompt 结构示意

```typescript
interface LLMPromptContext {
  symbol: string;
  accountEquity: number;
  riskPerTrade: number; // e.g., 0.01
  ohlcData: OHLC[]; // 最近 N 根K线
  asciiChart: string; // 字符画字符串
}
```

### LLM 输出 JSON 结构

```typescript
interface TradeSignal {
  decision: "APPROVE" | "REJECT";
  reason: string; // 分析理由 (简短)
  action?: "BUY" | "SELL";
  orderType: "STOP" | "MARKET"; // 建议类型，实际执行需根据当前价格判断
  entryPrice: number; // 信号K线的高点/低点
  stopLoss: number; // 初始止损位
  takeProfit: number; // 目标止盈位
  quantity: number; // 计算好的开仓数量
}
```

## 7. 关键实现细节

### 7.1 ASCII K 线绘制

为了让 LLM 更好地理解形态，我们将 OHLC 数据转换为 ASCII 图。
_示例_:

```text
      |
  |   |
  +---+   |
  |   |   +---+
  |   |   |   |
--+   +---+   +--
```

_技术方案_: 使用现成的轻量级库（如 `asciichart` 或自定义绘图函数）将 K 线序列转换为文本块。

### 7.2 风险控制与数量计算

虽然 Prompt 要求 LLM 返回数量，但为了双重保险，系统内部应包含校验逻辑：
$$ \text{Quantity} = \frac{\text{Equity} \times \text{RiskPerTrade}}{|\text{EntryPrice} - \text{StopLoss}|} $$
_注意_: 需处理最小下单数量和精度问题。

### 7.3 并发处理

使用 `Promise.all` 或独立的 `TradeManager` 类实例来管理每个 Symbol。

```typescript
const managers = config.symbols.active.map(symbol => new TradeManager(symbol));
await Promise.all(managers.map(m => m.startLoop()));
```

## 8. 开发路线图

- [ ] **Step 1: 基础框架搭建**

  - 初始化 TS 项目，配置 ESLint/Prettier。
  - 实现 Config Loader (toml/env)。
  - 封装 CCXT 连接与基础公用方法 (fetchOHLC, getBalance)。

- [ ] **Step 2: LLM 交互模块**

  - 实现 ASCII Chart 生成器。
  - 编写 Prompt 模板。
  - 封装 OpenAI SDK 调用与 JSON 解析/容错处理。

- [ ] **Step 3: 交易逻辑核心**

  - 实现信号解析与订单路由。
  - 实现突破单挂单逻辑 (check price -> place stop order)。
  - 实现止盈止损挂单。

- [ ] **Step 4: 循环与并发**

  - 实现 15 分钟 K 线 监听/轮询机制。
  - 整合多交易对并行运行。

- [ ] **Step 5: 测试与优化**
  - 模拟盘测试 (Paper Trading)。
  - 边缘情况处理 (API 超时、网络断开、LLM 幻觉)。

## 9. 项目结构树

llm-trade/
├── doc/
│ └── DEV_DOC.md # 项目开发文档（核心设计与流程）
├── src/
│ ├── config/
│ │ └── loader.ts # 配置加载器：负责解析 .env 和 config.toml
│ ├── executor/
│ │ └── trade-executor.ts # 交易执行器：负责下单（突破单/市价单）及止盈止损挂单
│ ├── llm/
│ │ └── brain.ts # LLM 大脑：负责构造 Prompt、生成 ASCII 图表及解析信号
│ ├── market/
│ │ └── manager.ts # 行情管理器：封装 CCXT，负责获取 K 线数据和最新价
│ ├── monitor/
│ │ └── position-monitor.ts # 持仓监控器：通过 WebSocket 实时监听仓位状态
│ ├── types/
│ │ └── index.ts # 类型定义：包含 OHLC、信号接口、Prompt 上下文等
│ ├── utils/ # 工具类目录（如日志、数学计算等）
│ └── index.ts # 入口文件：初始化系统并启动各币种的交易循环
├── package.json # 项目依赖管理与脚本配置
├── tsconfig.json # TypeScript 编译选项配置
└── .gitignore # Git 忽略文件配置

## 10. 回测引擎开发文档 (Backtest Engine)

本章节描述如何在现有实时交易框架上新增一个“离线回测模式”。目标是：

- 自动读取本地 CSV OHLCV 数据
- 按照现有程序的标准执行逻辑（K 线收盘 → 构建上下文 → 请求 LLM → 生成计划 → 下单/成交/平仓）驱动回测
- 使用 mock 交易所与 mock 交易账户处理订单/仓位/手续费
- 每次完整平仓后输出并更新收益曲线图（复用现有权益绘图工具）

### 10.1 现有“标准执行逻辑”对齐点

回测引擎必须尽量复用当前链路，避免复制逻辑。

- 行情获取与 K 线确认：MarketDataManager.getConfirmedCandles()（见 src/market/manager.ts）
- LLM 决策：LLMService.analyzeMarket()（见 src/llm/llm-service.ts）
- 交易计划生成与下单：TradeExecutor.generateTradePlan()/executeTradePlan()（见 src/executor/trade-executor.ts）
- 平仓检测与权益曲线：TradeManager.processManaging() 在检测仓位由开变空时调用 recordEquityPointAndRenderChart()（见 src/trade-manager.ts 与 src/utils/equity-report.ts）

结论：回测模式应提供一套“可替换的数据源与交易所实现”，让 TradeManager/TradeExecutor 在不改或少改的情况下运行。

### 10.2 CSV 数据规范

#### 10.2.1 文件组织建议

建议把数据放在项目根目录下的 data/（目录名可配置）：

- data/BTCUSDT/15m.csv
- data/ETHUSDT/15m.csv

symbol 与实际交易对字符串（如 BTC/USDT:USDT）的映射由回测配置提供。

#### 10.2.2 CSV 列定义（推荐，支持币安下载格式）

回测只需要标准 OHLCV（timestamp/open/high/low/close/volume）。为了兼容不同数据源，建议实现“按表头自动识别 + 字段映射”。

支持两种常见格式：

1. 简化格式（推荐）：

- timestamp：毫秒时间戳（Unix ms）或 ISO8601 字符串（建议统一转为 ms）
- open,high,low,close：number
- volume：number

```csv
timestamp,open,high,low,close,volume
1700000000000,37000,37100,36950,37080,123.45
1700000900000,37080,37220,37010,37190,98.76
```

2. 币安下载格式（你当前的文件格式）：

```csv
open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore
1735689600000,93548.80,93690.00,93460.20,93631.20,988.149,1735690499999,92462034.27860,22328,371.941,34807041.45550,0
```

字段映射规则：

- timestamp = open_time（币安通常为毫秒时间戳）
- open/high/low/close/volume 直接使用同名列
- close_time、quote_volume、count、taker_buy_volume、taker_buy_quote_volume、ignore 可忽略

说明：

- close_time 通常是该根 K 线结束时间（ms），但本项目内部 OHLC.timestamp 使用开盘时间即可，与 ccxt 返回的 ohlcv[0] 对齐
- 如果 open_time/close_time 是秒级时间戳，需乘以 1000 转为 ms（建议通过数值大小自动判断）

要求：

- 按 timestamp 升序；若乱序需在加载后排序
- 不允许缺失字段；遇到非法行应跳过并记录日志
- timeframe 必须与 config.toml 中 strategy.timeframe 一致，否则会导致 K 线收盘边界计算错误

### 10.3 回测模式整体架构

回测引擎由 3 层组成：

1. 数据源层：从 CSV 产出 OHLC 序列
2. 交易所/账户层：撮合订单、维护仓位与权益（mock）
3. 驱动层：推进时间、在每根 K 线收盘触发“标准执行逻辑”

#### 10.3.1 建议新增模块（代码落点建议）

建议新增 src/backtest/：

- src/backtest/csv-data-source.ts：CSV 读取与解析
- src/backtest/mock-exchange.ts：mock 交易所（兼容 ccxt 子集）
- src/backtest/mock-account.ts：mock 账户（现金/仓位/已实现盈亏）
- src/backtest/matching-engine.ts：基于 OHLC 的撮合推进
- src/backtest/backtest-runner.ts：回测主循环（单/多交易对）

不建议把回测逻辑塞进现有 market/ 或 executor/，避免实时模式耦合回测细节。

### 10.4 关键接口设计（与现有代码的最小适配）

#### 10.4.1 MockExchange 需要覆盖的方法

为了复用 TradeManager + TradeExecutor，mock 交易所至少需要实现以下 ccxt 风格接口（只实现项目实际用到的子集）：

- market(symbol)：返回精度与限制（precision、limits.amount.min、limits.cost.min 等）
- priceToPrecision(symbol, price)：价格精度格式化
- amountToPrecision(symbol, amount)：数量精度格式化
- fetchOHLCV(symbol, timeframe, since?, limit?)：返回 [[ts, o, h, l, c, v], ...]
- fetchTicker(symbol)：至少提供 { last }
- fetchBalance()：至少提供 { total: { USDT: number } }
- fetchTime()：返回当前回测“服务器时间”（由回测时钟控制）

订单相关：

- createOrder(symbol, type, side, amount, price?, params?)
- fetchOrder(id, symbol?, params?)
- fetchOpenOrders(symbol?, since?, limit?, params?)
- cancelOrder(id, symbol?, params?)

持仓相关（用于平仓检测与权益快照）：

- fetchPositions([symbol]?) 或 fetchPosition(symbol)

兼容位模式（TradeExecutor 对 bitget 会尝试调用）：

- fetchPositionMode(symbol?)：返回 { hedged: boolean }（回测可固定为单向持仓 hedged=false）

说明：TradeExecutor/TradeManager 依赖的具体行为可参考 src/executor/trade-executor.ts 与 src/trade-manager.ts。

#### 10.4.2 MockAccount 的核心账本

建议实现线性合约风格（USDT 计价），最小字段：

- cashUsdt：可用现金
- position：按 symbol 维护的净仓位（size、avgEntryPrice）
- realizedPnlUsdt：已实现盈亏
- commissionRate：来自 config.execution.commission_rate_percent / 100

权益计算（回测中用于与实盘一致的 equity 概念）：

- equity = cashUsdt + unrealizedPnlUsdt
- unrealizedPnlUsdt = position.size \* (markPrice - avgEntryPrice)（做空 size 为负时同公式成立）

#### 10.4.3 订单模型（建议）

建议内部统一成一个简化 Order：

- id：string
- symbol：string
- type：market | limit | stop_market | stop
- side：buy | sell
- amount：number
- status：open | closed | canceled
- triggerPrice：number | undefined（用于 stop/stop_market）
- price：number | undefined（limit 或用于记录）
- filled：number
- average：number（成交均价）
- reduceOnly：boolean
- createdTimeMs / updatedTimeMs

并支持从 TradeExecutor 传入的 params 里提取：

- params.triggerPrice / params.stopPrice / entry.stopPrice（止损触发价）
- params.stopLoss / params.takeProfit（Bitget 风格的附加止盈止损）

### 10.5 撮合规则（必须明确，避免回测“作弊”）

回测基于 OHLCV 数据无法还原真实逐笔成交，因此必须定义确定性的撮合规则。建议默认采用“保守、无前视偏差”的规则：

#### 10.5.1 时间推进

- LLM 在第 i 根 K 线收盘后被调用
- 本轮产生的订单，只能在第 i+1 根 K 线开始后发生成交/触发

这能避免使用同一根 K 线的 high/low 来“预测”已经发生的价格路径。

#### 10.5.2 市价单（market）成交价

- 默认：在下一根 K 线的 open 成交
- 可选：加入滑点，使用 execution.slippage_tolerance 将成交价上/下浮

#### 10.5.3 触发单（stop/stop_market）触发与成交

- 触发条件：
  - buy：下一根 K 线的 high >= triggerPrice
  - sell：下一根 K 线的 low <= triggerPrice
- 成交价：
  - 默认按 triggerPrice 成交（更保守的做法是按触发后价格加滑点）

#### 10.5.4 止盈/止损冲突（同一根 K 线同时触发）

当仓位已建立，且下一根 K 线同时包含止盈与止损触发范围（例如多头：low <= SL 且 high >= TP），必须定义优先级：

- 默认保守：先止损后止盈（避免高估策略）
- 可选：基于 K 线方向决定路径（牛线 open→low→high→close；熊线 open→high→low→close）

文档要求：实现时必须把该规则做成可配置项（例如 backtest.fill_policy）。

#### 10.5.5 手续费

每次开仓与平仓分别收取手续费：

- fee = notional \* (commission_rate_percent / 100)
- notional = |filledQty| \* fillPrice

该费率应与 LLM prompt 中使用的 commission_rate_percent 保持一致（见 LLMService.analyzeMarket）。

### 10.6 回测主循环（单交易对）

单交易对回测建议流程：

1. 预加载 CSV → OHLC[]（升序）
2. 初始化 MockAccount（initialEquityUsdt）与 MockExchange（绑定 data source 与 clock）
3. 初始化 TradeManager，但将 ExchangeManager 注入为“回测版 ExchangeManager”（其 getExchange() 返回 MockExchange）
4. 从第 lookback 根开始推进：
   - 将 clock 设置到“第 i 根 K 线收盘后”的时间
   - getConfirmedCandles() 返回截至 i 的 lookback 段
   - 调用 LLM → 生成计划 → createOrder（下单只记录，不立即成交）
   - 推进到第 i+1 根 K 线：matching-engine 根据 OHLC 触发/成交订单、更新仓位
   - 当检测到仓位由开变空：调用 recordEquityPointAndRenderChart({ timestampMs: closeTime, equityUsdt })

注意：现有 TradeManager.startLoop() 是“真实时间睡眠”的无限循环。回测模式不应复用该 while/sleep 逻辑，而应实现一个 BacktestRunner 以“迭代推进”方式调用与复用其内部阶段函数，或拆分出可复用的步骤函数。

### 10.7 多交易对回测（可选）

如果要并行回测多个 symbol：

- 将每个 symbol 的 OHLC 序列合并成一个全局时间轴（按 timestamp 排序）
- 每推进一个时间点，仅对该 symbol 执行“本 K 线收盘后”的信号搜索/管理逻辑
- MockAccount 可选择：
  - 共享一个总账户（更贴近真实资金约束）
  - 每个 symbol 独立账户（便于对比但不真实）

### 10.8 输出与验收标准

#### 10.8.1 输出

复用现有工具 src/utils/equity-report.ts：

- output/equity/equity.csv：权益时间序列
- output/equity/equity.png：收益曲线图

建议在每次完整平仓后记录一次权益快照，以与实盘逻辑一致（见 TradeManager.processManaging）。

#### 10.8.2 验收标准

- 回测过程中不会调用任何真实交易所网络 API（除非显式启用实时模式）
- 在固定 CSV 数据与固定撮合规则下，多次运行结果完全一致（确定性）
- 每次平仓后 equity.png 会更新，且 equity.csv 追加一行
- LLM 交互日志（如开启 log_interactions）可用于复盘每笔交易的决策依据

### 10.9 性能与成本建议

- 大模型成本：回测会对每根 K 线调用一次 LLM，建议支持缓存（按 symbol + timeframe + lastTimestamp + lookback hash 缓存响应）
- 文件读取：大 CSV 采用流式读取与增量解析，避免一次性载入占用过多内存
- 速率限制：对 LLM 调用做并发控制（例如每次只允许 1~2 个并发请求），避免触发限流
