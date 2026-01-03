import { TradeSignal, OHLC, PendingOrderDecision } from "../types";

export interface LLMService {
  validateVisionCapability(): Promise<boolean>;
  testConnection(): Promise<boolean>;
  getTotalTokenUsage(): number;

  checkPendingOrderValidity(
    symbol: string,
    currentPrice: number,
    order: any,
    ohlcContext: string
  ): Promise<PendingOrderDecision>;

  analyzeMarket(
    symbol: string,
    tradingData: OHLC[],
    contextData: OHLC[],
    trendData: OHLC[],
    accountEquity: number,
    riskPerTrade: number,
    options?: {
      enableImageAnalysis?: boolean;
      timeframes?: { trading: string; context: string; trend: string };
    }
  ): Promise<TradeSignal>;

  analyzePendingOrder(
    symbol: string,
    tradingData: OHLC[],
    contextData: OHLC[],
    trendData: OHLC[],
    accountEquity: number,
    riskPerTrade: number,
    pendingOrder: {
      action: "BUY" | "SELL";
      entryPrice: number;
      reason: string;
    }
  ): Promise<PendingOrderDecision>;
}
