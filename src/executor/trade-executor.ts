import { TradeSignal, TradePlan, OrderRequest } from "../types";
import { ExchangeManager } from "../market/exchange-manager";
import { config } from "../config/config";
import { logger } from "../utils/logger";
import { Exchange } from "ccxt";

export class TradeExecutor {
  private exchange: Exchange;

  constructor(private exchangeManager: ExchangeManager) {
    this.exchange = this.exchangeManager.getExchange();
  }

  /**
   * Calculate position size based on risk management rules
   * Quantity = (Equity * RiskPerTrade) / |EntryPrice - StopLoss|
   */
  public calculateQuantity(
    symbol: string,
    equity: number,
    entryPrice: number,
    stopLoss: number
  ): number {
    const riskPerTrade = config.strategy.risk_per_trade;
    const riskAmount = equity * riskPerTrade;
    const priceDiff = Math.abs(entryPrice - stopLoss);

    if (priceDiff === 0) {
      logger.error(
        `[TradeExecutor] Invalid price difference (0) for ${symbol}`
      );
      return 0;
    }

    let quantity = riskAmount / priceDiff;

    // Validate against exchange limits
    const market = this.exchange.market(symbol);
    if (!market) {
      logger.error(`[TradeExecutor] Market info not found for ${symbol}`);
      return 0;
    }

    // Apply precision
    // ccxt amountToPrecision returns a string, we parse it back to number
    const quantityStr = this.exchange.amountToPrecision(symbol, quantity);
    quantity = parseFloat(quantityStr);

    // Check min/max limits
    if (market.limits.amount?.min && quantity < market.limits.amount.min) {
      logger.warn(
        `[TradeExecutor] Calculated quantity ${quantity} is below min limit ${market.limits.amount.min} for ${symbol}`
      );
      return 0; // Or return min if policy allows, but usually 0 means skip
    }

    if (market.limits.amount?.max && quantity > market.limits.amount.max) {
      logger.warn(
        `[TradeExecutor] Calculated quantity ${quantity} exceeds max limit ${market.limits.amount.max} for ${symbol}. Capping.`
      );
      quantity = market.limits.amount.max;
    }

    // Check cost limits (price * quantity) if available
    if (market.limits.cost?.min) {
      const cost = quantity * entryPrice;
      if (cost < market.limits.cost.min) {
        logger.warn(
          `[TradeExecutor] Trade cost ${cost} is below min cost ${market.limits.cost.min} for ${symbol}`
        );
        return 0;
      }
    }

    return quantity;
  }

  /**
   * Generate a comprehensive Trade Plan based on LLM signal and current market state
   */
  public generateTradePlan(
    signal: TradeSignal,
    currentPrice: number,
    equity: number,
    symbol: string
  ): TradePlan | null {
    if (signal.decision !== "APPROVE" || !signal.action) {
      return null;
    }

    // 1. Calculate Quantity (Override LLM suggestion with strict risk calc)
    const quantity = this.calculateQuantity(
      symbol,
      equity,
      signal.entryPrice,
      signal.stopLoss
    );

    if (quantity <= 0) {
      logger.warn(
        `[TradeExecutor] Quantity calculation failed or too small for ${symbol}`
      );
      return null;
    }

    const isBuy = signal.action === "BUY";
    const offsetTicks = config.execution.entry_offset_ticks || 1;

    // Determine Tick Size for Offset
    const market = this.exchange.market(symbol);
    // Rough estimation of tick size if not directly available as a number
    // Many ccxt exchanges have precision.price as number of decimals or actual value
    let tickSize = 0.0001; // Fallback

    // TICK_SIZE = 1, DECIMAL_PLACES = 0
    if (market.precision?.price) {
      if (this.exchange.precisionMode === 1) {
        tickSize = market.precision.price;
      } else {
        // DECIMAL_PLACES (0)
        tickSize = Math.pow(10, -market.precision.price);
      }
    }

    // Adjust Entry Price for Breakout (Scenario A)
    // If it's a breakout, we might want to enter slightly above high (Buy) or below low (Sell)
    // The signal.entryPrice is assumed to be the "Level" to break.
    let adjustedEntryPrice = signal.entryPrice;
    if (isBuy) {
      adjustedEntryPrice += tickSize * offsetTicks;
    } else {
      adjustedEntryPrice -= tickSize * offsetTicks;
    }

    // Ensure precision on price
    adjustedEntryPrice = parseFloat(
      this.exchange.priceToPrecision(symbol, adjustedEntryPrice)
    );

    // Determine Execution Scenario
    // Scenario A: Pending Order (Breakout)
    // Buy: Current < Entry
    // Sell: Current > Entry
    const isPending = isBuy
      ? currentPrice < signal.entryPrice
      : currentPrice > signal.entryPrice;

    // Construct Entry Order
    const entryOrder: OrderRequest = {
      symbol,
      side: isBuy ? "buy" : "sell",
      amount: quantity,
      type: isPending ? "stop_market" : "market", // Use stop_market for breakout trigger usually, or stop_limit
    };

    if (isPending) {
      // For stop_market, 'stopPrice' or 'triggerPrice' is needed.
      // CCXT unified usually uses 'params: { stopPrice: ... }' or specific arguments depending on exchange.
      // We set generic fields here.
      entryOrder.stopPrice = adjustedEntryPrice;
      // Some exchanges use 'price' as trigger for stop_market, others separate.
      // We will store it in stopPrice for clarity in the plan.
      entryOrder.price = adjustedEntryPrice; // For reference
    }

    // Construct TP/SL Orders
    // These are usually OCO or reduce-only orders placed after entry
    const stopLossOrder: OrderRequest = {
      symbol,
      side: isBuy ? "sell" : "buy",
      type: "stop_market", // Market execute on SL trigger
      amount: quantity,
      stopPrice: signal.stopLoss,
      params: { reduceOnly: true },
    };

    const takeProfitOrder: OrderRequest = {
      symbol,
      side: isBuy ? "sell" : "buy",
      type: "limit", // Usually TP is a limit order
      amount: quantity,
      price: signal.takeProfit,
      params: { reduceOnly: true },
    };

    const plan: TradePlan = {
      symbol,
      action: signal.action,
      entryOrder,
      stopLossOrder,
      takeProfitOrder,
      quantity,
      riskAmount: equity * config.strategy.risk_per_trade,
      reason: signal.reason,
    };

    logger.info(
      `[TradeExecutor] Generated Plan for ${symbol}: ${
        isPending ? "PENDING (Breakout)" : "MARKET"
      } | Qty: ${quantity} | Entry: ${adjustedEntryPrice}`
    );

    return plan;
  }
}
