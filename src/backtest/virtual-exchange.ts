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

    // One-Way Mode Logic: Check for existing position
    // We assume only one position per symbol allowed (One-Way)
    const existingPosIndex = this.positions.findIndex(
      p => p.symbol === order.symbol
    );

    const feeRate = 0.0006; // 0.06%
    const fee = price * order.amount * feeRate;
    this.account.balance -= fee;

    if (existingPosIndex >= 0) {
      const existingPos = this.positions[existingPosIndex];
      const isSameSide =
        (order.side === "buy" && existingPos.side === "long") ||
        (order.side === "sell" && existingPos.side === "short");

      if (isSameSide) {
        // Increase Position
        const totalQty = existingPos.quantity + order.amount;
        // Avg Entry Price = (OldVal + NewVal) / TotalQty
        const oldVal = existingPos.entryPrice * existingPos.quantity;
        const newVal = price * order.amount;
        existingPos.entryPrice = (oldVal + newVal) / totalQty;
        existingPos.quantity = totalQty;

        // Update TP/SL if provided in new order?
        // Usually we keep old or update if specified. Let's update if provided.
        if (order.params?.stopLoss)
          existingPos.stopLoss = order.params.stopLoss;
        if (order.params?.takeProfit)
          existingPos.takeProfit = order.params.takeProfit;

        logger.info(
          `[VirtualExchange] Increased Position: ${existingPos.side} NewQty: ${existingPos.quantity}`
        );
      } else {
        // Opposite Side -> Reduce / Close / Flip
        if (order.amount === existingPos.quantity) {
          // Full Close
          this.closePosition(
            existingPos,
            price,
            candle.timestamp,
            "Market Close"
          );
        } else if (order.amount < existingPos.quantity) {
          // Partial Close
          // Realized PnL on closed portion
          const closedQty = order.amount;
          let pnl = 0;
          if (existingPos.side === "long") {
            pnl = (price - existingPos.entryPrice) * closedQty;
          } else {
            pnl = (existingPos.entryPrice - price) * closedQty;
          }
          // No fee here, already deducted above for the order execution

          this.account.balance += pnl;

          // Record Trade (Partial)
          this.tradeHistory.push({
            id: existingPos.id + "_part",
            entryTime: existingPos.entryTime,
            exitTime: candle.timestamp,
            side: existingPos.side,
            entryPrice: existingPos.entryPrice,
            exitPrice: price,
            quantity: closedQty,
            realizedPnL: pnl,
            returnPct: (pnl / (existingPos.entryPrice * closedQty)) * 100,
            reason: "Partial Close",
          });

          existingPos.quantity -= closedQty;
          logger.info(
            `[VirtualExchange] Reduced Position: ${existingPos.side} RemQty: ${existingPos.quantity}`
          );
        } else {
          // Flip (Close + Open New)
          // 1. Close existing
          this.closePosition(
            existingPos,
            price,
            candle.timestamp,
            "Market Reverse (Flip)"
          );

          // 2. Open remainder
          const remainingQty = order.amount - existingPos.quantity;
          const newSide = order.side === "buy" ? "long" : "short";

          // Need to add fee for the remainder?
          // We deducted fee for FULL amount already. That covers both the close part and open part.

          const newPos: VirtualPosition = {
            id: Math.random().toString(36).substring(2, 15),
            symbol: order.symbol,
            side: newSide as "long" | "short",
            entryPrice: price,
            quantity: remainingQty,
            entryTime: candle.timestamp,
            stopLoss: order.params?.stopLoss,
            takeProfit: order.params?.takeProfit,
            unrealizedPnL: 0,
          };
          this.positions.push(newPos);
          logger.info(
            `[VirtualExchange] Flipped Position: Now ${newSide} Qty: ${remainingQty}`
          );

          // Immediate check for the new position
          this.updatePosition(newPos, candle);
        }
      }
    } else {
      // New Position
      const stopLoss = order.stopPrice ? order.params?.stopLoss : undefined;
      const takeProfit = order.params?.takeProfit;

      const position: VirtualPosition = {
        id: Math.random().toString(36).substring(2, 15),
        symbol: order.symbol,
        side: order.side === "buy" ? "long" : "short",
        entryPrice: price,
        quantity: order.amount,
        entryTime: this.currentCandle
          ? this.currentCandle.timestamp
          : Date.now(),
        stopLoss: stopLoss,
        takeProfit: takeProfit,
        unrealizedPnL: 0,
      };

      this.positions.push(position);

      // IMMEDIATE CHECK: Does this same candle hit TP/SL?
      this.updatePosition(position, candle);
    }
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
