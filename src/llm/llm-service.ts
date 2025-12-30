import OpenAI from "openai";
import { ConfigLoader } from "../config/config";
import { logger } from "../utils/logger";
import { TradeSignal, OHLC, LLMPromptContext } from "../types";
import { ChartUtils } from "../utils/chart-utils";

export class LLMService {
  private openai: OpenAI;
  private model: string;

  constructor() {
    const config = ConfigLoader.getInstance();
    this.openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    this.model = config.llm.model;
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
    const asciiChart = ChartUtils.generateCandlestickChart(ohlc);

    // 2. Prepare Context (Internal use or logging)
    const context: LLMPromptContext = {
      symbol,
      accountEquity,
      riskPerTrade,
      ohlcData: ohlc,
      asciiChart,
    };

    // 3. Construct Prompt
    const systemPrompt = `You are an expert Crypto Day Trader specializing in **Al Brooks Price Action Trading** on 15-minute timeframes.
Your goal is to identify high-probability trade setups (>60% win rate) or good risk/reward setups (>1:2) based strictly on Price Action principles.

### CORE PHILOSOPHY (Al Brooks)
1. **Context is King**: Always determine the Market Cycle first (Trend, Trading Range, Breakout Mode).
2. **Every Tick Matters**: Analyze bar bodies, tails (wicks), and closes relative to the bar range.
3. **Trader's Equation**: Probability * Reward > (1 - Probability) * Risk.

### ANALYSIS FRAMEWORK
1. **Market Cycle Phase**:
   - **Strong Trend**: Gaps between bars, strong breakout bars. -> *Action*: Enter on Pullbacks (H1/H2 Bull Flags, L1/L2 Bear Flags).
   - **Trading Range**: Sideways overlapping bars, prominent tails. -> *Action*: Buy Low, Sell High (BLSHS). Fade breakouts.
   - **Trend Channel Line (Overshoot)**: Look for wedges and reversals.

2. **Setup Identification**:
   - **Wedges**: 3 pushes up/down with converging slope. High probability reversal pattern.
   - **MTR (Major Trend Reversal)**: Break of trend line + test of extreme.
   - **Double Top/Bottom**: Look for "Twin Peaks" or lower high/higher low variants.
   - **Final Flag**: Horizontal range after a long trend often leads to reversal.

3. **Signal Bar Evaluation (Crucial)**:
   - The *last completed bar* is your potential Signal Bar.
   - **Bull Signal**: Strong body (close > open), close in top 1/3, small top tail.
   - **Bear Signal**: Strong body (close < open), close in bottom 1/3, small bottom tail.
   - **Bad Signal**: Dojis, weak closes, large tails against the direction. *Avoid entering on bad signal bars unless limit order scaling in (not recommended here).*

### EXECUTION RULES
- **Order Type**: Primarily **STOP** orders (Breakout entry).
  - BUY: Place Stop 1 tick above Signal Bar High.
  - SELL: Place Stop 1 tick below Signal Bar Low.
- **Stop Loss**:
  - Beyond the other side of the Signal Bar (1 tick below Low for Buy).
  - If Signal Bar is huge, use 50% retracement or Measured Move risk.
- **Take Profit**:
  - Minimum 1:1 for high probability setups.
  - Aim for 1:2 for reversal setups.

### OUTPUT FORMAT
You MUST return a strictly valid JSON object. No markdown, no "Here is the JSON".
{
    "decision": "APPROVE" | "REJECT",
    "reason": "Context: [Trend/Range]. Setup: [H1/Wedge/etc]. Signal Bar: [Strong/Weak]. Probability: [High/Low].",
    "action": "BUY" | "SELL",
    "orderType": "STOP" | "MARKET",
    "entryPrice": number,
    "stopLoss": number,
    "takeProfit": number,
    "quantity": number
}`;

    // Format OHLC for prompt (Compact format to save tokens)
    const formattedOHLC = ohlc
      .map(
        (c, i) =>
          `[${i}] T:${new Date(c.timestamp).toISOString().substr(11, 5)} O:${
            c.open
          } H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
      )
      .join("\n");

    const userPrompt = `
Current Market Context:
Symbol: ${symbol}
Account Equity: ${accountEquity}
Risk Per Trade: ${riskPerTrade}

Recent OHLC Data (Last ${ohlc.length} bars, Index ${
      ohlc.length - 1
    } is the most recently CLOSED bar):
${formattedOHLC}

ASCII Chart (Visual Representation):
${asciiChart}

TASK:
1. Analyze the Market Cycle from the chart (Trend vs Range).
2. Count legs if applicable (Wedge counting, H1/H2 counts).
3. Evaluate Bar [${ohlc.length - 1}] as the Signal Bar.
4. Decide if a trade is warranted based on Al Brooks methodology.
   - If "APPROVE", calculate entry, SL, TP.
   - Calculate 'quantity' to risk exactly ${
     riskPerTrade * 100
   }% of Equity based on Stop Loss distance.
     Quantity = (Equity * ${riskPerTrade}) / |EntryPrice - StopLoss|

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

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error("LLM 返回内容为空");
      }

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
}
