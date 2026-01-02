import { OHLC } from "../types";

export class Resampler {
  public static parseInterval(interval: string): number {
    const value = parseInt(interval);
    if (interval.endsWith("m")) return value * 60 * 1000;
    if (interval.endsWith("h")) return value * 60 * 60 * 1000;
    if (interval.endsWith("d")) return value * 24 * 60 * 60 * 1000;
    if (interval.endsWith("w")) return value * 7 * 24 * 60 * 60 * 1000;
    throw new Error(`Unknown interval format: ${interval}`);
  }

  /**
   * Resamples OHLC data from a smaller timeframe to a larger timeframe.
   * @param candles Source candles (must be sorted by timestamp)
   * @param sourceIntervalMs Source interval in milliseconds (optional, for validation)
   * @param targetIntervalMs Target interval in milliseconds
   */
  public static resample(candles: OHLC[], targetIntervalMs: number): OHLC[] {
    if (candles.length === 0) return [];

    const resampled: OHLC[] = [];
    let currentBucketStart = -1;
    let bucketCandles: OHLC[] = [];

    for (const candle of candles) {
      // Calculate start of the bucket this candle belongs to
      const bucketStart =
        Math.floor(candle.timestamp / targetIntervalMs) * targetIntervalMs;

      if (bucketStart !== currentBucketStart) {
        // Close previous bucket
        if (bucketCandles.length > 0) {
          resampled.push(this.aggregate(bucketCandles, currentBucketStart));
        }
        // Start new bucket
        currentBucketStart = bucketStart;
        bucketCandles = [candle];
      } else {
        bucketCandles.push(candle);
      }
    }

    // Close last bucket if it has data
    // Note: The last bucket might be incomplete if the source data ends mid-bucket.
    // For backtesting, we usually want to include it only if it's "closed" relative to our simulation time?
    // But this function just resamples data. The caller decides usage.
    if (bucketCandles.length > 0) {
      resampled.push(this.aggregate(bucketCandles, currentBucketStart));
    }

    return resampled;
  }

  private static aggregate(candles: OHLC[], timestamp: number): OHLC {
    const open = candles[0].open;
    const close = candles[candles.length - 1].close;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;

    for (const c of candles) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }

    return {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    };
  }
}
