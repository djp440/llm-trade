import { OHLC } from "../types";

export class ChartUtils {
  /**
   * Converts OHLC data into an ASCII candlestick chart.
   * @param ohlcData Array of OHLC data
   * @param height Height of the chart in lines (default: 20)
   * @returns string representation of the chart
   */
  public static generateCandlestickChart(
    ohlcData: OHLC[],
    height: number = 20
  ): string {
    if (!ohlcData || ohlcData.length === 0) return "";

    // 1. Calculate Min/Max Price
    let minPrice = Number.MAX_VALUE;
    let maxPrice = Number.MIN_VALUE;

    for (const candle of ohlcData) {
      if (candle.low < minPrice) minPrice = candle.low;
      if (candle.high > maxPrice) maxPrice = candle.high;
    }

    const priceRange = maxPrice - minPrice;
    if (priceRange === 0) return "Flat Market";

    const scale = (height - 1) / priceRange;

    // 2. Initialize Grid (rows x cols)
    // Each candle takes 3 columns: space, body, space (or just body)
    // Let's do 1 column per candle for compactness, or 3 for readability.
    // 1 column is too tight. 2-3 is better.
    const widthPerCandle = 3;
    const width = ohlcData.length * widthPerCandle;
    const grid: string[][] = Array.from({ length: height }, () =>
      Array(width).fill(" ")
    );

    // 3. Draw Candles
    ohlcData.forEach((candle, index) => {
      const x = index * widthPerCandle + 1; // Center of the candle

      // Calculate Y positions (0 is top, height-1 is bottom)
      // Invert Y because array index 0 is top
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
        // Use different chars for Bullish/Bearish
        // Bullish: Empty box or light char
        // Bearish: Filled box or heavy char
        // Using 'O' for Bullish, '#' for Bearish is common in ASCII
        // Or '║' for body sides.

        // Simple block style
        grid[y][x] = isBullish ? "O" : "#";

        // If Open == Close (Doji), use '-'
        if (yO === yC) {
          grid[y][x] = "-";
        }
      }
    });

    // 4. Add Y-Axis Labels (Prices)
    // We'll add labels on the left or right. Let's add on the left.
    const resultLines: string[] = [];
    for (let i = 0; i < height; i++) {
      // Calculate price for this row
      // y = (max - price) * scale  => price = max - y / scale
      const price = maxPrice - i / scale;
      const label = price.toFixed(2).padStart(8, " "); // 8 chars width
      resultLines.push(`${label} | ${grid[i].join("")}`);
    }

    // Add X-Axis (Time) - Optional, maybe just last candle timestamp
    // For now, just return the chart
    return resultLines.join("\n");
  }
}
