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
    const systemPrompt = `You are an expert crypto trader specializing in Al Brooks Price Action trading on 15-minute timeframes. 
Your goal is to identify high-probability trade setups (Breakouts, Reversals, Ranges) based on the provided OHLC data and ASCII chart.
You MUST output your decision in strict JSON format matching the TradeSignal interface.
No markdown, no explanation outside the JSON.`;

    // Format OHLC for prompt (Compact format to save tokens)
    const formattedOHLC = ohlc
      .map(
        c =>
          `T:${new Date(c.timestamp).toISOString().substr(11, 5)} O:${
            c.open
          } H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
      )
      .join("\n");

    const userPrompt = `
Current Market Context:
Symbol: ${symbol}
Account Equity: ${accountEquity}
Risk Per Trade: ${riskPerTrade}

Recent OHLC Data (Last ${ohlc.length} candles):
${formattedOHLC}

ASCII Chart:
${asciiChart}

Analyze the price action. Look for setups like:
- Double Bottoms/Tops
- Wedges
- Strong Breakout Bars
- Pullbacks to EMA (conceptually)

Return a JSON object with this structure:
{
    "decision": "APPROVE" | "REJECT",
    "reason": "Concise reason for decision",
    "action": "BUY" | "SELL" (optional if REJECT),
    "orderType": "STOP" | "MARKET",
    "entryPrice": number,
    "stopLoss": number,
    "takeProfit": number,
    "quantity": number
}

Calculate quantity based on Risk Per Trade (${
      riskPerTrade * 100
    }% of Equity) and Stop Loss distance.
Quantity = (Equity * RiskPerTrade) / |EntryPrice - StopLoss|
Ensure strict risk management.
`;

    // 4. Call LLM
    try {
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2, // Low temp for analytical tasks
      });

      const content = completion.choices[0].message.content;
      if (!content) {
        throw new Error("Empty response from LLM");
      }

      const signal = JSON.parse(content) as TradeSignal;
      return signal;
    } catch (error) {
      logger.error("LLM Analysis Failed:", error);
      // Return a safe REJECT signal on error
      return {
        decision: "REJECT",
        reason: `Error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        entryPrice: 0,
        stopLoss: 0,
        takeProfit: 0,
        quantity: 0,
        orderType: "MARKET",
      };
    }
  }
}
