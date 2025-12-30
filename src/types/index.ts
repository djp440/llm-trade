/**
 * Core type definitions for LLM-PriceAction-Bot
 */

export interface OHLC {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface TradeSignal {
    decision: "APPROVE" | "REJECT";
    reason: string;
    action?: "BUY" | "SELL";
    orderType: "STOP" | "MARKET";
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    quantity: number;
}

export interface LLMPromptContext {
    symbol: string;
    accountEquity: number;
    riskPerTrade: number;
    ohlcData: OHLC[];
    asciiChart: string;
}