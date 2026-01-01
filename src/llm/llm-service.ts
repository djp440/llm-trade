import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { ConfigLoader } from "../config/config";
import { logger } from "../utils/logger";
import {
  TradeSignal,
  OHLC,
  LLMPromptContext,
  PendingOrderDecision,
} from "../types";
import { ChartUtils } from "../utils/chart-utils";
import { ContextBuilder } from "./context-builder";
import { TechnicalIndicators } from "../utils/indicators";

export class LLMService {
  private openai: OpenAI;
  private model: string;
  private logInteractions: boolean;
  private includeChart: boolean;
  private temperature?: number;
  private topP?: number;
  private maxTokens?: number;
  private reasoningEffort?: "ignore" | "none" | "low" | "medium" | "high";

  private static readonly MIN_NET_RR = 2;

  constructor() {
    const config = ConfigLoader.getInstance();
    this.openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    this.model = config.llm.model;
    this.logInteractions = config.llm.logInteractions;
    this.includeChart = config.llm.includeChart;
    this.temperature = config.llm.temperature;
    this.topP = config.llm.topP;
    this.maxTokens = config.llm.maxTokens;
    this.reasoningEffort = config.llm.reasoningEffort;
  }

  /**
   * 测试 LLM 连接
   * @returns Promise<boolean>
   */
  public async testConnection(): Promise<boolean> {
    try {
      logger.info(`正在测试 LLM 连接 (${this.model})...`);
      // 发送简单消息测试连接，限制 max_tokens 以节省成本和避免超时
      await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      });
      logger.info("LLM 连接成功！");
      return true;
    } catch (error: any) {
      logger.error(`LLM 连接失败: ${error.message}`);
      return false;
    }
  }

  private logTokenUsage(usage: any) {
    if (!usage) return;
    const promptK = (usage.prompt_tokens / 1000).toFixed(3);
    const completionK = (usage.completion_tokens / 1000).toFixed(3);
    const totalK = (usage.total_tokens / 1000).toFixed(3);
    logger.info(
      `[Token统计] 输入: ${promptK}k | 输出: ${completionK}k | 总计: ${totalK}k`
    );
  }

  private async saveInteractionLog(
    type: string,
    systemPrompt: string,
    userPrompt: string,
    response: string
  ) {
    if (!this.logInteractions) return;

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logDir = path.resolve(process.cwd(), "output", "chat");

      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const filename = `${timestamp}_${type}.md`;
      const filePath = path.join(logDir, filename);

      const content = `# LLM Interaction Log - ${type}
Date: ${new Date().toLocaleString()}
Model: ${this.model}

## System Prompt
\`\`\`text
${systemPrompt}
\`\`\`

## User Prompt
\`\`\`text
${userPrompt}
\`\`\`

## Response
\`\`\`json
${response}
\`\`\`
`;

      await fs.promises.writeFile(filePath, content, "utf-8");
      logger.info(`LLM 交互日志已保存: ${filePath}`);
    } catch (error: any) {
      logger.error(`保存 LLM 交互日志失败: ${error.message}`);
    }
  }

  private formatOHLCWithEMA(ohlc: OHLC[]): string {
    const ema20 = TechnicalIndicators.calculateEMA(ohlc, 20);
    return ohlc
      .map(
        (c, i) =>
          `[${i}] T:${new Date(c.timestamp).toISOString().substr(11, 5)} O:${
            c.open
          } H:${c.high} L:${c.low} C:${c.close} EMA20:${
            ema20[i] ? ema20[i]?.toFixed(2) : "N/A"
          } V:${c.volume}`
      )
      .join("\n");
  }

  private cleanJsonString(str: string): string {
    // 尝试提取 JSON 对象部分
    const firstBrace = str.indexOf("{");
    const lastBrace = str.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return str.substring(firstBrace, lastBrace + 1);
    }

    // 如果找不到大括号，尝试移除 markdown 标记作为备选
    return str
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
  }

  /**
   * Analyzes the market data using LLM to generate trade signals.
   * @param symbol Trading pair symbol (e.g., "BTC/USDT")
   * @param ohlc Array of OHLC data
   * @param accountEquity Current account equity
   * @param riskPerTrade Risk per trade (e.g., 0.01 for 1%)
   * @returns Promise<TradeSignal>
   */
  public async analyzeMarket(
    symbol: string,
    ohlc: OHLC[],
    accountEquity: number,
    riskPerTrade: number
  ): Promise<TradeSignal> {
    // 1. Generate ASCII Chart
    const config = ConfigLoader.getInstance();
    const commissionRatePercent = config.execution.commission_rate_percent;
    const asciiChart = this.includeChart
      ? ChartUtils.generateCandlestickChart(
          ohlc,
          config.llm.chartHeight,
          config.llm.chartLimit
        )
      : "[ASCII Chart Disabled]";

    // 2. Prepare Context (Internal use or logging)
    const context: LLMPromptContext = {
      symbol,
      accountEquity,
      riskPerTrade,
      ohlcData: ohlc,
      asciiChart,
    };

    // 3. Construct Prompt
    const timeframe = ConfigLoader.getInstance().strategy.timeframe;
    const systemPrompt = `You are an expert Crypto Swing and Trend Trader specializing in **Al Brooks Price Action Trading** on ${timeframe} timeframes.
Your goal is to capture major market moves (Swing Trading) and follow established trends. Avoid scalping or entering on minor price noise.
Focus on identifying high-probability setups that lead to sustained price movement and significant legs.

### TRADING PHILOSOPHY: SWING & TREND
- **Patience**: Prioritize major setups (Wedges, MTR, Strong Breakouts) over small, low-conviction signals.
- **Holding Period**: Aim to capture the "meat" of a move. Decisions should favor holding for larger targets rather than quick exits.
- **Risk Management**: Use robust Stop Losses based on structural swing points (e.g., beyond the start of a trend leg or major support/resistance).
- **Profit Targets**: Target significant structural levels, such as measured moves or major prior highs/lows.

### FEES (Commission)
- The user's commission rate is ${commissionRatePercent}% per side.
- When evaluating profit and risk/reward, you MUST subtract commissions for BOTH entry and exit.
- If net profit after commissions is <= 0, or net risk/reward is poor (< 1:2), you MUST return REJECT.

### DATA INPUT FORMAT ("Telescope" Strategy)
You will receive data in two layers:
1. **Macro Context**: Summarized history to understand the big picture (Trend vs Range).
2. **Micro Action**: Detailed recent bars with pre-calculated Al Brooks features.
   - \`bar_type\`: "Bull Trend", "Bear Trend", or "Doji".
   - \`close_strength\`: 0.0 (Low) to 1.0 (High). Indicates buying/selling pressure.
   - \`ema_relation\`: Position relative to 20 EMA.
   - \`overlap\`: Market churn/indecision.

**INSTRUCTION**: DO NOT calculate raw numbers manually. Trust the provided feature tags.

### CORE PHILOSOPHY (Al Brooks)
1. **Context is King**: Always determine the Market Cycle first. Swing trading requires a clear Trend or a wide Trading Range.
2. **Trader's Equation**: Probability * Reward > (1 - Probability) * Risk. For swing trades, prioritize Reward size.
3. **20-Period EMA**: Primary trend reference. Use it to judge the strength and sustainability of a trend.

### ANALYSIS FRAMEWORK
1. **Market Cycle Phase**:
   - **Strong Trend**: Gaps, strong breakout bars. -> *Action*: Enter on Pullbacks (H1/H2, L1/L2) for a swing leg.
   - **Broad Channel**: Trending with deeper pullbacks. -> *Action*: Buy low, Sell high in the channel.
   - **Trading Range**: Avoid narrow ranges. Only trade if the range is wide enough for a swing move.
2. **Setup Identification**:
   - **Major Trend Reversal (MTR)**: Look for a break of the trendline followed by a test of the extreme.
   - **Wedges**: 3 pushes, often leading to a multi-leg correction or reversal.
   - **Double Top/Bottom**: Structural reversal points.
3. **Signal Bar Evaluation**:
   - A strong signal bar confirms the entry, but for swing trading, the **Context** of the preceding 20-50 bars is more important than a single bar.

### EXECUTION RULES
- **Order Type**: Primarily **STOP** orders (Breakout entry) to ensure momentum is in your favor.
- **Stop Loss**: Place at a logical structural point (Major Swing Low for BUYS, Major Swing High for SELLS) rather than just tight below the signal bar.
- **Take Profit**: Set at a level that offers at least a 1:2 net R/R ratio, targeting major price magnets.

### OUTPUT FORMAT (Chain of Thought)
You MUST return a strictly valid JSON object.
{
    "analysis_step_1_market_cycle": "String. Determine the phase (Strong Trend, Broad Channel, Trading Range, Breakout Mode). Cite Macro Context.",
    "analysis_step_2_setup": "String. Identify specific swing patterns (MTR, Wedge, etc). Explain why this is a swing setup and not a scalp.",
    "analysis_step_3_signal_bar": "String. Evaluate the signal bar in the context of the larger move.",
    "decision": "APPROVE" | "REJECT",
    "reason": "使用简体中文详细总结上述分析步骤。说明为何该信号符合波段或趋势交易逻辑，以及为何止盈止损设置合理。",
    "action": "BUY" | "SELL",
    "orderType": "STOP",
    "entryPrice": number,
    "stopLoss": number,
    "takeProfit": number
}`;

    // Format OHLC using ContextBuilder
    const formattedContext = ContextBuilder.buildContext(ohlc);

    const userPrompt = `
Current Market Context:
Symbol: ${symbol}
Account Equity: ${accountEquity}
Risk Per Trade: ${riskPerTrade}
Commission Rate (per side, percent): ${commissionRatePercent}

Fee Rule:
- NetReward = GrossReward - (EntryFee + ExitFee)
- Fee is charged on notional at both entry and exit.
- If net profit after entry+exit fees is <= 0, or net R/R < 1:2, return REJECT.

MARKET DATA:
${formattedContext}

ASCII Chart (Visual Representation, Last ${config.llm.chartLimit} bars):
${asciiChart}

TASK:
1. Analyze the Market Cycle (Macro & Micro).
2. Identify Setups.
3. Evaluate the Signal Bar (Last bar).
4. Make a Decision.

Return JSON only.
`;

    // 4. 调用 LLM
    try {
      const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
        {
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          ...(this.temperature !== undefined
            ? { temperature: this.temperature }
            : {}),
          ...(this.topP !== undefined ? { top_p: this.topP } : {}),
          ...(this.maxTokens !== undefined
            ? { max_tokens: this.maxTokens }
            : {}),
          ...(this.reasoningEffort !== undefined &&
          this.reasoningEffort !== "ignore"
            ? { reasoning_effort: this.reasoningEffort }
            : {}),
        };

      const response = await this.openai.chat.completions.create(createParams);

      this.logTokenUsage(response.usage);

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error("LLM 返回内容为空");
      }

      await this.saveInteractionLog(
        "MARKET_ANALYSIS",
        systemPrompt,
        userPrompt,
        content
      );

      const cleanedContent = this.cleanJsonString(content);
      const signal: TradeSignal = JSON.parse(cleanedContent);

      const filtered = this.applyCommissionGuard(signal, commissionRatePercent);
      if (filtered) {
        return filtered;
      }

      return signal;
    } catch (error: any) {
      logger.error(`[LLM 服务] 分析市场失败: ${error.message}`);
      // 发生错误时返回 REJECT 信号
      return {
        decision: "REJECT",
        reason: `LLM 错误: ${error.message}`,
      } as any;
    }
  }

  private applyCommissionGuard(
    signal: TradeSignal,
    commissionRatePercent: number
  ): TradeSignal | null {
    if (signal.decision !== "APPROVE" || !signal.action) return null;

    if (
      typeof signal.entryPrice !== "number" ||
      typeof signal.stopLoss !== "number" ||
      typeof signal.takeProfit !== "number" ||
      !Number.isFinite(signal.entryPrice) ||
      !Number.isFinite(signal.stopLoss) ||
      !Number.isFinite(signal.takeProfit)
    ) {
      return {
        ...signal,
        decision: "REJECT",
        reason: `信号字段不完整或包含无效数值，已拒绝。原因：${signal.reason}`,
      };
    }

    const rate =
      typeof commissionRatePercent === "number" &&
      Number.isFinite(commissionRatePercent) &&
      commissionRatePercent >= 0
        ? commissionRatePercent / 100
        : 0;

    const entry = signal.entryPrice;
    const sl = signal.stopLoss;
    const tp = signal.takeProfit;

    const isBuy = signal.action === "BUY";
    const grossReward = isBuy ? tp - entry : entry - tp;
    const grossRisk = isBuy ? entry - sl : sl - entry;

    if (grossReward <= 0 || grossRisk <= 0) {
      return {
        ...signal,
        decision: "REJECT",
        reason: `止盈/止损与方向不匹配或盈亏为非正，已拒绝。原因：${signal.reason}`,
      };
    }

    const entryFee = entry * rate;
    const exitFeeTp = tp * rate;
    const exitFeeSl = sl * rate;

    const netReward = grossReward - (entryFee + exitFeeTp);
    const netRisk = grossRisk + (entryFee + exitFeeSl);
    const netRR = netRisk > 0 ? netReward / netRisk : -Infinity;

    if (netReward <= 0 || netRR < LLMService.MIN_NET_RR) {
      const rrText = Number.isFinite(netRR) ? netRR.toFixed(4) : String(netRR);
      return {
        ...signal,
        decision: "REJECT",
        reason: `已按佣金费率 ${commissionRatePercent}% 计算净盈亏比后拒绝：净R/R=${rrText}，净收益=${netReward.toFixed(
          6
        )}。原因：${signal.reason}`,
      };
    }

    return null;
  }

  /**
   * Analyzes an existing pending breakout order to decide whether to KEEP or CANCEL it.
   */
  public async analyzePendingOrder(
    symbol: string,
    ohlc: OHLC[],
    accountEquity: number,
    riskPerTrade: number,
    pendingOrder: {
      action: "BUY" | "SELL";
      entryPrice: number;
      reason: string;
    }
  ): Promise<PendingOrderDecision> {
    const signal = await this.analyzeMarket(
      symbol,
      ohlc,
      accountEquity,
      riskPerTrade
    );

    if (signal.decision !== "APPROVE" || !signal.action) {
      return {
        decision: "CANCEL",
        reason: `重新评估结果为 REJECT，撤销挂单。原因：${signal.reason}`,
      };
    }

    if (signal.action !== pendingOrder.action) {
      return {
        decision: "CANCEL",
        reason: `重新评估方向已变化(${signal.action})，撤销原${pendingOrder.action}挂单。原因：${signal.reason}`,
      };
    }

    const proposedEntry = signal.entryPrice;
    const existingEntry = pendingOrder.entryPrice;
    const denom = existingEntry > 0 ? existingEntry : 1;
    const relDiff = Math.abs(proposedEntry - existingEntry) / denom;

    if (!Number.isFinite(relDiff) || relDiff > 0.002) {
      return {
        decision: "CANCEL",
        reason: `重新评估的进场价与现有挂单偏离过大(偏离率=${(
          relDiff * 100
        ).toFixed(3)}%)，撤销后等待新信号。原因：${signal.reason}`,
      };
    }

    return {
      decision: "KEEP",
      reason: `重新评估仍然认可该方向与价格区间，继续等待触发。原因：${signal.reason}`,
    };
  }
}
