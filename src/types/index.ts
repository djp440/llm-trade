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

export interface OrderRequest {
    symbol: string;
    type: "market" | "limit" | "stop" | "stop_market";
    side: "buy" | "sell";
    amount: number;
    price?: number;
    stopPrice?: number;
    params?: any; // For exchange specific params (e.g. OCO)
}

export interface TradePlan {
    symbol: string;
    action: "BUY" | "SELL";
    entryOrder: OrderRequest;
    stopLossOrder: OrderRequest;
    takeProfitOrder: OrderRequest;
    quantity: number;
    riskAmount: number;
    reason: string;
}