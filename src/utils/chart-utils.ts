import { OHLC } from "../types";
import { TechnicalIndicators } from "./indicators";

export class ChartUtils {
  /**
   * Converts OHLC data into an ASCII candlestick chart.
   * @param ohlcData Array of OHLC data
   * @param height Height of the chart in lines (default: 20)
   * @param limit Number of recent bars to show (default: 48)
   * @returns string representation of the chart
   */
  public static generateCandlestickChart(
    ohlcData: OHLC[],
    height: number = 20,
    limit: number = 48
  ): string {
    if (!ohlcData || ohlcData.length === 0) return "";

    // 0. Calculate EMA on full data BEFORE slicing
    const emaPeriod = 20;
    const emaValues = TechnicalIndicators.calculateEMA(ohlcData, emaPeriod);

    // 1. Slice Data (Keep only the last 'limit' bars)
    const startIndex = Math.max(0, ohlcData.length - limit);
    const slicedData = ohlcData.slice(startIndex);
    const slicedEma = emaValues.slice(startIndex);

    if (slicedData.length === 0) return "";

    // 2. Calculate Min/Max Price (based on sliced data)
    let minPrice = Number.MAX_VALUE;
    let maxPrice = Number.MIN_VALUE;

    for (const candle of slicedData) {
      if (candle.low < minPrice) minPrice = candle.low;
      if (candle.high > maxPrice) maxPrice = candle.high;
    }

    // Adjust min/max to include EMA values if valid
    for (const ema of slicedEma) {
        if (ema !== null) {
            if (ema < minPrice) minPrice = ema;
            if (ema > maxPrice) maxPrice = ema;
        }
    }

    const priceRange = maxPrice - minPrice;
    if (priceRange === 0) return "Flat Market";

    const scale = (height - 1) / priceRange;

    // 3. Initialize Grid (rows x cols)
    const widthPerCandle = 3;
    const width = slicedData.length * widthPerCandle;
    const grid: string[][] = Array.from({ length: height }, () =>
      Array(width).fill(" ")
    );

    // 4. Draw Candles and EMA
    slicedData.forEach((candle, index) => {
      const x = index * widthPerCandle + 1; // Center of the candle

      // Calculate Y positions
      const yHigh = Math.round((maxPrice - candle.high) * scale);
      const yLow = Math.round((maxPrice - candle.low) * scale);
      const yOpen = Math.round((maxPrice - candle.open) * scale);
      const yClose = Math.round((maxPrice - candle.close) * scale);

      // Ensure bounds
      const clamp = (val: number) => Math.max(0, Math.min(height - 1, val));
      const yH = clamp(yHigh);
      const yL = clamp(yLow);
      const yO = clamp(yOpen);
      const yC = clamp(yClose);

      const yBodyTop = Math.min(yO, yC);
      const yBodyBottom = Math.max(yO, yC);

      // Draw Wick
      for (let y = yH; y <= yL; y++) {
        grid[y][x] = "│";
      }

      // Draw Body
      for (let y = yBodyTop; y <= yBodyBottom; y++) {
        const isBullish = candle.close >= candle.open;
        grid[y][x] = isBullish ? "O" : "#";
        if (yO === yC) {
          grid[y][x] = "-";
        }
      }

      // Draw EMA
      const emaVal = slicedEma[index];
      if (emaVal !== null) {
          const yEma = clamp(Math.round((maxPrice - emaVal) * scale));
          // Overlay EMA symbol. If it overlaps with body, maybe use a special char?
          // Let's use '.' for EMA. If it hits existing char, we can decide.
          // Using '.' might be hard to see against 'O' or '#'.
          // Let's use '*' for EMA.
          // If grid[yEma][x] is not space, it means it overlaps.
          if (grid[yEma][x] === " ") {
              grid[yEma][x] = ".";
          } else {
             // Overlap
             // grid[yEma][x] = "+"; // Optional: show overlap
          }
      }
    });

    // 5. Add Y-Axis Labels
    const resultLines: string[] = [];
    for (let i = 0; i < height; i++) {
      const price = maxPrice - i / scale;
      const label = price.toFixed(2).padStart(8, " ");
      resultLines.push(`${label} | ${grid[i].join("")}`);
    }

    return resultLines.join("\n");
  }
}

