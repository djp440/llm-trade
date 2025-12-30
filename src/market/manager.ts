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

    constructor(private exchangeManager: ExchangeManager, private symbol: string) {
        this.exchange = this.exchangeManager.getExchange();
    }

    /**
     * Fetch raw OHLC data from exchange
     */
    public async fetchOHLC(timeframe: string, limit: number = 50): Promise<OHLC[]> {
        try {
            // ccxt returns [timestamp, open, high, low, close, volume]
            // We fetch limit + 2 to handle the "current unfinished" candle and potential latency
            const ohlcv = await this.exchange.fetchOHLCV(this.symbol, timeframe, undefined, limit + 2);
            
            return ohlcv.map(c => ({
                timestamp: c[0] as number,
                open: c[1] as number,
                high: c[2] as number,
                low: c[3] as number,
                close: c[4] as number,
                volume: c[5] as number
            })).sort((a, b) => a.timestamp - b.timestamp);
        } catch (error: any) {
            logger.error(`[MarketData] Failed to fetch OHLC for ${this.symbol}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get validated, COMPLETED candles only.
     * Uses timestamp alignment to ensure the latest candle is truly closed.
     * 
     * @param timeframe Timeframe string (e.g. '15m')
     * @param lookback Number of candles needed
     * @returns Array of closed OHLC candles
     */
    public async getConfirmedCandles(timeframe: string, lookback: number): Promise<OHLC[]> {
        const rawCandles = await this.fetchOHLC(timeframe, lookback);
        
        if (rawCandles.length < 2) {
             throw new Error(`[MarketData] Not enough candles data for ${this.symbol}`);
        }

        const lastCandle = rawCandles[rawCandles.length - 1];
        
        // Calculate expected time boundaries
        const durationMs = this.parseTimeframeToMs(timeframe); 
        const now = Date.now();
        // The start time of the CURRENT (ongoing) candle slot
        const currentSlotStart = Math.floor(now / durationMs) * durationMs;
        
        let confirmedCandles: OHLC[] = [];

        // Logic:
        // If lastCandle.timestamp == currentSlotStart:
        //    It means the exchange has created the NEW candle.
        //    So the candle before it (index - 2) is definitely closed and final.
        //    BUT, usually we just need the one before the current one.
        //    So rawCandles[length-2] is the one we want as the "latest closed".
        
        // If lastCandle.timestamp < currentSlotStart:
        //    It means the exchange has NOT yet created the new candle (latency).
        //    BUT, if lastCandle.timestamp == currentSlotStart - durationMs:
        //       It means this lastCandle IS the one that just closed.
        //       Since time > currentSlotStart, this candle is technically closed,
        //       even if the new one hasn't appeared in the API yet.
        //       We can use it, but it's safer to wait for the new one to appear to be 100% sure of "Close" price stability.
        //       However, for 15m timeframe, using it is usually fine if we are seconds past the mark.
        
        if (lastCandle.timestamp === currentSlotStart) {
            // Case 1: New candle exists. The one before it is closed.
            // We take from end-1 backwards.
            // slice(start, end) -> end is exclusive.
            // We want [..., prev, last] -> we want to exclude last.
            confirmedCandles = rawCandles.slice(0, -1);
        } else {
            // Case 2: New candle not yet visible.
            // Check if the last candle is the one that just finished.
            const expectedLastCloseStart = currentSlotStart - durationMs;
            
            if (lastCandle.timestamp === expectedLastCloseStart) {
                // It is the just-closed candle.
                // We use it as the latest confirmed candle.
                confirmedCandles = rawCandles;
            } else {
                // Case 3: Data is stale (older than 1 period).
                logger.warn(`[MarketData] Stale data for ${this.symbol}. Last: ${new Date(lastCandle.timestamp).toISOString()}, Current Slot: ${new Date(currentSlotStart).toISOString()}`);
                // Return what we have, but warn. Or throw.
                // For now, return valid ones.
                confirmedCandles = rawCandles;
            }
        }

        // Trim to requested lookback length from the end
        if (confirmedCandles.length > lookback) {
            confirmedCandles = confirmedCandles.slice(confirmedCandles.length - lookback);
        }

        return confirmedCandles;
    }

    /**
     * Get current market price (Ticker)
     */
    public async getCurrentPrice(): Promise<number> {
        try {
            const ticker = await this.exchange.fetchTicker(this.symbol);
            return ticker.last || ticker.close || 0;
        } catch (error: any) {
            logger.error(`[MarketData] Failed to fetch ticker for ${this.symbol}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Helper to parse timeframe to milliseconds
     */
    public parseTimeframeToMs(tf: string): number {
        const unit = tf.slice(-1);
        const value = parseInt(tf.slice(0, -1));
        
        switch(unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            case 'w': return value * 7 * 24 * 60 * 60 * 1000;
            default: return 15 * 60 * 1000; // Default 15m
        }
    }
}
