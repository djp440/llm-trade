import { OHLC } from "../types";

export class TechnicalIndicators {
  /**
   * Calculates the Exponential Moving Average (EMA) for a given set of OHLC data.
   * @param data Array of OHLC data
   * @param period The period for the EMA (e.g., 20)
   * @returns Array of EMA values matching the length of the input data.
   *          The first (period - 1) values will be null.
   */
  public static calculateEMA(data: OHLC[], period: number): (number | null)[] {
    if (data.length < period) {
      return new Array(data.length).fill(null);
    }

    const emas: (number | null)[] = [];
    const k = 2 / (period + 1);

    // 1. Calculate initial SMA for the first EMA value
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i].close;
      emas.push(null); // Fill initial values with null
    }

    // The first EMA is the SMA of the first 'period' elements
    // However, usually EMA starts from the 'period'-th element (index period-1)
    // if we treat the first 'period' elements as the seed.
    // Standard practice:
    // SMA at index [period-1] = sum(0..period-1) / period
    
    // Let's correct the loop slightly.
    // Indices 0 to period-2 are null.
    // Index period-1 is the first SMA.
    
    // Reset emas to be clean
    emas.length = 0;
    for(let i=0; i < period - 1; i++) {
        emas.push(null);
    }

    const firstSMA = sum / period;
    emas.push(firstSMA);

    // 2. Calculate subsequent EMAs
    for (let i = period; i < data.length; i++) {
      const prevEMA = emas[i - 1] as number;
      const currentPrice = data[i].close;
      const currentEMA = (currentPrice * k) + (prevEMA * (1 - k));
      emas.push(currentEMA);
    }

    return emas;
  }
}
