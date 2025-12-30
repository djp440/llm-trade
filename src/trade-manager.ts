import { MarketDataManager } from "./market/manager";
import { LLMService } from "./llm/llm-service";
import { TradeExecutor } from "./executor/trade-executor";
import { ExchangeManager } from "./market/exchange-manager";
import { config } from "./config/config";
import { logger } from "./utils/logger";
import { TradePlan } from "./types";
import { Order } from "ccxt";

enum TradeState {
  SEARCHING = "SEARCHING",
  EXECUTING = "EXECUTING",
  MANAGING = "MANAGING",
}

export class TradeManager {
  private marketData: MarketDataManager;
  private llmService: LLMService;
  private executor: TradeExecutor;
  private isRunning: boolean = false;
  private state: TradeState = TradeState.SEARCHING;
  private activeOrders: Order[] = [];

  constructor(
    private symbol: string,
    private exchangeManager: ExchangeManager
  ) {
    this.marketData = new MarketDataManager(exchangeManager, symbol);
    this.llmService = new LLMService();
    this.executor = new TradeExecutor(exchangeManager);
  }

  public async startLoop() {
    this.isRunning = true;
    logger.info(`[TradeManager] Starting loop for ${this.symbol}`);

    while (this.isRunning) {
      try {
        // Calculate wait time for next candle CLOSE
        const timeframe = config.strategy.timeframe;
        const msPerCandle = this.marketData.parseTimeframeToMs(timeframe);
        const now = Date.now();
        // Next boundary
        const nextCandleTime = Math.ceil(now / msPerCandle) * msPerCandle;
        // Add buffer (e.g. 5 seconds) to ensure exchange has processed the close
        const waitTime = nextCandleTime - now + 5000;

        logger.info(
          `[TradeManager] ${this.symbol} sleeping for ${Math.round(
            waitTime / 1000
          )}s until next candle close...`
        );

        // Wait...
        await this.sleep(waitTime);

        // Wake up and process
        if (this.state === TradeState.SEARCHING) {
          await this.processSignalSearch();
        } else {
          // If managing position, maybe we check status here too, or rely on WS
          // For this step, we assume we loop back to check signals if we aren't blocked
          logger.info(
            `[TradeManager] ${this.symbol} in state ${this.state}, skipping signal search.`
          );
        }
      } catch (error: any) {
        logger.error(
          `[TradeManager] Error in loop for ${this.symbol}: ${error.message}`
        );
        await this.sleep(10000); // Error backoff
      }
    }
  }

  private async processSignalSearch() {
    logger.info(`[TradeManager] ${this.symbol} - Starting Signal Search Phase`);

    // 1. Fetch Data
    const lookback = config.strategy.lookback_candles;
    const timeframe = config.strategy.timeframe;

    // Get confirmed closed candles
    const candles = await this.marketData.getConfirmedCandles(
      timeframe,
      lookback
    );
    const lastCandle = candles[candles.length - 1];

    logger.info(
      `[TradeManager] ${this.symbol} - Analying candle closed at ${new Date(
        lastCandle.timestamp
      ).toISOString()}`
    );

    // 2. Get Account Info
    // We fetch total equity. In future we might want isolated margin per symbol.
    const balance = await this.exchangeManager.getExchange().fetchBalance();
    // Assuming USDT based
    const equity = balance.total["USDT"] || 0;

    if (equity === 0) {
      logger.warn(
        `[TradeManager] ${this.symbol} - Zero Equity, skipping analysis.`
      );
      return;
    }

    // 3. LLM Analysis
    const riskPerTrade = config.strategy.risk_per_trade;
    logger.info(`[TradeManager] ${this.symbol} - Requesting LLM analysis...`);

    const signal = await this.llmService.analyzeMarket(
      this.symbol,
      candles,
      equity,
      riskPerTrade
    );

    logger.info(
      `[TradeManager] ${this.symbol} - LLM Decision: ${signal.decision} (${signal.reason})`
    );

    if (signal.decision === "APPROVE") {
      // 4. Execution Logic
      const currentPrice = await this.marketData.getCurrentPrice();
      const plan = this.executor.generateTradePlan(
        signal,
        currentPrice,
        equity,
        this.symbol
      );

      if (plan) {
        logger.info(
          `[TradeManager] ${this.symbol} - Trade Plan Generated: ${
            plan.action
          } ${plan.quantity} @ ${plan.entryOrder.price || "Market"}`
        );

        const orders = await this.executor.executeTradePlan(plan);
        this.activeOrders.push(...orders);

        // Switch state to MANAGING (Simple implementation for now)
        // In a full system, we would track this order via WebSocket
        // For now, we'll just log it and potentially loop back (or pause)
        // this.state = TradeState.MANAGING;
      } else {
        logger.warn(
          `[TradeManager] ${this.symbol} - Failed to generate valid trade plan.`
        );
      }
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
