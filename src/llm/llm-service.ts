import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { ConfigLoader } from "../config/config";
import { logger } from "../utils/logger";
import { TradeSignal, OHLC, LLMPromptContext } from "../types";
import { ChartUtils } from "../utils/chart-utils";
import { ContextBuilder } from "./context-builder";
import { TechnicalIndicators } from "../utils/indicators";

export class LLMService {
  private openai: OpenAI;
  private model: string;
  private logInteractions: boolean;
  private includeChart: boolean;

  constructor() {
    const config = ConfigLoader.getInstance();
    this.openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    this.model = config.llm.model;
    this.logInteractions = config.llm.logInteractions;
    this.includeChart = config.llm.includeChart;
  }

  /**
   * 测试 LLM 连接
   * @returns Promise<boolean>
   */
  public async testConnection(): Promise<boolean> {
    try {
      logger.info(`正在测试 LLM 连接 (${this.model})...`);
      // 尝试列出模型作为连接测试
      await this.openai.models.list();
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
    const systemPrompt = `You are an expert Crypto Day Trader specializing in **Al Brooks Price Action Trading** on ${timeframe} timeframes.
Your goal is to identify high-probability trade setups (>60% win rate) or good risk/reward setups (>1:2) based strictly on Price Action principles.

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
1. **Context is King**: Always determine the Market Cycle first.
2. **Trader's Equation**: Probability * Reward > (1 - Probability) * Risk.
3. **20-Period EMA**: Primary trend reference.
   - Price > EMA = Bullish bias.
   - Price < EMA = Bearish bias.

### ANALYSIS FRAMEWORK
1. **Market Cycle Phase**:
   - **Strong Trend**: Gaps, strong breakout bars. -> *Action*: Enter on Pullbacks (H1/H2, L1/L2).
   - **Trading Range**: Overlapping bars, Dojis, oscilating around EMA. -> *Action*: Buy Low, Sell High. Fade breakouts.
2. **Setup Identification**:
   - **Wedges**: 3 pushes. Reversal pattern.
   - **MTR**: Major Trend Reversal.
   - **Double Top/Bottom**.
3. **Signal Bar Evaluation**:
   - Look for high \`close_strength\` in direction of trade.
   - Avoid entering on Dojis or weak bars unless scaling in.

### EXECUTION RULES
- **Order Type**: Primarily **STOP** orders (Breakout entry).
  - BUY: 1 tick above Signal Bar High.
  - SELL: 1 tick below Signal Bar Low.

### OUTPUT FORMAT (Chain of Thought)
You MUST return a strictly valid JSON object.
{
    "analysis_step_1_market_cycle": "String. Determine the phase (Strong Trend, Broad Channel, Trading Range, Breakout Mode). Cite Macro Context.",
    "analysis_step_2_setup": "String. Identify specific patterns (Wedge, MTR, H1/H2, etc).",
    "analysis_step_3_signal_bar": "String. Evaluate the last bar using 'close_strength' and 'bar_type'. Is it a strong Signal Bar?",
    "decision": "APPROVE" | "REJECT",
    "reason": "使用简体中文详细总结上述分析步骤。说明为何批准或拒绝。",
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
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      });

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

      const signal: TradeSignal = JSON.parse(content);
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

  /**
   * Analyzes an existing pending breakout order to decide whether to KEEP or CANCEL it.
   */
  public async analyzePendingOrder(
    symbol: string,
    ohlc: OHLC[],
    pendingOrder: {
      action: "BUY" | "SELL";
      entryPrice: number;
      reason: string;
    }
  ): Promise<{ decision: "KEEP" | "CANCEL"; reason: string }> {
    const asciiChart = ChartUtils.generateCandlestickChart(ohlc);

    const formattedOHLC = this.formatOHLCWithEMA(ohlc);

    const timeframe = ConfigLoader.getInstance().strategy.timeframe;
    const systemPrompt = `You are an expert Crypto Day Trader specializing in **Al Brooks Price Action Trading** on ${timeframe} timeframes.
You currently have a **PENDING BREAKOUT ORDER** (Stop Entry) in the market.
Your goal is to re-evaluate the market structure after the most recent candle close to decide if this order should remain active or be cancelled.

### DECISION FRAMEWORK
1. **Valid Setup**: If the original setup (e.g., Bull Flag, Wedge) is still valid and the market hasn't invalidated the premise -> **KEEP**.
2. **Invalidated**: 
   - If the market moved significantly against the direction -> **CANCEL**.
   - If the signal bar was a "trap" or the setup failed -> **CANCEL**.
   - If a better signal has appeared in the opposite direction -> **CANCEL**.
   - If the breakout didn't trigger within 1-2 candles (depending on context) and momentum is lost -> **CANCEL**.
3. **20-Period EMA Context**:
   - Ensure the trend relative to EMA supports the trade direction (unless it's a mean-reversion trade).
   - Watch for EMA acting as resistance/support against your trade.

### OUTPUT FORMAT
Strictly JSON.
IMPORTANT: The "reason" field MUST be in Simplified Chinese (简体中文).
{
  "decision": "KEEP" | "CANCEL",
  "reason": "使用简体中文解释原因。说明市场结构是否发生变化，EMA支撑阻力情况，为何维持或取消订单。"
}`;

    const userPrompt = `
Current Market Context:
Symbol: ${symbol}
Recent OHLC Data (Last ${ohlc.length} bars):
${formattedOHLC}

ASCII Chart:
${asciiChart}

PENDING ORDER DETAILS:
Type: ${pendingOrder.action} STOP ENTRY
Entry Price: ${pendingOrder.entryPrice}
Original Reason: ${pendingOrder.reason}

TASK:
Analyze the latest candle(s) relative to the pending order.
Should we keep waiting for this breakout, or has the opportunity passed/failed?
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      });

      this.logTokenUsage(response.usage);

      const content = response.choices[0].message.content;
      if (!content) throw new Error("Empty LLM response");

      await this.saveInteractionLog(
        "PENDING_ORDER",
        systemPrompt,
        userPrompt,
        content
      );

      return JSON.parse(content);
    } catch (error: any) {
      logger.error(
        `[LLM Service] Failed to analyze pending order: ${error.message}`
      );
      // Default to CANCEL on error for safety
      return { decision: "CANCEL", reason: "LLM Error or Timeout" };
    }
  }
}
