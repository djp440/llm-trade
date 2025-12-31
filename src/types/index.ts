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
  analysis_step_1_market_cycle: string;
  analysis_step_2_setup: string;
  analysis_step_3_signal_bar: string;
  reason: string; // Keep for backward compatibility or as a summary
  action?: "BUY" | "SELL";
  orderType: "STOP" | "MARKET";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export interface AlBrooksFeatures {
  bar_type: "Bull Trend" | "Bear Trend" | "Doji";
  close_strength: number; // 0.0 - 1.0
  ema_relation: "Above" | "Below" | "On";
  vol_spike: boolean;
  overlap: boolean;
}

export interface EnrichedOHLC extends OHLC {
  features?: AlBrooksFeatures;
  ema20?: number;
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

export interface PendingOrderDecision {
  decision: "KEEP" | "CANCEL";
  reason: string;
}
