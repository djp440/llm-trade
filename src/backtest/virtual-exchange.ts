import { OHLC } from "../types";
import { logger } from "../utils/logger";
import {
  VirtualAccount,
  VirtualOrder,
  VirtualPosition,
  TradeResult,
} from "./types";

export class VirtualExchange {
  private account: VirtualAccount;
  private orders: VirtualOrder[] = [];
  private positions: VirtualPosition[] = [];
  private tradeHistory: TradeResult[] = [];
  private currentCandle: OHLC | null = null;

  constructor(initialBalance: number) {
    this.account = {
      balance: initialBalance,
      equity: initialBalance,
      initialBalance: initialBalance,
    };
  }

  public getAccountState() {
    return {
      ...this.account,
      orders: [...this.orders],
      positions: [...this.positions],
      tradeHistory: [...this.tradeHistory],
    };
  }

  public createOrder(
    order: Omit<VirtualOrder, "id" | "status" | "timestamp">
  ): VirtualOrder {
    const newOrder: VirtualOrder = {
      ...order,
      id: Math.random().toString(36).substring(2, 15),
      status: "open",
      timestamp: this.currentCandle ? this.currentCandle.timestamp : Date.now(),
    };
    this.orders.push(newOrder);
    logger.info(
      `[VirtualExchange] Order Created: ${newOrder.side} ${newOrder.type} @ ${
        newOrder.stopPrice || newOrder.price
      }`
    );
    return newOrder;
  }

  public cancelOrder(orderId: string): boolean {
    const index = this.orders.findIndex(o => o.id === orderId);
    if (index !== -1) {
      this.orders[index].status = "canceled";
      this.orders.splice(index, 1);
      logger.info(`[VirtualExchange] Order Canceled: ${orderId}`);
      return true;
    }
    return false;
  }

  public cancelAllOrders(symbol?: string) {
    if (symbol) {
      this.orders = this.orders.filter(o => o.symbol !== symbol);
    } else {
      this.orders = [];
    }
    logger.info(
      `[VirtualExchange] All orders canceled for ${symbol || "all symbols"}`
    );
  }

  public processCandle(candle: OHLC) {
    this.currentCandle = candle;

    // 1. Process Orders (Entry)
    // Clone orders to avoid modification issues during iteration
    const openOrders = [...this.orders];

    for (const order of openOrders) {
      if (order.type === "stop" || order.type === "stop_market") {
        this.checkStopOrder(order, candle);
      } else if (order.type === "market") {
        // Market orders fill at Open of the candle (simulation of next candle execution)
        this.executeOrder(order, candle.open, candle);
      } else if (order.type === "limit") {
        this.checkLimitOrder(order, candle);
      }
    }

    // 2. Process Positions (PnL, TP/SL)
    // We iterate backwards because we might remove positions
    for (let i = this.positions.length - 1; i >= 0; i--) {
      this.updatePosition(this.positions[i], candle);
    }

    // 3. Update Equity
    this.calculateEquity(candle);
  }

  private checkLimitOrder(order: VirtualOrder, candle: OHLC) {
    if (!order.price) return;

    let triggered = false;
    let fillPrice = order.price;

    if (order.side === "buy") {
      // Buy Limit: Triggered if Low <= Price
      if (candle.low <= order.price) {
        triggered = true;
        // If Open < Price, we likely filled at Open (better price)
        fillPrice = Math.min(candle.open, order.price);
      }
    } else {
      // Sell Limit: Triggered if High >= Price
      if (candle.high >= order.price) {
        triggered = true;
        // If Open > Price, we likely filled at Open (better price)
        fillPrice = Math.max(candle.open, order.price);
      }
    }

    if (triggered) {
      this.executeOrder(order, fillPrice, candle);
    }
  }

  private checkStopOrder(order: VirtualOrder, candle: OHLC) {
    if (!order.stopPrice) return;

    let triggered = false;
    let fillPrice = order.stopPrice;

    if (order.side === "buy") {
      // Buy Stop: Triggered if High >= StopPrice
      if (candle.high >= order.stopPrice) {
        triggered = true;
        // Simulating slippage/gap: If Open > StopPrice, we fill at Open (Gap Up)
        fillPrice = Math.max(candle.open, order.stopPrice);
      }
    } else {
      // Sell Stop: Triggered if Low <= StopPrice
      if (candle.low <= order.stopPrice) {
        triggered = true;
        // Gap Down
        fillPrice = Math.min(candle.open, order.stopPrice);
      }
    }

    if (triggered) {
      this.executeOrder(order, fillPrice, candle);
    }
  }

  private executeOrder(order: VirtualOrder, price: number, candle: OHLC) {
    logger.info(`[VirtualExchange] Order Triggered: ${order.side} @ ${price}`);

    // Remove from orders
    this.cancelOrder(order.id);

    // Create Position
    // Extract TP/SL from params if they exist (standardize this structure)
    // The TradePlan usually passes SL/TP as separate orders or params.
    // For simplicity in this backtester, we assume the logic that calls createOrder
    // will also manage SL/TP orders OR we can attach them to the position.
    // But wait, the user logic says: "Virtual exchange... setting fees...".
    // "Process position PnL, TP/SL checks".

    // The TradePlan in `src/types` has `stopLossOrder` and `takeProfitOrder`.
    // When the main `BacktestEngine` receives a signal, it creates a STOP entry.
    // Does it also create TP/SL orders immediately?
    // Usually, in `TradeManager`, we send OCO or separate orders after entry.
    // But here, for simplicity, we can store TP/SL on the position itself if the order has them.
    // Or we can let the Engine create TP/SL orders after it sees a position is opened.
    // BUT the requirement says: "if entry and exit in same candle".
    // This implies we need TP/SL info AT THE MOMENT of entry.

    // So, I will add `takeProfit` and `stopLoss` fields to `VirtualOrder` params or implicit expectation.
    // Let's assume `order.params` contains `stopLoss` and `takeProfit` prices.

    const stopLoss = order.stopPrice ? order.params?.stopLoss : undefined;
    const takeProfit = order.params?.takeProfit;

    const position: VirtualPosition = {
      id: Math.random().toString(36).substring(2, 15),
      symbol: order.symbol,
      side: order.side === "buy" ? "long" : "short",
      entryPrice: price,
      quantity: order.amount,
      entryTime: this.currentCandle ? this.currentCandle.timestamp : Date.now(),
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      unrealizedPnL: 0,
    };

    this.positions.push(position);

    // Deduct fees (simplified)
    const feeRate = 0.0006; // 0.05%
    const fee = price * order.amount * feeRate;
    this.account.balance -= fee;

    // IMMEDIATE CHECK: Does this same candle hit TP/SL?
    this.updatePosition(position, candle);
  }

  private updatePosition(position: VirtualPosition, candle: OHLC) {
    // 1. Calculate PnL
    const currentPrice = candle.close;
    let pnl = 0;
    if (position.side === "long") {
      pnl = (currentPrice - position.entryPrice) * position.quantity;
    } else {
      pnl = (position.entryPrice - currentPrice) * position.quantity;
    }
    position.unrealizedPnL = pnl;

    // 2. Check TP/SL
    // Pessimistic assumption: Check SL first.
    let closeReason = "";
    let closePrice = 0;

    if (position.side === "long") {
      if (position.stopLoss && candle.low <= position.stopLoss) {
        closeReason = "Stop Loss";
        closePrice = position.stopLoss; // Assuming guaranteed stop for simplicity, or use candle.low/open?
        // If gap down below SL, fill at Open (if Open < SL) or SL.
        // Actually, if Open < SL, it would have triggered at Open.
        // But if we just entered in this candle, Open is likely "Entry Price" or close to it.
        // If we entered at 100, SL 90. Candle Low 80.
        // We exit at 90.
        // Exception: If Candle Open was 85 (Gap down opening), we entered? No, we entered via Stop.
        // So we are inside the bar. We exit at SL.
      } else if (position.takeProfit && candle.high >= position.takeProfit) {
        closeReason = "Take Profit";
        closePrice = position.takeProfit;
      }
    } else {
      // Short
      if (position.stopLoss && candle.high >= position.stopLoss) {
        closeReason = "Stop Loss";
        closePrice = position.stopLoss;
      } else if (position.takeProfit && candle.low <= position.takeProfit) {
        closeReason = "Take Profit";
        closePrice = position.takeProfit;
      }
    }

    if (closeReason) {
      this.closePosition(position, closePrice, candle.timestamp, closeReason);
    }
  }

  private closePosition(
    position: VirtualPosition,
    price: number,
    timestamp: number,
    reason: string
  ) {
    logger.info(
      `[VirtualExchange] Position Closed (${reason}): ${position.side} @ ${price}`
    );

    let pnl = 0;
    if (position.side === "long") {
      pnl = (price - position.entryPrice) * position.quantity;
    } else {
      pnl = (position.entryPrice - price) * position.quantity;
    }

    // Fee
    const feeRate = 0.0005;
    const fee = price * position.quantity * feeRate;
    const finalPnL = pnl - fee;

    this.account.balance += finalPnL;

    // Record history
    this.tradeHistory.push({
      id: position.id,
      entryTime: position.entryTime,
      exitTime: timestamp,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: price,
      quantity: position.quantity,
      realizedPnL: finalPnL,
      returnPct: (finalPnL / (position.entryPrice * position.quantity)) * 100,
      reason: reason,
    });

    // Remove position
    this.positions = this.positions.filter(p => p !== position);
  }

  private calculateEquity(candle: OHLC) {
    let unrealized = 0;
    for (const p of this.positions) {
      unrealized += p.unrealizedPnL;
    }
    this.account.equity = this.account.balance + unrealized;
  }
}
