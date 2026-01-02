import { OHLC, EnrichedOHLC, AlBrooksFeatures } from "../types";
import { TechnicalIndicators } from "../utils/indicators";
import { ConfigLoader } from "../config/config";

export class ContextBuilder {
  /**
   * Builds the Multi-Timeframe (MTF) context for the LLM.
   * - Trading: Detailed features (Al Brooks) + EMA
   * - Context: EMA only
   * - Trend: EMA only
   */
  public static buildMTFContext(
    tradingData: OHLC[],
    contextData: OHLC[],
    trendData: OHLC[],
    timeframes: { trading: string; context: string; trend: string }
  ): string {
    const tradingContext = this.enrichData(tradingData, true);
    const contextContext = this.enrichData(contextData, false);
    const trendContext = this.enrichData(trendData, false);

    const parts: string[] = [];
    parts.push("=== MARKET DATA (MTF) ===");
    parts.push("");
    parts.push(this.formatTrendData(trendContext, timeframes.trend));
    parts.push("");
    parts.push(this.formatContextData(contextContext, timeframes.context));
    parts.push("");
    parts.push(this.formatTradingData(tradingContext, timeframes.trading));

    return parts.join("\n");
  }

  private static formatTrendData(
    data: EnrichedOHLC[],
    interval: string
  ): string {
    const lines: string[] = [];
    lines.push(
      `[TREND: ${interval.toUpperCase()}] (Major Direction & Structure)`
    );
    lines.push(`Time        | Close     | EMA20     | Note`);

    data.forEach(bar => {
      const timeStr = this.formatDate(bar.timestamp, "MM-DD HH:mm");
      const closeStr = bar.close.toFixed(2).padEnd(9);
      const emaStr = bar.ema20 ? bar.ema20.toFixed(2).padEnd(9) : "         ";

      let note = "";
      if (bar.ema20) {
        if (bar.low > bar.ema20) note = "Above EMA";
        else if (bar.high < bar.ema20) note = "Below EMA";
        else note = "Testing EMA";
      }

      lines.push(`${timeStr.padEnd(11)} | ${closeStr} | ${emaStr} | ${note}`);
    });
    return lines.join("\n");
  }

  private static formatContextData(
    data: EnrichedOHLC[],
    interval: string
  ): string {
    const lines: string[] = [];
    lines.push(
      `[CONTEXT: ${interval.toUpperCase()}] (Support/Resistance & Immediate Bias)`
    );
    lines.push(`Time   | High      | Low       | Close     | EMA20     | Rel`);

    data.forEach(bar => {
      const timeStr = this.formatDate(bar.timestamp, "HH:mm");
      const highStr = bar.high.toFixed(2).padEnd(9);
      const lowStr = bar.low.toFixed(2).padEnd(9);
      const closeStr = bar.close.toFixed(2).padEnd(9);
      const emaStr = bar.ema20 ? bar.ema20.toFixed(2).padEnd(9) : "         ";

      let rel = "";
      if (bar.ema20) {
        if (bar.low > bar.ema20) rel = "Above";
        else if (bar.high < bar.ema20) rel = "Below";
        else rel = "On";
      }

      lines.push(
        `${timeStr.padEnd(
          6
        )} | ${highStr} | ${lowStr} | ${closeStr} | ${emaStr} | ${rel}`
      );
    });
    return lines.join("\n");
  }

  private static formatTradingData(
    data: EnrichedOHLC[],
    interval: string
  ): string {
    const lines: string[] = [];
    lines.push(
      `[TRADING: ${interval.toUpperCase()}] (Signal & Timing - Detailed)`
    );
    lines.push(
      `Time   | Open    High    Low     Close   | EMA20   | Vol   | Bar(Str) | E-Rel`
    );

    data.forEach((bar, index) => {
      const isLast = index === data.length - 1;
      const timeStr = this.formatDate(bar.timestamp, "HH:mm");
      // Open High Low Close compact
      const o = bar.open.toFixed(2);
      const h = bar.high.toFixed(2);
      const l = bar.low.toFixed(2);
      const c = bar.close.toFixed(2);
      const ohlcStr = `${o} ${h} ${l} ${c}`.padEnd(31);

      const emaStr = bar.ema20 ? bar.ema20.toFixed(2).padEnd(7) : "       ";
      const volStr = this.formatVolume(bar.volume).padEnd(5);

      let barStr = "        ";
      let eRel = "     ";

      if (bar.features) {
        const typeCode = this.getShortBarType(bar.features.bar_type);
        const str = bar.features.close_strength.toFixed(2);
        barStr = `${typeCode}(${str})`; // e.g. BT(0.75)
        eRel = bar.features.ema_relation;
      } else if (bar.ema20) {
        // Fallback if no features
        if (bar.low > bar.ema20) eRel = "Above";
        else if (bar.high < bar.ema20) eRel = "Below";
        else eRel = "On";
      }

      let line = `${timeStr.padEnd(
        6
      )} | ${ohlcStr} | ${emaStr} | ${volStr} | ${barStr.padEnd(8)} | ${eRel}`;
      if (isLast) {
        line += " <-- CURRENT SIGNAL";
      }
      lines.push(line);
    });
    return lines.join("\n");
  }

  private static formatDate(
    timestamp: number,
    format: "MM-DD HH:mm" | "HH:mm"
  ): string {
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");

    if (format === "MM-DD HH:mm") {
      return `${month}-${day} ${hours}:${minutes}`;
    }
    return `${hours}:${minutes}`;
  }

  private static formatVolume(vol: number): string {
    if (vol >= 1000000) return (vol / 1000000).toFixed(1) + "M";
    if (vol >= 1000) return (vol / 1000).toFixed(1) + "K";
    return String(Math.round(vol));
  }

  private static getShortBarType(type: string): string {
    if (type === "Bull Trend") return "BT";
    if (type === "Bear Trend") return "BR";
    return "DJ";
  }

  private static enrichData(
    ohlc: OHLC[],
    includeFeatures: boolean
  ): EnrichedOHLC[] {
    const ema20 = TechnicalIndicators.calculateEMA(ohlc, 20);
    const volSMA = includeFeatures ? this.calculateVolumeSMA(ohlc, 20) : [];

    return ohlc.map((bar, index) => {
      const result: EnrichedOHLC = {
        ...bar,
        ema20: ema20[index] || undefined,
      };

      if (includeFeatures) {
        const prevBar = index > 0 ? ohlc[index - 1] : null;
        result.features = this.calculateFeatures(
          bar,
          prevBar,
          ema20[index],
          volSMA[index] || null
        );
      }

      return result;
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
}
