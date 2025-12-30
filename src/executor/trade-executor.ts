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

    // 1. 计算数量 (使用严格的风险计算覆盖 LLM 建议)
    const quantity = this.calculateQuantity(
      symbol,
      equity,
      signal.entryPrice,
      signal.stopLoss
    );

    if (quantity <= 0) {
      logger.warn(`[交易执行器] ${symbol} 数量计算失败或太小`);
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
    let adjustedEntryPrice = signal.entryPrice;
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
    const isPending = isBuy
      ? currentPrice < signal.entryPrice
      : currentPrice > signal.entryPrice;

    // 构建进场订单
    const entryOrder: OrderRequest = {
      symbol,
      side: isBuy ? "buy" : "sell",
      amount: quantity,
      type: isPending ? "stop_market" : "market", // 通常对突破触发使用 stop_market 或 stop_limit
    };

    if (isPending) {
      // 对于 stop_market，需要 'stopPrice' 或 'triggerPrice'。
      // CCXT 统一调用通常根据交易所使用 'params: { stopPrice: ... }' 或特定参数。
      // 我们在这里设置通用字段。
      entryOrder.stopPrice = adjustedEntryPrice;
      // 某些交易所使用 'price' 作为 stop_market 的触发器，其他交易所则分开。
      // 为了计划的清晰，我们将它存储在 stopPrice 中。
      entryOrder.price = adjustedEntryPrice; // 仅供参考
    }

    // 构建止盈/止损订单
    // 这些通常是在进场后下达的 OCO 或只减仓订单
    const stopLossOrder: OrderRequest = {
      symbol,
      side: isBuy ? "sell" : "buy",
      type: "stop_market", // 止损触发时市价执行
      amount: quantity,
      stopPrice: signal.stopLoss,
      params: { reduceOnly: true },
    };

    const takeProfitOrder: OrderRequest = {
      symbol,
      side: isBuy ? "sell" : "buy",
      type: "limit", // 通常止盈是限价单
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
      `[交易执行器] 已为 ${symbol} 生成计划: ${
        isPending ? "挂单 (突破)" : "市价"
      } | 数量: ${quantity} | 进场: ${adjustedEntryPrice}`
    );

    return plan;
  }

  public async executeTradePlan(plan: TradePlan): Promise<Order[]> {
    logger.info(`[交易执行器] 正在执行 ${plan.symbol} 的交易计划...`);
    const orders: Order[] = [];

    try {
      // 1. 下达进场订单
      const entry = plan.entryOrder;
      logger.info(
        `[交易执行器] 正在下达进场订单: ${entry.type} ${entry.side} ${
          entry.amount
        } @ ${entry.price || entry.stopPrice || "市价"}`
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
            `[交易执行器] 获取持仓模式失败，默认为单向持仓 (One-Way): ${e}`
          );
        }
      }

      // 根据模式准备参数的辅助函数
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
        // 如果是 Bitget 错误 40774 (在对冲账户上使用单向参数)，则重试相反模式
        if (this.exchange.id === "bitget" && e.message.includes("40774")) {
          logger.warn(
            `[交易执行器] 订单因模式不匹配而失败 (${isHedgeMode})。正在尝试相反模式...`
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

      if (!order) throw new Error("订单创建意外失败。");

      logger.info(`[交易执行器] 进场订单已下达。ID: ${order.id}`);
      orders.push(order);

      // 2. 如果进场是市价单，则下达止盈/止损
      if (entry.type === "market") {
        logger.info(
          "[交易执行器] 市价进场已下达。在下达风险订单前等待 3 秒以确保成交..."
        );
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 验证订单状态
        try {
          const updatedOrder = await this.exchange.fetchOrder(
            order.id,
            entry.symbol
          );
          logger.info(
            `[交易执行器] 进场订单状态: ${updatedOrder.status}, 已成交: ${updatedOrder.filled}`
          );

          if (
            updatedOrder.status === "open" &&
            (!updatedOrder.filled || updatedOrder.filled === 0)
          ) {
            logger.warn(
              "[交易执行器] 进场订单尚未成交。跳过风险订单（或等待更长时间）。"
            );
            // 理想情况下我们应该在这里循环等待，但目前只是中止风险订单以避免错误
            // 或者如果支持的话，我们可以将它们作为 'reduceOnly' 下达，但 'Close' 需要仓位。
          } else {
            const riskOrders = await this.placeRiskOrders(plan, isHedgeMode);
            orders.push(...riskOrders);
          }
        } catch (e: any) {
          logger.warn(`[交易执行器] 获取进场订单状态失败: ${e.message}`);
          // 仍然尝试下达风险订单？有风险。
        }
      } else {
        logger.info(`[交易执行器] 进场为挂单。止盈/止损应在成交后下达。`);
      }
    } catch (error: any) {
      logger.error(`[交易执行器] 执行失败: ${error.message}`);
      throw error;
    }

    return orders;
  }

  public async placeRiskOrders(
    plan: TradePlan,
    isHedgeMode: boolean = false
  ): Promise<Order[]> {
    const orders: Order[] = [];
    try {
      // 止盈 (限价单或触发单)
      if (plan.takeProfitOrder) {
        const tp = plan.takeProfitOrder;
        logger.info(`[交易执行器] 正在下达止盈: ${tp.price || tp.stopPrice}`);

        const tpParams = {
          ...tp.params,
          triggerPrice: tp.stopPrice || tp.params?.triggerPrice, // 确保如果是停止单则设置了 triggerPrice
          stopPrice: tp.stopPrice || tp.params?.stopPrice,
        };

        // Bitget V2 模式细节
        let tpType = tp.type;
        let tpPrice = tp.price;

        if (this.exchange.id === "bitget") {
          if (isHedgeMode) {
            tpParams["tradeSide"] = "Close";
          } else {
            // 单向持仓: 无 tradeSide，使用 reduceOnly (通常关闭仓位默认如此，但明确设置更好)
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
        logger.info(`[交易执行器] 止盈已下达。ID: ${order.id}`);
        orders.push(order);
      }

      // 止损 (触发单 - 通常不锁定仓位)
      if (plan.stopLossOrder) {
        const sl = plan.stopLossOrder;
        logger.info(`[交易执行器] 正在下达止损: ${sl.stopPrice}`);
        const slParams = {
          ...sl.params,
          triggerPrice: sl.stopPrice,
          stopPrice: sl.stopPrice,
        };

        // Bitget V2 模式细节
        let slType = sl.type;
        let slPrice = sl.price;

        if (this.exchange.id === "bitget") {
          if (isHedgeMode) {
            slParams["tradeSide"] = "Close";
          } else {
            // 单向持仓
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
        logger.info(`[交易执行器] 止损已下达。ID: ${order.id}`);
        orders.push(order);
      }
    } catch (error: any) {
      logger.error(`[交易执行器] 下达风险订单失败: ${error.message}`);
      throw error;
    }
    return orders;
  }
}
