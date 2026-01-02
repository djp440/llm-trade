# 回测引擎开发文档

## 1. 概述 (Overview)

本项目旨在为现有 LLM 交易机器人添加回测功能。回测引擎将模拟真实交易环境，使用历史 CSV 数据作为市场输入，并复用现有的 `LLMService` 进行策略分析。设计原则是**最小化对现有主逻辑 (`TradeManager`) 的修改**，通过依赖注入和接口抽象来实现。

## 2. 架构设计 (Architecture)

我们将采用 **"虚拟沙盒 (Virtual Sandbox)"** 模式。回测引擎将创建一个完全隔离的虚拟环境，其中包含虚拟交易所和虚拟账户。

### 核心组件

1.  **VirtualExchange (虚拟交易所)**

    - **职责**: 模拟交易所行为。
    - **功能**:
      - 维护虚拟资金 (Balance)。
      - 维护订单簿 (Order Book) 和持仓 (Positions)。
      - 提供与 CCXT 兼容的接口 (fetchBalance, createOrder, cancelOrder 等)。
      - **撮合引擎**: 在每个时间步 (Step) 检查挂单是否触发 (High/Low 穿透)。

2.  **BacktestContext (回测上下文)**

    - **职责**: 管理回测的时间和数据指针。
    - **功能**:
      - 加载 CSV 数据。
      - 提供 `CurrentIndex` 指针。
      - 提供 `getHistory(n)` 方法获取当前时间点之前的 K 线。

3.  **BacktestEngine (回测引擎 - 主控)**
    - **职责**: 调度整个流程（状态机）。
    - **功能**:
      - 控制时间步进 (Next Candle)。
      - 调用 LLM 服务。
      - 执行用户定义的状态流转逻辑 (Wait -> Pending -> Position)。

## 3. 详细模块设计

### 3.1 数据结构

#### 输入数据 (CSV)

必须包含标准 OHLCV 字段。

```typescript
interface CSVRow {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

#### 虚拟账户状态

```typescript
interface VirtualAccount {
  balance: number; // 可用余额
  equity: number; // 净值 (余额 + 未结盈亏)
  positions: Position[]; // 当前持仓
  orders: Order[]; // 活动挂单
}
```

### 3.2 虚拟交易所 (VirtualExchange)

这是一个新的类，位于 `src/backtest/virtual-exchange.ts`。

- **Order Matching (撮合逻辑)**:
  - **Buy Stop**: 当 `High >= TriggerPrice` 时触发。成交价设为 `max(Open, TriggerPrice)` (考虑跳空)。
  - **Sell Stop**: 当 `Low <= TriggerPrice` 时触发。成交价设为 `min(Open, TriggerPrice)`。
  - **Take Profit / Stop Loss**: 同上，基于 High/Low 进行判定。
  - **Intra-candle Conflict (同一根 K 线同时触及止盈止损)**:
    - _策略_: 悲观模式 (Pessimistic)。优先触发止损 (SL)，除非 K 线形态明确表明先到了 TP (但在只有 OHLC 数据下很难判定，故默认悲观)。

### 3.3 回测主循环 (BacktestEngine)

这是一个新的独立运行脚本或类，位于 `src/backtest/engine.ts`。它不继承 `TradeManager`，而是复用其思想和 `LLMService`。

**状态机流程 (State Machine)**:

1.  **初始化**:

    - `CurrentIndex = LookbackWindow` (例如 50)。
    - `State = WAITING_SIGNAL`.

2.  **状态: WAITING_SIGNAL (等待信号)**

    - **Action**: 截取 `Data[CurrentIndex - Lookback : CurrentIndex]`。
    - **Call LLM**: 发送 Prompt。
    - **Branch**:
      - `REJECT`: `CurrentIndex++` -> 循环。
      - `APPROVE`:
        - 计算仓位大小 (Risk %)。
        - 在 `VirtualExchange` 创建 `STOP` 挂单。
        - `State = PENDING_ORDER`。
        - **注意**: 挂单是在当前 K 线收盘后挂出的，将在 `CurrentIndex + 1` 的 K 线开始生效。

3.  **状态: PENDING_ORDER (挂单中)**

    - **Step**: `CurrentIndex++` (推进一根 K 线)。
    - **Check Match**: 调用 `VirtualExchange.processCandle(Data[CurrentIndex])`。
      - 如果订单成交 -> 生成 `Position` -> `State = IN_POSITION`。
      - 如果订单未成交 -> 进入决策分支。
    - **Decision (未成交)**:
      - **Call LLM**: "当前挂单未触发，是否取消？"
      - `CANCEL`: `VirtualExchange.cancelOrder()` -> `State = WAITING_SIGNAL`.
      - `KEEP`: 保持状态，进入下一次循环。

4.  **状态: IN_POSITION (持仓中)**
    - **Step**: `CurrentIndex++`。
    - **Update**: `VirtualExchange.processCandle(Data[CurrentIndex])` (计算浮动盈亏，检查 TP/SL)。
    - **Check**:
      - 如果 `Position` 被关闭 (TP/SL hit):
        - 记录 Trade Result (EntryTime, ExitTime, PnL, R-Multiple)。
        - `State = WAITING_SIGNAL`.
      - 如果 `Position` 仍存在:
        - 继续循环 (不调用 LLM，纯数学计算)。

## 4. 目录结构变动

```text
src/
  ├── backtest/             <-- 新增目录
  │   ├── engine.ts         // 回测主引擎
  │   ├── virtual-exchange.ts // 虚拟交易所实现
  │   ├── data-loader.ts    // CSV 读取器
  │   └── types.ts          // 回测专用类型
  ├── scripts/
  │   └── run-backtest.ts   // 启动脚本
```

## 5. 现有代码修改计划

- **Minimize Impact**: 我们不会修改 `TradeManager.ts`。
- **Reuse**:

  - `src/llm/llm-service.ts`: 直接实例化并使用。
  - `src/llm/context-builder.ts`: 需要确保它接受纯数据数组，而不是依赖实时 `MarketDataManager`。如果它目前依赖 `MarketDataManager`，我们需要重构它以接受 `OHLC[]` 作为输入，或者创建一个适配器。

  _检查点_: 检查 `context-builder.ts`。
  _(假设 ContextBuilder 可能需要小幅调整以支持传入静态数据)_

## 6. 开发步骤

1.  **创建基础工具**: 实现 `DataLoader` 读取 Binance CSV。
2.  **实现虚拟交易所**: `VirtualExchange` 类，核心是 `matchOrders(candle)` 方法。
3.  **实现回测引擎**: 编写状态机循环，集成 `LLMService`。
4.  **编写启动脚本**: `scripts/run-backtest.ts`。
5.  **验证**: 使用一小段 CSV 数据进行逻辑验证。

## 7. 注意事项

- **LLM 成本**: 回测会消耗大量 Token。建议在 Prompt 中添加 "Dry Run" 或使用便宜的模型 (如 Flash/Haiku) 进行调试。
- **速度**: 由于涉及网络请求 (LLM)，回测速度会受限于 API 延迟。
- **数据一致性**: 确保 CSV 时间戳与代码中的时间处理逻辑（UTC/Local）一致。

---

**等待指令**
请确认以上设计方案。如果无误，我将开始按照步骤编写代码。
