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

    const context = {
      trading: {
        interval: timeframes.trading,
        data: tradingContext,
      },
      context: {
        interval: timeframes.context,
        data: contextContext,
      },
      trend: {
        interval: timeframes.trend,
        data: trendContext,
      },
    };

    return JSON.stringify(context, null, 2);
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
