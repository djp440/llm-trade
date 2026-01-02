import { DataLoader } from "./data-loader";
import { VirtualExchange } from "./virtual-exchange";
import { BacktestContextBuilder } from "./backtest-context-builder";
import { LLMService } from "../llm/llm-service";
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
    this.llmService = new LLMService(config.llmConfig);
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
    if (this.state === BacktestState.WAITING_SIGNAL) {
      await this.handleWaitingSignal();
    } else if (this.state === BacktestState.PENDING_ORDER) {
      await this.handlePendingOrder();
    } else if (this.state === BacktestState.IN_POSITION) {
      // Do nothing, just wait for exit.
      // Or maybe implement trailing stop logic here if needed.
    }
  }

  private async handleWaitingSignal() {
    // Prepare Data
    const end = this.currentIndex + 1;
    const currentCandle = this.data[this.currentIndex];

    // Trading Data (native)
    const tradingData = this.data.slice(Math.max(0, end - 50), end);

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
      50
    );
    const trendData = getClosedCandles(
      this.trendDataFull,
      trendBucketStart,
      50
    );

    const accountState = this.exchange.getAccountState();

    // Call LLM
    try {
      const signal: TradeSignal = await this.llmService.analyzeMarket(
        this.config.symbol,
        tradingData,
        contextData,
        trendData,
        accountState.equity,
        0.01, // 1% risk
        {
          enableImageAnalysis: this.config.enableImageAnalysis,
          timeframes: this.config.timeframes,
        }
      );

      if (signal.decision === "APPROVE") {
        logger.info(
          `LLM Approved Trade: ${signal.action} @ ${signal.entryPrice}`
        );

        // Place Order
        // Calculate Quantity based on Risk
        // Risk Amount = Equity * 0.01
        // Risk Per Unit = |Entry - SL|
        // Qty = Risk Amount / Risk Per Unit
        const riskAmt = accountState.equity * 0.01;
        const rawDist = Math.abs(signal.entryPrice - signal.stopLoss);

        // Safety: Ensure minimum distance to avoid massive leverage on tight stops
        const MIN_DIST_PCT = 0.002; // 0.2% minimum distance
        const minDist = signal.entryPrice * MIN_DIST_PCT;
        const dist = Math.max(rawDist, minDist);

        if (rawDist < minDist) {
          logger.warn(
            `Signal SL distance ${rawDist.toFixed(2)} is too small (< ${
              MIN_DIST_PCT * 100
            }% of price). Using min dist ${minDist.toFixed(2)} for sizing.`
          );
        }

        let qty = 0;
        if (dist > 0) {
          qty = riskAmt / dist;
        }

        // Safety: Cap Leverage
        const MAX_LEVERAGE = 3;
        const maxPosValue = accountState.equity * MAX_LEVERAGE;
        const currentPosValue = qty * signal.entryPrice;

        if (currentPosValue > maxPosValue) {
          const newQty = maxPosValue / signal.entryPrice;
          logger.warn(
            `Quantity ${qty.toFixed(
              4
            )} exceeds max leverage ${MAX_LEVERAGE}x. Clamping to ${newQty.toFixed(
              4
            )}.`
          );
          qty = newQty;
        }

        // Sanity check qty
        if (qty <= 0) {
          logger.warn(
            `Calculated quantity is 0 or negative, skipping. Qty: ${qty}, Equity: ${accountState.equity}, RiskAmt: ${riskAmt}, Entry: ${signal.entryPrice}, SL: ${signal.stopLoss}, Dist: ${dist}`
          );
          return;
        }

        const order = this.exchange.createOrder({
          symbol: this.config.symbol,
          type: "stop", // LLM usually returns STOP for price action
          side: signal.action === "BUY" ? "buy" : "sell",
          amount: qty,
          stopPrice: signal.entryPrice, // For stop order, price is trigger
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
