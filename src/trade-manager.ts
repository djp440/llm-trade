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

        await this.executeTradePlan(plan);

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

  private async executeTradePlan(plan: TradePlan) {
    logger.info(`[TradeManager] Executing Trade Plan for ${plan.symbol}...`);
    const exchange = this.exchangeManager.getExchange();

    try {
      // 1. Place Entry Order
      const entry = plan.entryOrder;
      logger.info(
        `[TradeManager] Placing Entry Order: ${entry.type} ${entry.side} ${
          entry.amount
        } @ ${entry.price || entry.stopPrice || "Market"}`
      );

      // CCXT Unified Order Interface
      // createOrder (symbol, type, side, amount, price, params)
      // For stop_market, price is usually ignored or used as stopPrice depending on exchange
      // For Bitget, 'stop_market' might need specific params

      const params = entry.params || {};
      let price = entry.price;

      // Handle Trigger Price for Stop Orders
      if (entry.type === "stop_market" || entry.type === "stop") {
        if (entry.stopPrice) {
          params["triggerPrice"] = entry.stopPrice; // Common standard
          // Some exchanges require 'stopPrice' in params
          params["stopPrice"] = entry.stopPrice;
        }
        // For stop_market, 'price' arg is usually undefined or ignored
        if (entry.type === "stop_market") price = undefined;
      }

      const order = await exchange.createOrder(
        entry.symbol,
        entry.type,
        entry.side,
        entry.amount,
        price,
        params
      );

      logger.info(`[TradeManager] Entry Order Placed. ID: ${order.id}`);
      this.activeOrders.push(order);

      // 2. Place TP/SL if Entry was Market (Immediate)
      // If Entry was Pending, usually we wait for fill, OR use OCO if supported.
      // For simplicity in this iteration:
      // - If Market Entry: Place TP/SL immediately.
      // - If Pending Entry: We should technically wait.
      //   BUT, for "Trigger Order" support, some exchanges allow attaching TPSL.
      //   Here we will attempt to place separate Reduce-Only orders.

      // Note: If Entry is pending, placing Reduce-Only TP/SL might fail if no position exists yet.
      // This is a complex area. For MVP, we will try to place them if it's a Market order,
      // or rely on Exchange's "Algo Order" if it's a Stop Entry.

      if (entry.type === "market") {
        await this.placeRiskOrders(plan);
      } else {
        logger.info(
          `[TradeManager] Entry is Pending. TP/SL should be placed after fill (Not fully implemented yet, watch for fills).`
        );
        // TODO: Implement WebSocket monitoring to place TP/SL upon fill
      }
    } catch (error: any) {
      logger.error(`[TradeManager] Execution Failed: ${error.message}`);
      // TODO: Cancel any partial orders?
    }
  }

  private async placeRiskOrders(plan: TradePlan) {
    const exchange = this.exchangeManager.getExchange();

    try {
      // Stop Loss
      if (plan.stopLossOrder) {
        const sl = plan.stopLossOrder;
        logger.info(`[TradeManager] Placing Stop Loss: ${sl.stopPrice}`);
        const slParams = {
          ...sl.params,
          triggerPrice: sl.stopPrice,
          stopPrice: sl.stopPrice,
        };

        await exchange.createOrder(
          sl.symbol,
          sl.type,
          sl.side,
          sl.amount,
          sl.price, // undefined for stop_market
          slParams
        );
      }

      // Take Profit
      if (plan.takeProfitOrder) {
        const tp = plan.takeProfitOrder;
        logger.info(`[TradeManager] Placing Take Profit: ${tp.price}`);
        await exchange.createOrder(
          tp.symbol,
          tp.type,
          tp.side,
          tp.amount,
          tp.price,
          tp.params
        );
      }
    } catch (error: any) {
      logger.error(
        `[TradeManager] Failed to place Risk Orders: ${error.message}`
      );
      // Critical error: Position open without SL!
      // Urgent: Close position or retry?
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
