import { TradeSignal, TradePlan, OrderRequest } from "../types";
import { ExchangeManager } from "../market/exchange-manager";
import { config } from "../config/config";
import { logger } from "../utils/logger";
import { Exchange, Order } from "ccxt";

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

  public async executeTradePlan(plan: TradePlan): Promise<Order[]> {
    logger.info(`[TradeExecutor] Executing Trade Plan for ${plan.symbol}...`);
    const orders: Order[] = [];

    try {
      // 1. Place Entry Order
      const entry = plan.entryOrder;
      logger.info(
        `[TradeExecutor] Placing Entry Order: ${entry.type} ${entry.side} ${
          entry.amount
        } @ ${entry.price || entry.stopPrice || "Market"}`
      );

      const params = entry.params || {};
      let price = entry.price;

      let orderType = entry.type;

      // Handle Trigger Price for Stop Orders
      if (entry.type === "stop_market" || entry.type === "stop") {
        if (entry.stopPrice) {
          params["triggerPrice"] = entry.stopPrice;
          params["stopPrice"] = entry.stopPrice;
        }
        if (entry.type === "stop_market") {
          price = undefined;
          // For Bitget (and many others via CCXT), 'stop_market' is achieved by sending 'market' + trigger params
          // If we send 'stop_market' explicitly, some exchanges reject it.
          // We'll rely on triggerPrice to define it as a stop order.
          if (this.exchange.id === "bitget") {
            orderType = "market";
          }
        }
      }

      // Bitget V2 Position Mode Handling & Retry Logic
      let isHedgeMode = false;
      let order: Order | null = null;

      if (this.exchange.id === "bitget") {
        try {
          const mode: any = await this.exchange.fetchPositionMode(entry.symbol);
          isHedgeMode = mode.hedged;
        } catch (e) {
          logger.warn(
            `[TradeExecutor] Failed to fetch position mode, defaulting to One-Way: ${e}`
          );
        }
      }

      // Helper to prepare params based on mode
      const prepareParams = (modeHedged: boolean) => {
        const p = { ...params };
        if (this.exchange.id === "bitget") {
          if (modeHedged) {
            p["tradeSide"] = "Open";
          } else {
            if (p["tradeSide"]) delete p["tradeSide"];
          }
        }
        return p;
      };

      try {
        const p = prepareParams(isHedgeMode);
        order = await this.exchange.createOrder(
          entry.symbol,
          orderType,
          entry.side,
          entry.amount,
          price,
          p
        );
      } catch (e: any) {
        // Retry with opposite mode if Bitget error 40774 (One-Way param on Hedge account)
        if (this.exchange.id === "bitget" && e.message.includes("40774")) {
          logger.warn(
            `[TradeExecutor] Order failed with mode mismatch (${isHedgeMode}). Retrying with opposite mode...`
          );
          isHedgeMode = !isHedgeMode;
          const p = prepareParams(isHedgeMode);
          order = await this.exchange.createOrder(
            entry.symbol,
            orderType,
            entry.side,
            entry.amount,
            price,
            p
          );
        } else {
          throw e;
        }
      }

      if (!order) throw new Error("Order creation failed unexpectedly.");

      logger.info(`[TradeExecutor] Entry Order Placed. ID: ${order.id}`);
      orders.push(order);

      // 2. Place TP/SL if Entry was Market
      if (entry.type === "market") {
        logger.info(
          "[TradeExecutor] Market Entry Placed. Waiting 3s for fill before placing Risk Orders..."
        );
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Verify Order Status
        try {
          const updatedOrder = await this.exchange.fetchOrder(
            order.id,
            entry.symbol
          );
          logger.info(
            `[TradeExecutor] Entry Order Status: ${updatedOrder.status}, Filled: ${updatedOrder.filled}`
          );

          if (
            updatedOrder.status === "open" &&
            (!updatedOrder.filled || updatedOrder.filled === 0)
          ) {
            logger.warn(
              "[TradeExecutor] Entry order not filled yet. Skipping Risk Orders (or waiting longer)."
            );
            // Ideally we should wait loop here, but for now just abort risk orders to avoid error
            // or maybe we place them as 'reduceOnly' if supported, but 'Close' requires position.
          } else {
            const riskOrders = await this.placeRiskOrders(plan, isHedgeMode);
            orders.push(...riskOrders);
          }
        } catch (e: any) {
          logger.warn(
            `[TradeExecutor] Failed to fetch entry order status: ${e.message}`
          );
          // Try placing risk orders anyway? risky.
        }
      } else {
        logger.info(
          `[TradeExecutor] Entry is Pending. TP/SL should be placed after fill.`
        );
      }
    } catch (error: any) {
      logger.error(`[TradeExecutor] Execution Failed: ${error.message}`);
      throw error;
    }

    return orders;
  }

  private async placeRiskOrders(
    plan: TradePlan,
    isHedgeMode: boolean = false
  ): Promise<Order[]> {
    const orders: Order[] = [];
    try {
      // Take Profit (Limit Order or Trigger Order)
      if (plan.takeProfitOrder) {
        const tp = plan.takeProfitOrder;
        logger.info(
          `[TradeExecutor] Placing Take Profit: ${tp.price || tp.stopPrice}`
        );

        const tpParams = {
          ...tp.params,
          triggerPrice: tp.stopPrice || tp.params?.triggerPrice, // Ensure triggerPrice is set if it's a stop order
          stopPrice: tp.stopPrice || tp.params?.stopPrice,
        };

        // Bitget V2 Mode Specifics
        let tpType = tp.type;
        let tpPrice = tp.price;

        if (this.exchange.id === "bitget") {
          if (isHedgeMode) {
            tpParams["tradeSide"] = "Close";
          } else {
            // One-Way: No tradeSide, use reduceOnly (usually default for closing but explicit is good)
            if (tpParams["tradeSide"]) delete tpParams["tradeSide"];
            tpParams["reduceOnly"] = true;
          }

          if (tp.type === "stop_market") {
            tpType = "market";
            tpPrice = undefined;
          }
        }

        const order = await this.exchange.createOrder(
          tp.symbol,
          tpType,
          tp.side,
          tp.amount,
          tpPrice,
          tpParams
        );
        logger.info(`[TradeExecutor] Take Profit Placed. ID: ${order.id}`);
        orders.push(order);
      }

      // Stop Loss (Trigger Order - usually doesn't lock position)
      if (plan.stopLossOrder) {
        const sl = plan.stopLossOrder;
        logger.info(`[TradeExecutor] Placing Stop Loss: ${sl.stopPrice}`);
        const slParams = {
          ...sl.params,
          triggerPrice: sl.stopPrice,
          stopPrice: sl.stopPrice,
        };

        // Bitget V2 Mode Specifics
        let slType = sl.type;
        let slPrice = sl.price;

        if (this.exchange.id === "bitget") {
          if (isHedgeMode) {
            slParams["tradeSide"] = "Close";
          } else {
            // One-Way
            if (slParams["tradeSide"]) delete slParams["tradeSide"];
            slParams["reduceOnly"] = true;
          }

          if (sl.type === "stop_market") {
            slType = "market";
            slPrice = undefined;
          }
        }

        const order = await this.exchange.createOrder(
          sl.symbol,
          slType,
          sl.side,
          sl.amount,
          slPrice,
          slParams
        );
        logger.info(`[TradeExecutor] Stop Loss Placed. ID: ${order.id}`);
        orders.push(order);
      }
    } catch (error: any) {
      logger.error(
        `[TradeExecutor] Failed to place Risk Orders: ${error.message}`
      );
      throw error;
    }
    return orders;
  }
}
