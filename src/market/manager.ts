import { Exchange } from "ccxt";
import { ExchangeManager } from "./exchange-manager";
import { OHLC } from "../types";
import { logger } from "../utils/logger";

/**
 * Market Data Manager: Responsible for fetching and maintaining K-line data
 * Ensures data integrity and correct candle selection (closed candles only).
 */
export class MarketDataManager {
  private exchange: Exchange;

  constructor(
    private exchangeManager: ExchangeManager,
    private symbol: string
  ) {
    this.exchange = this.exchangeManager.getExchange();
  }

  /**
   * Fetch raw OHLC data from exchange
   */
  public async fetchOHLC(
    timeframe: string,
    limit: number = 50
  ): Promise<OHLC[]> {
    try {
      // ccxt returns [timestamp, open, high, low, close, volume]
      // We fetch limit + 2 to handle the "current unfinished" candle and potential latency
      const ohlcv = await this.exchange.fetchOHLCV(
        this.symbol,
        timeframe,
        undefined,
        limit + 2
      );

      return ohlcv
        .map(c => ({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch (error: any) {
      logger.error(
        `[市场数据] 获取 ${this.symbol} 的 OHLC 失败: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * 仅获取经过验证的、已完成的 K 线。
   * 使用时间戳对齐以确保最新的 K 线确实已收盘。
   *
   * @param timeframe 时间框架字符串 (例如 '15m')
   * @param lookback 需要的 K 线数量
   * @returns 已收盘的 OHLC K 线数组
   */
  public async getConfirmedCandles(
    timeframe: string,
    lookback: number
  ): Promise<OHLC[]> {
    const rawCandles = await this.fetchOHLC(timeframe, lookback);

    if (rawCandles.length < 2) {
      throw new Error(`[市场数据] ${this.symbol} 的 K 线数据不足`);
    }

    const lastCandle = rawCandles[rawCandles.length - 1];

    // 计算预期的理论时间边界
    const durationMs = this.parseTimeframeToMs(timeframe);
    const now = Date.now();
    // 当前（进行中）K 线插槽的开始时间
    const currentSlotStart = Math.floor(now / durationMs) * durationMs;

    let confirmedCandles: OHLC[] = [];

    // 逻辑：
    // 如果 lastCandle.timestamp == currentSlotStart：
    //    意味着交易所已经创建了新的 K 线。
    //    因此它之前的 K 线（索引 - 2）肯定是已经关闭且最终确定的。
    //    但是，通常我们只需要当前 K 线之前的那个。
    //    所以 rawCandles[length-2] 就是我们要的“最新已收盘”K 线。

    // 如果 lastCandle.timestamp < currentSlotStart：
    //    意味着交易所尚未创建新的 K 线（延迟）。
    //    但是，如果 lastCandle.timestamp == currentSlotStart - durationMs：
    //       意味着这最后一根 K 线就是刚刚收盘的那根。
    //       由于时间 > currentSlotStart，这根 K 线在技术上已经关闭，
    //       即使新的 K 线尚未在 API 中出现。
    //       我们可以使用它，但为了 100% 确定“收盘”价格的稳定性，等待新 K 线出现会更安全。
    //       然而，对于 15 分钟时间框架，如果已经过去了几秒钟，使用它通常也是可以的。

    if (lastCandle.timestamp === currentSlotStart) {
      // 情况 1：新 K 线已存在。它之前的那根已收盘。
      // 我们从倒数第二根开始取。
      // slice(start, end) -> end 是不包含在内的。
      // 我们想要 [..., prev, last] -> 我们想要排除 last。
      confirmedCandles = rawCandles.slice(0, -1);
    } else {
      // 情况 2：新 K 线尚未可见。
      // 检查最后一根 K 线是否是刚刚完成的那根。
      const expectedLastCloseStart = currentSlotStart - durationMs;

      if (lastCandle.timestamp === expectedLastCloseStart) {
        // 它是刚刚收盘的 K 线。
        // 我们将其作为最新的已确认 K 线。
        confirmedCandles = rawCandles;
      } else {
        // 情况 3：数据陈旧（早于 1 个周期）。
        logger.warn(
          `[市场数据] ${this.symbol} 数据陈旧。最后时间: ${new Date(
            lastCandle.timestamp
          ).toISOString()}, 当前插槽: ${new Date(
            currentSlotStart
          ).toISOString()}`
        );
        // 返回我们拥有的数据，但发出警告。或者抛出异常。
        // 目前，返回有效的数据。
        confirmedCandles = rawCandles;
      }
    }

    // 仅返回请求的追溯数量
    return confirmedCandles.slice(-lookback);
  }

  /**
   * 获取最新成交价（市价）
   */
  public async getCurrentPrice(): Promise<number> {
    try {
      const ticker = await this.exchange.fetchTicker(this.symbol);
      return ticker.last!;
    } catch (error: any) {
      logger.error(
        `[市场数据] 获取 ${this.symbol} 当前价格失败: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Helper to parse timeframe to milliseconds
   */
  public parseTimeframeToMs(tf: string): number {
    const unit = tf.slice(-1);
    const value = parseInt(tf.slice(0, -1));

    switch (unit) {
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      case "w":
        return value * 7 * 24 * 60 * 60 * 1000;
      default:
        return 15 * 60 * 1000; // Default 15m
    }
  }
}
