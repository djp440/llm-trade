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
      logger.error(`[交易执行器] ${symbol} 的价格差无效 (0)`);
      return 0;
    }

    let quantity = riskAmount / priceDiff;

    // 根据交易所限制进行验证
    const market = this.exchange.market(symbol);
    if (!market) {
      logger.error(`[交易执行器] 未找到 ${symbol} 的市场信息`);
      return 0;
    }

    // 应用精度
    // ccxt amountToPrecision 返回字符串，我们将其解析回数字
    const quantityStr = this.exchange.amountToPrecision(symbol, quantity);
    quantity = parseFloat(quantityStr);

    // 检查最小/最大限制
    if (market.limits.amount?.min && quantity < market.limits.amount.min) {
      logger.warn(
        `[交易执行器] ${symbol} 计算出的数量 ${quantity} 低于最小限制 ${market.limits.amount.min}`
      );
      return 0; // 或者如果政策允许则返回最小值，但通常 0 表示跳过
    }

    // Min Notional Check (Safety Check for Bitget/Binance)
    // Value = Quantity * EntryPrice
    const estimatedValue = quantity * entryPrice;
    const MIN_NOTIONAL = config.execution.min_notional;
    if (estimatedValue < MIN_NOTIONAL) {
      logger.warn(
        `[交易执行器] 交易被拒绝：名义价值 ${estimatedValue.toFixed(
          2
        )} 低于交易所限制（< ${MIN_NOTIONAL} USDT）`
      );
      return 0;
    }

    if (market.limits.amount?.max && quantity > market.limits.amount.max) {
      logger.warn(
        `[交易执行器] ${symbol} 计算出的数量 ${quantity} 超过最大限制 ${market.limits.amount.max}。正在进行上限限制。`
      );
      quantity = market.limits.amount.max;
    }

    // 如果可用，检查成本限制 (价格 * 数量)
    if (market.limits.cost?.min) {
      const cost = quantity * entryPrice;
      if (cost < market.limits.cost.min) {
        logger.warn(
          `[交易执行器] ${symbol} 的交易成本 ${cost} 低于最小成本 ${market.limits.cost.min}`
        );
        return 0;
      }
    }

    return quantity;
  }

  /**
   * 根据 LLM 信号和当前市场状态生成综合交易计划
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

    if (
      !Number.isFinite(signal.entryPrice) ||
      !Number.isFinite(signal.stopLoss) ||
      !Number.isFinite(signal.takeProfit)
    ) {
      logger.warn(
        `[交易执行器] ${symbol} 信号价格包含非数值，已忽略。entry=${signal.entryPrice} sl=${signal.stopLoss} tp=${signal.takeProfit}`
      );
      return null;
    }

    if (!signal.action || signal.action === "NO_ACTION") {
      logger.info(`[交易执行器] ${symbol} 信号为 NO_ACTION，忽略。`);
      return null;
    }

    const isBuy = signal.action === "BUY";
    const offsetTicks = config.execution.entry_offset_ticks || 1;

    // 确定偏移的跳动点大小 (Tick Size)
    const market = this.exchange.market(symbol);
    // 如果无法直接获取数字，则粗略估计跳动点大小
    // 许多 ccxt 交易所将 precision.price 作为小数位数或实际值
    let tickSize = 0.0001; // 备用值

    // TICK_SIZE = 1, DECIMAL_PLACES = 0
    if (market.precision?.price) {
      if (this.exchange.precisionMode === 1) {
        tickSize = market.precision.price;
      } else {
        // DECIMAL_PLACES (0)
        tickSize = Math.pow(10, -market.precision.price);
      }
    }

    // 为突破调整进场价格 (场景 A)
    // 如果是突破，我们可能希望在最高点上方 (买入) 或最低点下方 (卖出) 稍微进入
    // signal.entryPrice 被假定为要突破的“水平”。
    let adjustedEntryPrice = signal.entryPrice ?? currentPrice;
    if (isBuy) {
      adjustedEntryPrice += tickSize * offsetTicks;
    } else {
      adjustedEntryPrice -= tickSize * offsetTicks;
    }

    // 确保价格精度
    adjustedEntryPrice = parseFloat(
      this.exchange.priceToPrecision(symbol, adjustedEntryPrice)
    );

    // 确定执行场景
    // 场景 A: 挂单 (突破)
    // 买入: 当前 < 进场
    // 卖出: 当前 > 进场
    // 如果 adjustedEntryPrice 仍未定义 (不可能发生，因为上面的检查)，则回退到 signal.entryPrice
    const finalEntryPrice =
      adjustedEntryPrice ?? signal.entryPrice ?? currentPrice;

    const isPending = isBuy
      ? currentPrice < finalEntryPrice
      : currentPrice > finalEntryPrice;

    const referenceEntryPrice = isPending
      ? finalEntryPrice
      : this.getEstimatedMarketEntryPrice(currentPrice, isBuy);

    const formattedStopLoss = this.exchange.priceToPrecision(
      symbol,
      signal.stopLoss
    );
    const formattedTakeProfit = this.exchange.priceToPrecision(
      symbol,
      signal.takeProfit
    );
    const stopLossPrice = parseFloat(formattedStopLoss);
    const takeProfitPrice = parseFloat(formattedTakeProfit);

    if (
      stopLossPrice !== 0 &&
      takeProfitPrice !== 0 &&
      !this.isPriceRelationshipValid(
        signal.action as "BUY" | "SELL",
        referenceEntryPrice,
        stopLossPrice,
        takeProfitPrice
      )
    ) {
      logger.warn(
        `[交易执行器] ${symbol} 信号价格关系无效，已跳过下单。方向=${signal.action} entryRef=${referenceEntryPrice} sl=${stopLossPrice} tp=${takeProfitPrice}`
      );
      return null;
    }

    let quantity: number;
    if (signal.quantity && signal.quantity > 0) {
      // 使用信号指定的仓位百分比计算: Value = Equity * (q / 100)
      const positionValue = equity * (signal.quantity / 100);
      // Quantity = Value / Price
      const rawQuantity = positionValue / referenceEntryPrice;
      quantity = parseFloat(
        this.exchange.amountToPrecision(symbol, rawQuantity)
      );
      logger.info(
        `[交易执行器] 使用策略指定仓位: ${signal.quantity}% (权益: ${equity}) -> 数量: ${quantity}`
      );
    } else {
      quantity = this.calculateQuantity(
        symbol,
        equity,
        referenceEntryPrice,
        stopLossPrice
      );
    }

    if (quantity <= 0) {
      logger.warn(`[交易执行器] ${symbol} 数量计算失败或太小`);
      return null;
    }

    // 构建进场订单
    const entryOrder: OrderRequest = {
      symbol,
      side: isBuy ? "buy" : "sell",
      amount: quantity,
      type: isPending ? "stop_market" : "market", // 通常对突破触发使用 stop_market 或 stop_limit
      params: {},
    };

    // 将止盈止损直接附加到进场订单参数中 (Bitget 专用)
    if (this.exchange.id === "bitget") {
      entryOrder.params = { ...entryOrder.params };

      if (stopLossPrice > 0) {
        entryOrder.params.stopLoss = {
          triggerPrice: stopLossPrice,
          price: stopLossPrice,
          type: "mark_price",
        };
      }

      if (takeProfitPrice > 0) {
        entryOrder.params.takeProfit = {
          triggerPrice: takeProfitPrice,
          price: takeProfitPrice,
          type: "mark_price",
        };
      }
    }

    if (isPending) {
      // 对于 stop_market，需要 'stopPrice' 或 'triggerPrice'。
      // CCXT 统一调用通常根据交易所使用 'params: { stopPrice: ... }' 或特定参数。
      // 我们在这里设置通用字段。
      entryOrder.stopPrice = adjustedEntryPrice;
      // 某些交易所使用 'price' 作为 stop_market 的触发器，其他交易所则分开。
      // 为了计划的清晰，我们将它存储在 stopPrice 中。
      entryOrder.price = adjustedEntryPrice; // 仅供参考
    }

    // 构建止盈/止损订单 (仅用于记录或非 Bitget 交易所回退)
    // 注意：如果已在 entryOrder.params 中设置，则不需要单独执行
    const stopLossOrder: OrderRequest = {
      symbol,
      side: isBuy ? "sell" : "buy",
      type: "stop_market", // 止损触发时市价执行
      amount: quantity,
      stopPrice: stopLossPrice,
      params: { reduceOnly: true },
    };

    const takeProfitOrder: OrderRequest = {
      symbol,
      side: isBuy ? "sell" : "buy",
      type: "limit", // 通常止盈是限价单
      amount: quantity,
      price: takeProfitPrice,
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

    logger.important(
      `[交易执行器] 已为 ${symbol} 生成计划: ${
        isPending ? "挂单 (突破)" : "市价"
      } | 数量: ${quantity} | 进场参考: ${referenceEntryPrice} | 止损: ${formattedStopLoss} | 止盈: ${formattedTakeProfit}`
    );

    return plan;
  }

  public async executeTradePlan(plan: TradePlan): Promise<Order[]> {
    logger.important(`[交易执行器] 正在执行 ${plan.symbol} 的交易计划...`);
    const orders: Order[] = [];

    try {
      // 1. 下达进场订单 (携带止盈止损)
      const entry = plan.entryOrder;
      logger.tradeOpen(
        `[交易执行器] 正在下达进场订单: ${entry.type} ${entry.side} ${
          entry.amount
        } @ ${entry.price || entry.stopPrice || "市价"}`
      );

      const params = entry.params || {};
      let price = entry.price;

      // Handle Trigger Price for Stop Orders
      if (entry.type === "stop_market" || entry.type === "stop") {
        if (entry.stopPrice) {
          params["triggerPrice"] = entry.stopPrice;
          params["stopPrice"] = entry.stopPrice;
        }

        if (this.exchange.id === "bitget" && !params["triggerType"]) {
          params["triggerType"] = "mark_price";
        }

        if (entry.type === "stop_market") {
          price = undefined;
          // For Bitget (and many others via CCXT), 'stop_market' is achieved by sending 'market' + trigger params
          // If we send 'stop_market' explicitly, some exchanges reject it.
          // We'll rely on triggerPrice to define it as a stop order.
          if (this.exchange.id === "bitget") {
            entry.type = "market";
          }
        }
      }

      // Bitget V2 Position Mode Handling
      // 用户指定使用 One-Way 模式 (单向持仓)。
      // 我们不再尝试检测或适配 Hedge 模式，而是直接假设为 One-Way。
      // 对于 Bitget One-Way 模式，不需要 tradeSide 参数。

      const orderType =
        entry.type === "stop_market" && this.exchange.id === "bitget"
          ? "market"
          : entry.type;

      let order: Order | undefined;
      try {
        order = await this.exchange.createOrder(
          entry.symbol,
          orderType,
          entry.side,
          entry.amount,
          price,
          params
        );
      } catch (e: any) {
        logger.error(`[交易执行器] 下单失败: ${e.message}`);
        throw e;
      }

      if (!order) throw new Error("订单创建意外失败。");

      logger.tradeOpen(
        `[交易执行器] 进场订单已下达 (附带 TP/SL)。ID: ${order.id}`
      );
      orders.push(order);

      // 注意: 我们不再需要单独下达风险订单，因为它们已附加到进场订单中
    } catch (error: any) {
      logger.error(`[交易执行器] 执行失败: ${error.message}`);
      throw error;
    }

    return orders;
  }

  public async closePosition(
    symbol: string,
    side: "long" | "short"
  ): Promise<Order[]> {
    try {
      logger.important(`[交易执行器] 正在尝试平仓 ${symbol} ${side} 头寸...`);

      // 1. 获取持仓
      // 注意：fetchPositions 可能需要特定的参数或返回所有符号
      const positions = await this.exchange.fetchPositions([symbol]);

      // 查找对应方向的持仓
      // CCXT 结构: side is 'long' or 'short'. contracts is absolute size.
      // 在单向模式下，side 可能是 'long' (如果 quantity > 0) 或 'short' (如果 quantity < 0)
      const position = positions.find(
        p =>
          p.symbol === symbol &&
          (p.contracts || 0) > 0 &&
          (p.side === side || (p.side === undefined && side === "long")) // Fallback logic
      );

      if (!position || (position.contracts || 0) <= 0) {
        logger.info(
          `[交易执行器] 未找到 ${symbol} 的 ${side} 持仓，无需平仓。`
        );
        return [];
      }

      logger.important(
        `[交易执行器] 发现 ${side} 持仓: ${position.contracts} 张/币。正在执行市价全平...`
      );

      // 2. 准备平仓订单
      const orderSide = side === "long" ? "sell" : "buy";
      const amount = position.contracts || 0;
      const orderType = "market";
      const params: any = { reduceOnly: true };

      // Bitget One-Way 模式不需要 tradeSide，只需 reduceOnly 即可 (甚至 reduceOnly 也不是必须的，如果是反手单则不需要)
      // 但为了安全起见，单纯平仓使用 reduceOnly。

      // 3. 下单
      const order = await this.exchange.createOrder(
        symbol,
        orderType,
        orderSide,
        amount,
        undefined,
        params
      );

      logger.tradeClose(
        `[交易执行器] ${symbol} ${side} 持仓已平仓。订单ID: ${order.id}`
      );
      return [order];
    } catch (error: any) {
      logger.error(`[交易执行器] 平仓失败: ${error.message}`);
      throw error;
    }
  }

  private isPriceRelationshipValid(
    action: "BUY" | "SELL",
    entryPrice: number,
    stopLoss: number,
    takeProfit: number
  ): boolean {
    if (
      !Number.isFinite(entryPrice) ||
      !Number.isFinite(stopLoss) ||
      !Number.isFinite(takeProfit)
    ) {
      return false;
    }
    if (entryPrice <= 0 || stopLoss <= 0 || takeProfit <= 0) {
      return false;
    }
    if (action === "BUY") {
      return stopLoss < entryPrice && takeProfit > entryPrice;
    }
    return takeProfit < entryPrice && stopLoss > entryPrice;
  }

  private getEstimatedMarketEntryPrice(
    currentPrice: number,
    isBuy: boolean
  ): number {
    const slippage = config.execution.slippage_tolerance ?? 0;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0)
      return currentPrice;
    if (!Number.isFinite(slippage) || slippage <= 0) return currentPrice;
    return isBuy
      ? currentPrice * (1 + slippage)
      : currentPrice * (1 - slippage);
  }
}
