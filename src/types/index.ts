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
  decision: "APPROVE" | "REJECT" | "HOLD";
  analysis_step_0_visual?: string;
  analysis_step_1_market_cycle?: string;
  analysis_step_2_setup?: string;
  analysis_step_3_signal_bar?: string;
  reason: string; // Keep for backward compatibility or as a summary
  action?:
    | "BUY"
    | "SELL"
    | "CLOSE_LONG"
    | "CLOSE_SHORT"
    | "CLOSE_LONG_AND_SELL"
    | "CLOSE_SHORT_AND_BUY"
    | "NO_ACTION";
  orderType?: "STOP" | "MARKET";
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  quantity?: number; // Optional quantity override
}

export interface AlBrooksFeatures {
  bar_type: "Bull Trend" | "Bear Trend" | "Doji";
  close_strength: number; // 0.0 - 1.0
  ema_relation: "Abv" | "Blw" | "On";
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
  action:
    | "BUY"
    | "SELL"
    | "CLOSE_LONG"
    | "CLOSE_SHORT"
    | "CLOSE_LONG_AND_SELL"
    | "CLOSE_SHORT_AND_BUY";
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
