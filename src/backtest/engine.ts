import { DataLoader } from "./data-loader";
import { VirtualExchange } from "./virtual-exchange";
import { BacktestContextBuilder } from "./backtest-context-builder";
import { LLMService } from "../llm/llm-service";
import { createLLMService } from "../llm/llm-factory";
import { ConfigLoader } from "../config/config";
import {
  BacktestConfig,
  TradeResult,
  BacktestReport,
  EquityPoint,
} from "./types";
import { logger } from "../utils/logger";
import { OHLC, TradeSignal } from "../types";
import * as fs from "fs";
import * as path from "path";

enum BacktestState {
  WAITING_SIGNAL = "WAITING_SIGNAL",
  PENDING_ORDER = "PENDING_ORDER",
  IN_POSITION = "IN_POSITION",
}

import { Resampler } from "./resampler";

export class BacktestEngine {
  private exchange: VirtualExchange;
  private llmService: LLMService;
  private data: OHLC[] = [];
  private contextDataFull: OHLC[] = [];
  private trendDataFull: OHLC[] = [];
  private state: BacktestState = BacktestState.WAITING_SIGNAL;
  private currentIndex: number = 0;
  private config: BacktestConfig;

  // Progress tracking
  private startTime: number = 0;
  private processedCount: number = 0;

  // Track the last pending order we created to manage it
  private lastPendingOrderId: string | null = null;

  // Stats tracking
  private equityCurve: EquityPoint[] = [];
  private peakEquity: number = 0;
  private maxDrawdown: number = 0;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.exchange = new VirtualExchange(config.initialBalance);

    // Merge LLM config with strategy type
    const factoryConfig = {
      ...config.llmConfig,
      strategyType: config.strategyType,
    };
    this.llmService = createLLMService(factoryConfig);

    this.peakEquity = config.initialBalance;
  }

  public async run(): Promise<string | undefined> {
    logger.info("Starting Backtest...");

    // 1. Load Data
    this.data = await DataLoader.loadCSV(this.config.csvPath);
    if (this.data.length === 0) {
      logger.error("No data loaded.");
      return undefined;
    }

    // 2. Resample Data
    const tradingMs = Resampler.parseInterval(this.config.timeframes.trading);
    const contextMs = Resampler.parseInterval(this.config.timeframes.context);
    const trendMs = Resampler.parseInterval(this.config.timeframes.trend);

    this.contextDataFull = Resampler.resample(this.data, contextMs);
    this.trendDataFull = Resampler.resample(this.data, trendMs);

    logger.info(`Data Loaded: ${this.data.length} trading candles.`);
    logger.info(
      `Resampled: ${this.contextDataFull.length} context candles, ${this.trendDataFull.length} trend candles.`
    );

    // 3. Determine Start Index
    // We need enough history for context (e.g. 50-100 bars for indicators)
    const lookback = 50;
    if (this.data.length < lookback) {
      logger.error("Not enough data for lookback.");
      return undefined;
    }

    this.currentIndex = lookback;

    // 4. Main Loop
    const endIndex = this.config.limit
      ? Math.min(this.currentIndex + this.config.limit, this.data.length - 1)
      : this.data.length - 1;

    this.startTime = Date.now();
    this.processedCount = 0;
    const totalToProcess = endIndex - this.currentIndex;

    logger.info(`Starting loop. Total candles to process: ${totalToProcess}`);

    while (this.currentIndex < endIndex) {
      const accountState = this.exchange.getAccountState();

      if (accountState.equity <= 0) {
        logger.error("Account Bankrupt (Equity <= 0). Stopping Backtest.");
        break;
      }

      // 1. Prepare Data Buckets
      // We need closed candles for Context (1H) and Trend (4H).
      // But we are stepping through Trading (15m).
      const currentCandle = this.data[this.currentIndex];
      logger.info(
        `Processing Candle [${this.currentIndex}]: ${new Date(
          currentCandle.timestamp
        ).toISOString()}`
      );

      await this.processStep();

      // Update Equity Stats
      const currentEquity = this.exchange.getAccountState().equity;
      this.peakEquity = Math.max(this.peakEquity, currentEquity);
      const drawdown =
        ((this.peakEquity - currentEquity) / this.peakEquity) * 100;
      this.maxDrawdown = Math.max(this.maxDrawdown, drawdown);

      this.equityCurve.push({
        timestamp: currentCandle.timestamp,
        equity: currentEquity,
        drawdown: drawdown,
      });

      this.processedCount++;
      this.currentIndex++;

      // Progress Estimation
      this.logProgress(totalToProcess);
    }

    return this.generateReport();
  }

  private logProgress(totalToProcess: number) {
    if (this.processedCount === 0) return;

    const elapsedMs = Date.now() - this.startTime;
    const avgTimePerCandle = elapsedMs / this.processedCount;
    const remainingCandles = totalToProcess - this.processedCount;
    const estRemainingMs = avgTimePerCandle * remainingCandles;

    const totalTokens = this.llmService.getTotalTokenUsage();
    const avgTokensPerCandle = totalTokens / this.processedCount;
    const estTotalTokens = totalTokens + avgTokensPerCandle * remainingCandles;

    const formatDuration = (ms: number) => {
      if (ms < 1000) return `${ms}ms`;
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return `${h}h ${m % 60}m`;
      if (m > 0) return `${m}m ${s % 60}s`;
      return `${s}s`;
    };

    const formatTokens = (t: number) => {
      return (t / 1000).toFixed(1) + "k";
    };

    const pct = ((this.processedCount / totalToProcess) * 100).toFixed(1);

    logger.info(
      `[进度] ${this.processedCount}/${totalToProcess} (${pct}%) | ` +
        `耗时: ${formatDuration(elapsedMs)} | ` +
        `预计剩余: ${formatDuration(estRemainingMs)} | ` +
        `Token消耗: ${formatTokens(totalTokens)} | ` +
        `预计总Token: ${formatTokens(estTotalTokens)}`
    );
  }

  private async processStep() {
    // 1. Process Logic based on State
    // Note: The exchange has NOT yet seen `data[currentIndex+1]`.
    // It has seen `data[currentIndex]` in the previous iteration?
    // Let's handle the "Time Flow" carefully.

    // In the first iteration, currentIndex = lookback.
    // We haven't processed this candle in exchange yet?
    // Usually, we initialize exchange.

    // Let's do:
    // Loop:
    //   1. Get history ending at currentIndex.
    //   2. Run Logic (LLM, Signal).
    //   3. Advance Index.
    //   4. Feed NEW candle to Exchange.

    // But wait, if I have an open position, I need to check it against the candle I just finished?
    // Let's align:
    // `currentIndex` is the index of the candle that JUST CLOSED.
    // We make decisions based on it.
    // Then we move to next.

    // BUT, for `exchange`, we need to simulate the passage of that candle to see if orders filled.
    // So, effectively, the loop should be:
    // 1. Feed `data[currentIndex]` to Exchange. (Update PnL, Trigger Orders).
    // 2. Check State (Did we enter? Did we exit?).
    // 3. If needed, ask LLM for NEXT step (Signal for next candle).

    const currentCandle = this.data[this.currentIndex];

    // Step 1: Update Exchange with LATEST closed candle
    this.exchange.processCandle(currentCandle);

    // Step 2: Check Exchange State to update Engine State
    const accountState = this.exchange.getAccountState();

    // Detect State Transitions
    if (this.state === BacktestState.PENDING_ORDER) {
      // Check if order disappeared (filled or canceled)
      const order = accountState.orders.find(
        o => o.id === this.lastPendingOrderId
      );
      if (!order) {
        // Order is gone. Did we get a position?
        if (accountState.positions.length > 0) {
          this.state = BacktestState.IN_POSITION;
          logger.info("--> State Changed: IN_POSITION");
        } else {
          // Order canceled (manually or expired?) - here likely canceled by us or not found
          // If we had a pending order and now it's gone and no position, it was canceled.
          this.state = BacktestState.WAITING_SIGNAL;
          logger.info("--> State Changed: WAITING_SIGNAL (Order Gone)");
        }
      }
    } else if (this.state === BacktestState.IN_POSITION) {
      if (accountState.positions.length === 0) {
        this.state = BacktestState.WAITING_SIGNAL;
        logger.info("--> State Changed: WAITING_SIGNAL (Position Closed)");
      }
    }

    // Step 3: Action based on State
    if (this.state === BacktestState.PENDING_ORDER) {
      await this.handlePendingOrder();
    } else {
      // For WAITING_SIGNAL and IN_POSITION, we run analysis
      // This supports strategies that actively manage positions (Close, Reverse)
      await this.handleMarketAnalysis();
    }
  }

  private async handleMarketAnalysis() {
    // Prepare Data
    const end = this.currentIndex + 1;
    const currentCandle = this.data[this.currentIndex];

    // Trading Data (native)
    // Need enough history for indicators (e.g. EMA 200)
    // Safely increase lookback to 300 or more
    const tradingData = this.data.slice(Math.max(0, end - 300), end);

    // Context Data (Resampled)
    const contextMs = Resampler.parseInterval(this.config.timeframes.context);
    const trendMs = Resampler.parseInterval(this.config.timeframes.trend);

    const contextBucketStart =
      Math.floor(currentCandle.timestamp / contextMs) * contextMs;
    const trendBucketStart =
      Math.floor(currentCandle.timestamp / trendMs) * trendMs;

    const getClosedCandles = (
      all: OHLC[],
      bucketStart: number,
      limit: number
    ) => {
      // Find last index where timestamp < bucketStart
      let i = all.length - 1;
      // Optimization: start search from estimated position?
      // Or just linear search backwards is fine for small arrays.
      while (i >= 0 && all[i].timestamp >= bucketStart) {
        i--;
      }
      if (i < 0) return [];
      const start = Math.max(0, i - limit + 1);
      return all.slice(start, i + 1);
    };

    const contextData = getClosedCandles(
      this.contextDataFull,
      contextBucketStart,
      200 // Increased lookback for context indicators
    );
    const trendData = getClosedCandles(
      this.trendDataFull,
      trendBucketStart,
      200 // Increased lookback for trend indicators
    );

    const accountState = this.exchange.getAccountState();

    // Determine Current Position Status for Strategy
    let currentPositionStatus = "NO_POSITION";
    const pos = accountState.positions.find(
      p => p.symbol === this.config.symbol
    );
    if (pos && pos.quantity > 0) {
      currentPositionStatus =
        pos.side === "long" ? "LONG_POSITION" : "SHORT_POSITION";
    }

    // Call LLM
    try {
      const signal: TradeSignal = await this.llmService.analyzeMarket(
        this.config.symbol,
        tradingData,
        contextData,
        trendData,
        accountState.equity,
        0.01, // 1% risk (default, strategy might override via q parameter)
        {
          enableImageAnalysis: this.config.enableImageAnalysis,
          timeframes: this.config.timeframes,
          currentPosition: currentPositionStatus,
        }
      );

      if (signal.decision === "HOLD" || signal.action === "NO_ACTION") {
        // Do nothing
        return;
      }

      if (signal.decision === "APPROVE" || signal.action) {
        logger.info(
          `LLM Signal: ${signal.action} @ ${signal.entryPrice || "Market"}`
        );

        // Handle Close/Reverse Logic
        if (signal.action?.startsWith("CLOSE_")) {
          await this.handleCloseSignal(signal, accountState);

          // If it's a "AND_..." action, we need to open a new position
          if (signal.action.includes("_AND_")) {
            // Proceed to open logic below
          } else {
            // Just Close
            return;
          }
        }

        // Place Entry Order (Buy/Sell)
        // Calculate Quantity based on Risk or Strategy params
        let qty = 0;

        // Priority: Signal Quantity (Percent) > Risk Calculation
        if (signal.quantity && signal.quantity > 0) {
          // quantity is percentage (0-100) or value?
          // TradeExecutor update assumed 0-100 representing % of equity.
          // Let's assume strategy returns % of equity to use.
          const val = accountState.equity * (signal.quantity / 100);
          const price = signal.entryPrice || currentCandle.close;
          qty = val / price;
        } else {
          // Default Risk-based sizing
          const riskAmt = accountState.equity * 0.01;
          const sl =
            signal.stopLoss ||
            (signal.action === "BUY"
              ? currentCandle.close * 0.99
              : currentCandle.close * 1.01);
          // If SL is 0/undefined, fallback to 1% distance

          const entryPrice = signal.entryPrice || currentCandle.close;
          const rawDist = Math.abs(entryPrice - sl);

          // Safety: Ensure minimum distance
          const MIN_DIST_PCT = 0.002;
          const minDist = entryPrice * MIN_DIST_PCT;
          const dist = Math.max(rawDist, minDist);

          if (dist > 0) qty = riskAmt / dist;
        }

        // Safety: Cap Leverage
        const MAX_LEVERAGE = 3; // Should come from config
        const maxPosValue = accountState.equity * MAX_LEVERAGE;
        const entryPrice = signal.entryPrice || currentCandle.close;
        const currentPosValue = qty * entryPrice;

        if (currentPosValue > maxPosValue) {
          const newQty = maxPosValue / entryPrice;
          qty = newQty;
        }

        if (qty <= 0) {
          logger.warn(`Calculated quantity <= 0. Skipping.`);
          return;
        }

        const orderType = signal.orderType === "MARKET" ? "market" : "stop";
        const side =
          signal.action === "BUY" || signal.action === "CLOSE_SHORT_AND_BUY"
            ? "buy"
            : "sell";

        // Create Entry Order
        const order = this.exchange.createOrder({
          symbol: this.config.symbol,
          type: orderType,
          side: side,
          amount: qty,
          stopPrice: orderType === "stop" ? signal.entryPrice : undefined,
          price: signal.entryPrice,
          params: {
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
          },
        });

        this.lastPendingOrderId = order.id;
        this.state = BacktestState.PENDING_ORDER;
      } else {
        logger.info(`LLM Rejected: ${signal.reason}`);
      }
    } catch (e: any) {
      logger.error(`LLM Analysis Failed: ${e.message}`);
    }
  }

  private async handleCloseSignal(signal: TradeSignal, accountState: any) {
    const pos = accountState.positions.find(
      (p: any) => p.symbol === this.config.symbol
    );
    if (!pos || pos.amount === 0) return;

    const isLong = pos.side === "buy";
    const shouldCloseLong = signal.action?.includes("CLOSE_LONG");
    const shouldCloseShort = signal.action?.includes("CLOSE_SHORT");

    if ((isLong && shouldCloseLong) || (!isLong && shouldCloseShort)) {
      // Create Close Order (Market)
      this.exchange.createOrder({
        symbol: this.config.symbol,
        type: "market",
        side: isLong ? "sell" : "buy",
        amount: pos.amount,
        params: { reduceOnly: true },
      });
      logger.info(`Executed Close Signal: ${signal.action}`);
      // Update state immediately? Exchange processCandle will handle execution next tick?
      // No, createOrder executes immediately in VirtualExchange if market?
      // VirtualExchange implementation might queue it.
      // If queued, we need to wait for fill.
      // But here we might be creating Entry immediately after.
      // Backtester simplification: Assume Market orders fill immediately at Close price of current candle?
      // VirtualExchange `createOrder` adds to `orders`. `processCandle` executes them.
      // So we need to wait for next candle to fill these.
      // BUT, if we want "Close AND Buy", we are sending 2 orders.
      // 1. Close (Sell)
      // 2. Open (Buy) - wait, that's same direction?
      // Close Long (Sell) -> Open Short (Sell).
      // Close Short (Buy) -> Open Long (Buy).
      // So we send 2 orders.
      // Order 1: Sell X (ReduceOnly)
      // Order 2: Sell Y (Open)
      // This works.
    }
  }

  private async handlePendingOrder() {
    // Ask LLM if we should cancel
    // We need context.
    const end = this.currentIndex + 1;
    const recentData = this.data.slice(Math.max(0, end - 20), end);

    // Format simple context
    const contextStr = recentData
      .map(
        c =>
          `T:${new Date(c.timestamp).toISOString().substr(11, 5)} C:${
            c.close
          } H:${c.high} L:${c.low}`
      )
      .join("\n");

    const accountState = this.exchange.getAccountState();
    const order = accountState.orders.find(
      o => o.id === this.lastPendingOrderId
    );

    if (!order) return; // Should not happen based on processStep logic

    const decision = await this.llmService.checkPendingOrderValidity(
      this.config.symbol,
      this.data[this.currentIndex].close,
      order,
      contextStr
    );

    if (decision.decision === "CANCEL") {
      logger.info(`LLM Decided to Cancel Order: ${decision.reason}`);
      this.exchange.cancelOrder(order.id);
      this.state = BacktestState.WAITING_SIGNAL;
    } else {
      logger.info(`LLM Decided to Keep Order: ${decision.reason}`);
    }
  }

  private generateReport(): string {
    logger.info("=== Backtest Finished ===");
    const state = this.exchange.getAccountState();
    logger.info(`Final Equity: ${state.equity}`);
    logger.info(`Total Trades: ${state.tradeHistory.length}`);

    const winTrades = state.tradeHistory.filter(t => t.realizedPnL > 0);
    const lossTrades = state.tradeHistory.filter(t => t.realizedPnL <= 0);

    logger.info(`Wins: ${winTrades.length} | Losses: ${lossTrades.length}`);

    // Calculate Stats
    const totalReturn =
      ((state.equity - state.initialBalance) / state.initialBalance) * 100;
    const winRate =
      state.tradeHistory.length > 0
        ? (winTrades.length / state.tradeHistory.length) * 100
        : 0;

    let grossProfit = 0;
    let grossLoss = 0;
    state.tradeHistory.forEach(t => {
      if (t.realizedPnL > 0) grossProfit += t.realizedPnL;
      else grossLoss += Math.abs(t.realizedPnL);
    });
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Calculate Max Drawdown (using high-frequency data from loop)
    const maxDrawdown = this.maxDrawdown;

    // Create Full Report
    const report: BacktestReport = {
      config: this.config,
      startTime: this.data.length > 0 ? this.data[0].timestamp : 0,
      endTime:
        this.data.length > 0 ? this.data[this.data.length - 1].timestamp : 0,
      initialBalance: state.initialBalance,
      finalEquity: state.equity,
      totalReturn,
      totalTrades: state.tradeHistory.length,
      winRate,
      profitFactor,
      maxDrawdown,
      trades: state.tradeHistory,
      candleData: this.data, // Include trading data for visualization
      equityCurve: this.equityCurve,
    };

    // Save report to file
    const reportPath = path.join(
      process.cwd(),
      "output",
      `backtest_report_${Date.now()}.json`
    );
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    logger.info(`Report saved to ${reportPath}`);
    return reportPath;
  }
}
