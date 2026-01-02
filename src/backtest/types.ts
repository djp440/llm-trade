import { OHLC, OrderRequest } from "../types";
import { AppConfig } from "../config/config";

export interface VirtualAccount {
  balance: number;
  equity: number;
  initialBalance: number;
}

export interface VirtualPosition {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
  entryTime: number;
  takeProfit?: number;
  stopLoss?: number;
  unrealizedPnL: number;
}

export interface VirtualOrder extends OrderRequest {
  id: string;
  status: "open" | "closed" | "canceled";
  timestamp: number;
}

export interface BacktestConfig {
  csvPath: string;
  initialBalance: number;
  symbol: string;
  timeframes: {
    trading: string;
    context: string;
    trend: string;
  };
  enableImageAnalysis?: boolean;
  limit?: number;
  llmConfig?: AppConfig["llm"];
}

export interface TradeResult {
  id: string;
  entryTime: number;
  exitTime: number | null;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  realizedPnL: number;
  returnPct: number;
  reason: string;
}

export interface BacktestReport {
  config: BacktestConfig;
  startTime: number;
  endTime: number;
  initialBalance: number;
  finalEquity: number;
  totalReturn: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  trades: TradeResult[];
  candleData?: OHLC[];
}
