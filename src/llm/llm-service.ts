import OpenAI from "openai";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { ConfigLoader } from "../config/config";
import { logger } from "../utils/logger";
import {
  TradeSignal,
  OHLC,
  LLMPromptContext,
  PendingOrderDecision,
} from "../types";
import { ContextBuilder } from "./context-builder";
import { TechnicalIndicators } from "../utils/indicators";
import {
  buildIdentitySystemPrompt,
  getIdentityRoleRiskParams,
  resolveLlmIdentityRole,
  type LlmIdentityRole,
} from "./prompts/identity-prompts";

export class LLMService {
  private openai: OpenAI;
  private model: string;
  private logInteractions: boolean;
  private temperature?: number;
  private topP?: number;
  private maxTokens?: number;
  private reasoningEffort?: "ignore" | "none" | "low" | "medium" | "high";
  private identityRole: LlmIdentityRole;

  private visionEnabled: boolean;
  private visionCapabilityChecked: boolean;
  private visionCapabilityAvailable: boolean;

  constructor() {
    const config = ConfigLoader.getInstance();
    this.openai = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    });
    this.model = config.llm.model;
    this.identityRole = resolveLlmIdentityRole(config.llm.identityRole);
    this.logInteractions = config.llm.logInteractions;
    this.temperature = config.llm.temperature;
    this.topP = config.llm.topP;
    this.maxTokens = config.llm.maxTokens;
    this.reasoningEffort = config.llm.reasoningEffort;

    this.visionEnabled = Boolean(config.llm.visionEnabled);
    this.visionCapabilityChecked = false;
    this.visionCapabilityAvailable = false;
  }

  private async ensureVisionCapabilityChecked(): Promise<void> {
    // 1. 如果配置已禁用，直接标记不可用
    if (!this.visionEnabled) {
      this.visionCapabilityChecked = true;
      this.visionCapabilityAvailable = false;
      return;
    }

    // 2. 如果已经检查过，直接返回
    if (this.visionCapabilityChecked) return;
    this.visionCapabilityChecked = true;

    // 建议使用稍微大一点的图片，增加 Provider 兼容性
    // 这是一个 64x64 的纯黑色 PNG
    let testImageDataUrl =
      "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg";

    try {
      const localTestImagePath = path.join(__dirname, "test.png");
      if (fs.existsSync(localTestImagePath)) {
        const imageBuffer = fs.readFileSync(localTestImagePath);
        const base64Image = imageBuffer.toString("base64");
        testImageDataUrl = `data:image/png;base64,${base64Image}`;
        logger.llm(`[LLM 服务] 使用本地测试图片: ${localTestImagePath}`);
      } else {
        logger.llm(
          `[LLM 服务] 本地测试图片不存在 (${localTestImagePath})，将使用默认网络图片`
        );
      }
    } catch (err) {
      logger.warn(
        `[LLM 服务] 读取本地测试图片失败: ${err}，将使用默认网络图片`
      );
    }

    try {
      logger.llm(`[LLM 服务] 正在验证主 LLM 图片识别能力 (${this.model})...`);

      await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this image?" },
              {
                type: "image_url",
                image_url: {
                  url: testImageDataUrl,
                  detail: "low", // 强制低精度，省钱且减少 400 报错概率
                },
              },
            ],
          },
        ],
        max_tokens: 5, // 只需要模型开口就行
        temperature: 0,
      });

      this.visionCapabilityAvailable = true;
      logger.llm(`[LLM 服务] ${this.model} 图片识别验证通过。`);
    } catch (error: any) {
      this.visionCapabilityAvailable = false;
      // 这里打印完整的 error 对象，能帮你确定具体的 400 原因
      const errorDetails =
        error?.response?.data || error?.message || String(error);
      logger.warn(`[LLM 服务] 验证失败: ${JSON.stringify(errorDetails)}`);
    }
  }

  public async validateVisionCapability(): Promise<boolean> {
    await this.ensureVisionCapabilityChecked();
    return this.visionCapabilityAvailable;
  }

  private formatTimeLabel(timestampMs: number): string {
    const d = new Date(timestampMs);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const HH = String(d.getHours()).padStart(2, "0");
    const MM = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
  }

  private getNiceStep(min: number, max: number, tickCount: number): number {
    const range = Math.max(0, max - min);
    if (range === 0) return 1;
    const rough = range / Math.max(1, tickCount - 1);
    const exponent = Math.floor(Math.log10(rough));
    const base = Math.pow(10, exponent);
    const fraction = rough / base;

    let niceFraction = 1;
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;

    return niceFraction * base;
  }

  private inferDecimals(step: number): number {
    if (!Number.isFinite(step) || step <= 0) return 2;
    if (step >= 1) return 2;
    const decimals = Math.ceil(-Math.log10(step)) + 1;
    return Math.min(8, Math.max(2, decimals));
  }

  private renderCandlesToPngBuffer(ohlc: OHLC[]): Buffer {
    const width = 1200;
    const height = 700;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const margin = { left: 100, right: 100, top: 50, bottom: 85 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const left = margin.left;
    const top = margin.top;
    const right = left + plotW;
    const bottom = top + plotH;

    let minY = ohlc.reduce((m, c) => Math.min(m, c.low), Infinity);
    let maxY = ohlc.reduce((m, c) => Math.max(m, c.high), -Infinity);

    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
      throw new Error("OHLC 价格无效，无法绘图");
    }
    if (minY === maxY) {
      const pad = minY === 0 ? 1 : Math.abs(minY) * 0.01;
      minY -= pad;
      maxY += pad;
    } else {
      const pad = (maxY - minY) * 0.06;
      minY -= pad;
      maxY += pad;
    }

    const yFor = (price: number) =>
      top + ((maxY - price) / (maxY - minY)) * plotH;
    const xForIndex = (i: number) => {
      if (ohlc.length <= 1) return left + plotW / 2;
      return left + (i / (ohlc.length - 1)) * plotW;
    };

    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, plotW, plotH);

    const majorTickCount = Math.max(
      10,
      Math.min(16, Math.round(plotH / 55) + 1)
    );
    const yStep = this.getNiceStep(minY, maxY, majorTickCount);
    const yDecimals = this.inferDecimals(yStep);
    const yStart = Math.floor(minY / yStep) * yStep;

    ctx.font = "12px Arial";

    const minorDivisions = 2;
    const yMinorStep = yStep / minorDivisions;
    const minorLineCount =
      Number.isFinite(yMinorStep) && yMinorStep > 0
        ? (maxY - minY) / yMinorStep
        : Number.POSITIVE_INFINITY;
    if (
      Number.isFinite(yMinorStep) &&
      yMinorStep > 0 &&
      Number.isFinite(minorLineCount) &&
      minorLineCount <= 300
    ) {
      const minorStart = Math.floor(minY / yMinorStep) * yMinorStep;
      ctx.strokeStyle = "#f3f4f6";
      ctx.lineWidth = 1;
      for (let v = minorStart; v <= maxY + yMinorStep * 0.5; v += yMinorStep) {
        if (v < minY - 1e-12) continue;
        const y = yFor(v);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#111827";
    for (let v = yStart; v <= maxY + yStep * 0.5; v += yStep) {
      if (v < minY - 1e-12) continue;
      const y = yFor(v);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();

      const label = v.toFixed(yDecimals);
      const textW = ctx.measureText(label).width;
      ctx.fillText(label, left - 10 - textW, y + 4);
      ctx.fillText(label, right + 10, y + 4);

      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left - 6, y);
      ctx.lineTo(left, y);
      ctx.moveTo(right, y);
      ctx.lineTo(right + 6, y);
      ctx.stroke();
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 1;
    }

    const perIndexW = plotW / Math.max(1, ohlc.length - 1);
    const minLabelSpacingPx = 140;
    const xLabelEvery = Math.max(1, Math.ceil(minLabelSpacingPx / perIndexW));

    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#111827";
    for (let i = 0; i < ohlc.length; i++) {
      if (i % xLabelEvery !== 0 && i !== ohlc.length - 1 && i !== 0) continue;
      const x = xForIndex(i);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();

      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, bottom);
      ctx.lineTo(x, bottom + 6);
      ctx.stroke();
      ctx.strokeStyle = "#f3f4f6";
      ctx.lineWidth = 1;

      const t = this.formatTimeLabel(ohlc[i].timestamp);
      const w = ctx.measureText(t).width;
      const yLine = i % (xLabelEvery * 2) === 0 ? bottom + 20 : bottom + 38;
      const xText = Math.max(0, Math.min(width - w, x - w / 2));
      ctx.fillText(t, xText, yLine);
    }

    const candlePixelSpan = plotW / Math.max(1, ohlc.length);
    const bodyW = Math.max(2, Math.floor(candlePixelSpan * 0.6));
    const wickW = Math.max(1, Math.floor(bodyW / 3));

    for (let i = 0; i < ohlc.length; i++) {
      const c = ohlc[i];
      const x = xForIndex(i);
      const yHigh = yFor(c.high);
      const yLow = yFor(c.low);
      const yOpen = yFor(c.open);
      const yClose = yFor(c.close);
      const isBull = c.close >= c.open;

      ctx.strokeStyle = "#111827";
      ctx.lineWidth = wickW;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      const bodyTop = Math.min(yOpen, yClose);
      const bodyBottom = Math.max(yOpen, yClose);
      const bodyH = Math.max(1, bodyBottom - bodyTop);
      ctx.fillStyle = isBull ? "#16a34a" : "#dc2626";
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1;
      ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
      ctx.strokeRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
    }

    return canvas.toBuffer("image/png");
  }

  private buildChartImageDataUrl(ohlc: OHLC[]): {
    dataUrl: string;
    bytes: number;
    sha256_12: string;
    base64Chars: number;
  } {
    const buf = this.renderCandlesToPngBuffer(ohlc);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const base64 = buf.toString("base64");
    return {
      dataUrl: `data:image/png;base64,${base64}`,
      bytes: buf.length,
      sha256_12: sha256.slice(0, 12),
      base64Chars: base64.length,
    };
  }

  private getMinNetRR(): number {
    return getIdentityRoleRiskParams(this.identityRole).minNetRR;
  }

  private buildSystemPrompt(params: {
    timeframe: string;
    commissionRatePercent: number;
  }): string {
    const identityPrompt = buildIdentitySystemPrompt(this.identityRole, {
      timeframe: params.timeframe,
    });

    const minNetRR = this.getMinNetRR();

    return `${identityPrompt}

### FEES (Commission)
- The user's commission rate is ${params.commissionRatePercent}% per side.
- When evaluating profit and risk/reward, you MUST subtract commissions for BOTH entry and exit.


### Take Profit
- Targeting Rule: Do NOT use a fixed multiplier (like 1.5x) for Take Profit. Instead, look at the Chart Image and Macro Context to identify the Next Major Resistance Level (e.g., previous swing high, H4 resistance). Set Take Profit at that structural level. Rationale: We are trading breakouts. If the breakout succeeds, price should travel to the next magnet level, providing a much higher R/R (e.g., 1:3, 1:5).


### DATA INPUT FORMAT ("Telescope" Strategy)
You will receive data in up to three layers:
1. **Chart Image** (Optional): A visual representation of the recent price action (Candlestick Chart).
2. **Macro Context**: Summarized history to understand the big picture (Trend vs Range).
3. **Micro Action**: Detailed recent bars with pre-calculated Al Brooks features.
   - The list is sorted chronologically: **Oldest -> Newest**.
   - The **LAST BAR** in the list is the **CURRENT SIGNAL BAR** you must evaluate.
   - \`bar_type\`: "Bull Trend", "Bear Trend", or "Doji".
   - \`close_strength\`: 0.0 (Low) to 1.0 (High). Indicates buying/selling pressure.
   - \`ema_relation\`: Position relative to 20 EMA.
   - \`overlap\`: Market churn/indecision.

**IMPORTANT HANDLING INSTRUCTIONS**:
- **If you receive a Chart Image**: You MUST analyze the image FIRST. The visual market background shown in the image is the primary source of truth. Use Macro and Micro data to support your visual analysis.
- **If you DO NOT receive a Chart Image**: Proceed directly with analyzing the Macro and Micro data.

**INSTRUCTION**: DO NOT calculate raw numbers manually. Trust the provided feature tags. Focus on the LATEST bar for signal confirmation.

### CORE PHILOSOPHY (Al Brooks)
1. **Context is King**: Always determine the Market Cycle first.
2. **Trader's Equation**: Probability * Reward > (1 - Probability) * Risk.
3. **20-Period EMA**: Primary trend reference.
   - Price > EMA = Bullish bias.
   - Price < EMA = Bearish bias.

### ANALYSIS FRAMEWORK
1. **Visual Analysis** (If Image Provided):
   - Identify Support/Resistance levels and Trendlines visually.
   - Recognize visual Chart Patterns (e.g., Head & Shoulders, Flags, Triangles).
   - Assess the "quality" of the bars (size, tails) visually to gauge momentum.
2. **Market Cycle Phase** (Confirm with Macro/Micro data):
   - **Strong Trend**: Gaps, strong breakout bars. -> *Action*: Enter on Pullbacks (H1/H2, L1/L2).
   - **Trading Range**: Overlapping bars, Dojis, oscilating around EMA. -> *Action*: Buy Low, Sell High. Fade breakouts.
3. **Setup Identification**:
   - **Wedges**: 3 pushes. Reversal pattern.
   - **MTR**: Major Trend Reversal.
   - **Double Top/Bottom**.
4. **Signal Bar Evaluation**:
   - Look for high \`close_strength\` in direction of trade.
   - Avoid entering on Dojis or weak bars unless scaling in.

### EXECUTION RULES
- **Order Type**: Primarily **STOP** orders (Breakout entry).
  - BUY: 1 tick above Signal Bar High.
  - SELL: 1 tick below Signal Bar Low.

### OUTPUT FORMAT (Chain of Thought)
You MUST return a strictly valid JSON object.
{
    "decision": "APPROVE" | "REJECT",
    "reason": "使用简体中文总结您的分析步骤。说明为何批准或拒绝。",
    "action": "BUY" | "SELL",
    "orderType": "STOP",
    "entryPrice": number,
    "stopLoss": number,
    "takeProfit": number
}`;
  }

  /**
   * 测试 LLM 连接
   * @returns Promise<boolean>
   */
  public async testConnection(): Promise<boolean> {
    try {
      logger.llm(`正在测试 LLM 连接 (${this.model})...`);
      // 发送简单消息测试连接，限制 max_tokens 以节省成本和避免超时
      await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      });
      logger.llm("LLM 连接成功！");
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
    const config = ConfigLoader.getInstance();
    const commissionRatePercent = config.execution.commission_rate_percent;

    // 2. Prepare Context (Internal use or logging)
    const context: LLMPromptContext = {
      symbol,
      accountEquity,
      riskPerTrade,
      ohlcData: ohlc,
    };

    // 3. Construct Prompt
    const timeframe = ConfigLoader.getInstance().strategy.timeframe;
    const minNetRR = this.getMinNetRR();
    const systemPrompt = this.buildSystemPrompt({
      timeframe,
      commissionRatePercent,
    });

    // Format OHLC using ContextBuilder
    const formattedContext = ContextBuilder.buildContext(ohlc);

    const userPromptTextOnly = `
Current Market Context:
Symbol: ${symbol}
Account Equity: ${accountEquity}
Risk Per Trade: ${riskPerTrade}
Commission Rate (per side, percent): ${commissionRatePercent}

Fee Rule:
- NetReward = GrossReward - (EntryFee + ExitFee)
- Fee is charged on notional at both entry and exit.
- If net profit after entry+exit fees is <= 0, or net R/R < ${minNetRR}, return REJECT.

MARKET DATA:
${formattedContext}

TASK:
1. Analyze the Market Cycle (Macro & Micro).
2. Identify Setups.
3. Evaluate the Signal Bar (Last bar).
4. Make a Decision.

Return JSON only.
`;

    const userPromptVisionMain = `
Current Market Context:
Symbol: ${symbol}
Account Equity: ${accountEquity}
Risk Per Trade: ${riskPerTrade}
Commission Rate (per side, percent): ${commissionRatePercent}

Fee Rule:
- NetReward = GrossReward - (EntryFee + ExitFee)
- Fee is charged on notional at both entry and exit.
- If net profit after entry+exit fees is <= 0, or net R/R < ${minNetRR}, return REJECT.

MARKET DATA:
${formattedContext}

CHART IMAGE:
- A candlestick chart image is attached to this request. Read it as the primary visual reference.

TASK:
0. Analyze the chart image first. Extract key price-action structures and levels.
1. Analyze the Macro Context section in MARKET DATA.
2. Analyze the Micro Action section in MARKET DATA (focus on the LAST BAR).
3. Identify setups and evaluate the Signal Bar.
4. Make a Decision.

Return JSON only.
`;

    try {
      await this.ensureVisionCapabilityChecked();
      const shouldUseVisionMain =
        this.visionEnabled && this.visionCapabilityAvailable;

      const userPrompt = shouldUseVisionMain
        ? userPromptVisionMain
        : userPromptTextOnly;

      const client = this.openai;
      const model = this.model;

      let messages: any[];
      if (shouldUseVisionMain) {
        const chart = this.buildChartImageDataUrl(ohlc);
        messages = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: chart.dataUrl } },
            ] as any,
          },
        ];
        logger.llm(`[LLM 服务] 主分析已启用K线图像分析 (${model})`);
        logger.llm(
          `[LLM 服务] 已生成K线图像并附加到主分析请求: candles=${ohlc.length} bytes=${chart.bytes} base64Chars=${chart.base64Chars} sha256_12=${chart.sha256_12}`
        );
      } else {
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ];
      }

      const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
        {
          model,
          messages,
          response_format: { type: "json_object" },
          ...(this.temperature !== undefined
            ? { temperature: this.temperature }
            : {}),
          ...(this.topP !== undefined ? { top_p: this.topP } : {}),
          ...(this.maxTokens !== undefined
            ? { max_tokens: this.maxTokens }
            : {}),
          ...(this.reasoningEffort !== undefined &&
          this.reasoningEffort !== "ignore" &&
          this.reasoningEffort !== "none"
            ? { reasoning_effort: this.reasoningEffort }
            : {}),
        };

      const response = await client.chat.completions.create(createParams);

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

    const minNetRR = this.getMinNetRR();

    if (netReward <= 0 || netRR < minNetRR) {
      const rrText = Number.isFinite(netRR) ? netRR.toFixed(4) : String(netRR);
      return {
        ...signal,
        decision: "REJECT",
        reason: `已按佣金费率 ${commissionRatePercent}% 计算净盈亏比后拒绝：净R/R=${rrText} (阈值>=${minNetRR})，净收益=${netReward.toFixed(
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
