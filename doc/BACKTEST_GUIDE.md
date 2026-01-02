# LLM 交易机器人回测引擎使用指南

## 1. 简介 (Introduction)

本回测引擎专为基于 LLM（大语言模型）的交易策略设计。它提供了一个**虚拟沙盒环境**，模拟真实的交易所交互，允许您在不承担资金风险的情况下，验证 LLM 的市场分析能力和交易策略的有效性。

与传统回测引擎不同，本系统**完整复用**了实盘代码中的 `LLMService`，确保回测时的分析逻辑与实盘完全一致。

## 2. 核心特性 (Key Features)

*   **虚拟沙盒 (Virtual Sandbox)**: 包含独立的虚拟交易所和账户系统，支持限价单、止损单的完全撮合模拟。
*   **真实 LLM 交互**: 在回测的每一个时间步，都会真实调用 LLM API 进行分析，而非简单的指标回测。
*   **多时间周期重采样 (Multi-Timeframe Resampling)**: 自动将基础数据（如 15分钟）重采样为更大周期（如 1小时、4小时），为 LLM 提供丰富的多周期上下文。
*   **悲观撮合机制 (Pessimistic Matching)**: 在同一根 K 线内同时触发止盈和止损时，优先触发止损，以提供更保守、更真实的测试结果。
*   **可视化 HTML 报告**: 自动生成包含交互式 K 线图、资金曲线和详细交易记录的网页报告。
*   **低成本兼容性**: 针对 Gemma-3 等更便宜的模型进行了优化，并提供关闭图像分析的选项以节省 Token。

## 3. 快速开始 (Quick Start)

### 3.1 准备工作

确保您已准备好以下环境：
1.  **Node.js**: v16 或更高版本。
2.  **LLM API Key**: 确保 `.env` 文件中已配置有效的 API Key（推荐使用 Google Gemini 或兼容模型）。
3.  **历史数据**: 准备 CSV 格式的 K 线数据（如 Binance 导出的数据）。

### 3.2 运行回测

1.  **配置脚本**: 打开 `src/scripts/run-backtest.ts`，修改配置对象：
    ```typescript
    const config: BacktestConfig = {
      csvPath: "path/to/your/data.csv", // CSV 数据路径
      initialBalance: 10000,            // 初始资金
      symbol: "BTC/USDT",               // 交易对
      timeframes: {
        trading: "15m", // 交易周期（也是 CSV 的基础周期）
        context: "1h",  // 上下文周期（自动生成）
        trend: "4h",    // 趋势周期（自动生成）
      },
      enableImageAnalysis: false, // 是否启用图像分析（建议关闭以提高速度）
      // limit: 100 // 可选：仅测试前 100 根 K 线
    };
    ```

2.  **执行命令**:
    ```bash
    npx ts-node src/scripts/run-backtest.ts
    ```

3.  **查看结果**:
    回测完成后，终端会输出报告路径。请在浏览器中打开生成的 `output/backtest_report_xxxx.html` 文件。

## 4. 报告解读 (Report Guide)

HTML 报告包含以下主要部分：

### 4.1 概览面板 (Overview)
*   **Total Return**: 总收益率。
*   **Win Rate**: 胜率（盈利交易次数 / 总交易次数）。
*   **Profit Factor**: 盈亏比（总盈利 / 总亏损）。
*   **Max Drawdown**: 最大回撤（资金曲线从峰值下降的最大幅度）。

### 4.2 交互式图表 (Chart)
*   **K 线图**: 显示交易周期的价格走势。
*   **标记**:
    *   `↑` (绿色箭头): 开多 (Long Entry)
    *   `↓` (红色箭头): 开空 (Short Entry)
    *   `x` (红色/绿色叉号): 平仓 (Close Position)
*   **操作**: 支持缩放、平移，查看任意时间点的细节。

### 4.3 交易列表 (Trade List)
详细列出每一笔交易的：
*   入场时间与价格
*   出场时间与价格
*   方向 (Long/Short)
*   盈亏额 (PnL) 与百分比 (ROI)
*   退出原因 (TP/SL/Signal)

## 5. 常见问题 (FAQ)

**Q: 为什么回测速度很慢？**
A: 因为每根 K 线都需要调用一次 LLM API。如果您使用的是免费版 API（如 Gemini Free Tier），可能会受到速率限制（Rate Limit）。建议开启 `limit` 参数进行小范围测试，或在代码中增加请求间隔。

**Q: CSV 数据格式有什么要求？**
A: 支持标准的 Binance 导出格式或包含 `timestamp, open, high, low, close, volume` 列的 CSV 文件。引擎会自动跳过非数字的表头行。

**Q: 如何调整策略？**
A: 策略逻辑主要由 Prompt 决定。您可以修改 `src/llm/prompts.ts` 中的提示词来调整 LLM 的分析倾向。
