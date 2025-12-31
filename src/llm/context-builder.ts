import { OHLC, EnrichedOHLC, AlBrooksFeatures } from "../types";
import { TechnicalIndicators } from "../utils/indicators";
import { ConfigLoader } from "../config/config";

export class ContextBuilder {
  /**
   * Builds the context for the LLM using the "Telescope" strategy.
   * Splits data into Macro (summarized) and Micro (detailed with features).
   */
  public static buildContext(ohlc: OHLC[]): string {
    if (!ohlc || ohlc.length === 0) return "No Data Available";

    const config = ConfigLoader.getInstance();
    const microCount = config.strategy.telescope.micro_count;
    const macroGroupSize = config.strategy.telescope.macro_group_size;

    // 1. Enrich Data with Indicators (EMA 20)
    const enrichedData = this.enrichData(ohlc);

    // 2. Split Data
    const splitIndex = Math.max(0, enrichedData.length - microCount);

    const macroData = enrichedData.slice(0, splitIndex);
    const microData = enrichedData.slice(splitIndex);

    // 3. Build Macro Context (Summarized)
    const macroContext = this.buildMacroContext(macroData, macroGroupSize);

    // 4. Build Micro Context (Detailed with Features)
    const microContext = this.buildMicroContext(microData);

    return `
=== MACRO CONTEXT (Historical Summary, ${macroGroupSize}-Bar Blocks) ===
${macroContext}

=== MICRO ACTION (Recent ${microData.length} Bars with Al Brooks Features) ===
${microContext}
`;
  }

  private static enrichData(ohlc: OHLC[]): EnrichedOHLC[] {
    const ema20 = TechnicalIndicators.calculateEMA(ohlc, 20);

    // Calculate Volume SMA for Vol Spike
    const volSMA = this.calculateVolumeSMA(ohlc, 20);

    return ohlc.map((bar, index) => {
      const prevBar = index > 0 ? ohlc[index - 1] : null;
      const features = this.calculateFeatures(
        bar,
        prevBar,
        ema20[index],
        volSMA[index]
      );

      return {
        ...bar,
        ema20: ema20[index] || undefined,
        features,
      };
    });
  }

  private static calculateVolumeSMA(
    ohlc: OHLC[],
    period: number
  ): (number | null)[] {
    // Simple moving average for volume
    const smas: (number | null)[] = [];
    for (let i = 0; i < ohlc.length; i++) {
      if (i < period - 1) {
        smas.push(null);
        continue;
      }
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += ohlc[i - j].volume;
      }
      smas.push(sum / period);
    }
    return smas;
  }

  private static calculateFeatures(
    bar: OHLC,
    prevBar: OHLC | null,
    ema: number | null,
    avgVol: number | null
  ): AlBrooksFeatures {
    const range = bar.high - bar.low;
    const body = Math.abs(bar.close - bar.open);
    const isBull = bar.close > bar.open;

    // 1. Bar Type
    let bar_type: "Bull Trend" | "Bear Trend" | "Doji" = "Doji";
    if (range > 0) {
      if (body / range > 0.6) {
        bar_type = isBull ? "Bull Trend" : "Bear Trend";
      }
    }

    // 2. Close Strength
    let close_strength = 0.5;
    if (range > 0) {
      close_strength = (bar.close - bar.low) / range;
    }

    // 3. EMA Relation
    let ema_relation: "Above" | "Below" | "On" = "On";
    if (ema !== null) {
      if (bar.low > ema) ema_relation = "Above";
      else if (bar.high < ema) ema_relation = "Below";
      else ema_relation = "On"; // Touching or crossing
    }

    // 4. Vol Spike
    const vol_spike = avgVol ? bar.volume > 2 * avgVol : false;

    // 5. Overlap
    let overlap = false;
    if (prevBar) {
      const prevBodyTop = Math.max(prevBar.open, prevBar.close);
      const prevBodyBottom = Math.min(prevBar.open, prevBar.close);
      // Overlap usually means bodies overlap, or high/low overlap.
      // Al Brooks often refers to overlap as lack of gaps.
      // Let's use High/Low overlap for general "Trading Range" feel.
      overlap = bar.high >= prevBar.low && bar.low <= prevBar.high;
    }

    return {
      bar_type,
      close_strength: Number(close_strength.toFixed(2)),
      ema_relation,
      vol_spike,
      overlap,
    };
  }

  private static buildMacroContext(
    data: EnrichedOHLC[],
    groupSize: number
  ): string {
    if (data.length === 0) return "(No historical data)";

    const summaries: string[] = [];

    for (let i = 0; i < data.length; i += groupSize) {
      const chunk = data.slice(i, i + groupSize);
      if (chunk.length === 0) continue;

      const first = chunk[0];
      const last = chunk[chunk.length - 1];

      let maxHigh = -Infinity;
      let minLow = Infinity;

      chunk.forEach(c => {
        if (c.high > maxHigh) maxHigh = c.high;
        if (c.low < minLow) minLow = c.low;
      });

      const startTime = new Date(first.timestamp)
        .toISOString()
        .substring(11, 16); // HH:MM
      // Trend direction in this block
      const change = last.close - first.open;
      const trend = change > 0 ? "UP" : "DOWN";
      const volatility = maxHigh - minLow;

      summaries.push(`[${startTime}] H:${maxHigh} L:${minLow} Dir:${trend}`);
    }

    return summaries.join(" -> ");
  }

  private static buildMicroContext(data: EnrichedOHLC[]): string {
    return data
      .map((bar, i) => {
        const time = new Date(bar.timestamp).toISOString().substring(11, 16);
        const f = bar.features!;
        const emaStr = bar.ema20 ? bar.ema20.toFixed(2) : "N/A";

        return `Bar[${i}] ${time} | O:${bar.open} H:${bar.high} L:${bar.low} C:${bar.close} | Type:${f.bar_type} Str:${f.close_strength} EMA:${f.ema_relation}(${emaStr}) VolSpike:${f.vol_spike} Overlap:${f.overlap}`;
      })
      .join("\n");
  }
}
