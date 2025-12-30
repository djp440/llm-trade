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
  PENDING_ENTRY = "PENDING_ENTRY",
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
  private pendingTradePlan: TradePlan | null = null;
  private pendingEntryOrder: Order | null = null;

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
    logger.info(`[交易管理器] 正在启动 ${this.symbol} 的循环`);

    while (this.isRunning) {
      try {
        // 计算下一个 K 线收盘的等待时间
        const timeframe = config.strategy.timeframe;
        const msPerCandle = this.marketData.parseTimeframeToMs(timeframe);
        const now = Date.now();
        // 下一个边界
        const nextCandleTime = Math.ceil(now / msPerCandle) * msPerCandle;
        // 添加缓冲（例如 5 秒）以确保交易所已处理收盘
        const waitTime = nextCandleTime - now + 5000;

        logger.info(
          `[交易管理器] ${this.symbol} 正在休眠 ${Math.round(
            waitTime / 1000
          )}秒，直到下一个 K 线收盘...`
        );

        // 等待...
        await this.sleep(waitTime);

        // 唤醒并处理
        if (this.state === TradeState.SEARCHING) {
          await this.processSignalSearch();
        } else if (this.state === TradeState.PENDING_ENTRY) {
          await this.processPendingEntry();
        } else {
          // 如果正在管理仓位，也许我们也要在这里检查状态，或者依赖 WS
          // 在这一步，我们假设如果没有被阻塞，我们就循环回来检查信号
          logger.info(
            `[交易管理器] ${this.symbol} 处于状态 ${this.state}，跳过信号搜索。`
          );
        }
      } catch (error: any) {
        logger.error(`[交易管理器] ${this.symbol} 循环出错: ${error.message}`);
        await this.sleep(10000); // 错误退避
      }
    }
  }

  private async processSignalSearch() {
    logger.info(`[交易管理器] ${this.symbol} - 开始信号搜索阶段`);

    // 1. 获取数据
    const lookback = config.strategy.lookback_candles;
    const timeframe = config.strategy.timeframe;

    // 获取确认关闭的 K 线
    const candles = await this.marketData.getConfirmedCandles(
      timeframe,
      lookback
    );
    const lastCandle = candles[candles.length - 1];

    logger.info(
      `[交易管理器] ${this.symbol} - 分析在 ${new Date(
        lastCandle.timestamp
      ).toISOString()} 收盘的 K 线`
    );

    // 2. 获取账户信息
    // 我们获取总权益。未来我们可能想要每个交易对的逐仓保证金。
    const balance = await this.exchangeManager.getExchange().fetchBalance();
    // 假设基于 USDT
    const equity = (balance as any).total["USDT"] || 0;

    if (equity === 0) {
      logger.warn(`[交易管理器] ${this.symbol} - 权益为零，跳过分析。`);
      return;
    }

    // 3. LLM 分析
    const riskPerTrade = config.strategy.risk_per_trade;
    logger.info(`[交易管理器] ${this.symbol} - 正在请求 LLM 分析...`);

    const signal = await this.llmService.analyzeMarket(
      this.symbol,
      candles,
      equity,
      riskPerTrade
    );

    logger.info(
      `[交易管理器] ${this.symbol} - LLM 决策: ${signal.decision} (${signal.reason})`
    );

    if (signal.decision === "APPROVE") {
      // 4. 执行逻辑
      const currentPrice = await this.marketData.getCurrentPrice();
      const plan = this.executor.generateTradePlan(
        signal,
        currentPrice,
        equity,
        this.symbol
      );

      if (plan) {
        logger.info(
          `[交易管理器] ${this.symbol} - 交易计划已生成: ${plan.action} ${
            plan.quantity
          } @ ${plan.entryOrder.price || "市价"}`
        );

        const orders = await this.executor.executeTradePlan(plan);
        this.activeOrders.push(...orders);

        const entryOrder = orders[0];
        // 如果是挂单（Open/New），切换到 PENDING_ENTRY
        if (
          entryOrder &&
          (entryOrder.status === "open" || entryOrder.status === "new")
        ) {
          this.state = TradeState.PENDING_ENTRY;
          this.pendingEntryOrder = entryOrder;
          this.pendingTradePlan = plan;
          logger.info(
            `[交易管理器] ${this.symbol} - 进入 PENDING_ENTRY 状态，等待突破单成交...`
          );
        } else {
          // 已经成交（市价单），理论上应该进入 MANAGING
          // 但目前简化处理，暂不改变状态或设为 SEARCHING (如果不持仓)
          // 实际逻辑中这里应该去监控仓位
          // this.state = TradeState.MANAGING;
        }
      } else {
        logger.warn(`[交易管理器] ${this.symbol} - 无法生成有效的交易计划。`);
      }
    }
  }

  private async processPendingEntry() {
    if (!this.pendingEntryOrder || !this.pendingTradePlan) {
      logger.warn(
        `[交易管理器] ${this.symbol} - 处于 PENDING_ENTRY 状态但无订单信息，重置为 SEARCHING`
      );
      this.state = TradeState.SEARCHING;
      return;
    }

    logger.info(
      `[交易管理器] ${this.symbol} - 检查挂单状态: ${this.pendingEntryOrder.id}`
    );

    try {
      // 1. 获取最新订单状态
      const order = await this.exchangeManager
        .getExchange()
        .fetchOrder(this.pendingEntryOrder.id, this.symbol);

      // 更新本地状态
      this.pendingEntryOrder = order;

      // 2. 处理不同状态
      if (order.status === "closed") {
        logger.info(
          `[交易管理器] ${this.symbol} - 突破单已成交！正在下达止盈止损...`
        );

        // 下达 TP/SL
        // 注意：这里需要检查是否是对冲模式，之前在 executor 里有逻辑，但这里我们无法直接访问 executor 内部的 isHedgeMode 状态。
        // 最好的方式是让 executor 处理。
        // 但 placeRiskOrders 需要 plan。我们有 pendingTradePlan。
        // 我们假设默认情况或重新检测模式。

        // 为了稳健，再次检查模式
        let isHedgeMode = false;
        if (this.exchangeManager.getExchange().id === "bitget") {
          try {
            const mode: any = await this.exchangeManager
              .getExchange()
              .fetchPositionMode(this.symbol);
            isHedgeMode = mode.hedged;
          } catch (e) {
            logger.warn(`[交易管理器] 获取持仓模式失败: ${e}`);
          }
        }

        await this.executor.placeRiskOrders(this.pendingTradePlan, isHedgeMode);

        // 切换到管理状态
        this.state = TradeState.MANAGING;
        this.pendingEntryOrder = null;
        this.pendingTradePlan = null;
        return;
      }

      if (
        order.status === "canceled" ||
        order.status === "rejected" ||
        order.status === "expired"
      ) {
        logger.info(
          `[交易管理器] ${this.symbol} - 突破单已取消/拒绝/过期。重置为 SEARCHING。`
        );
        this.state = TradeState.SEARCHING;
        this.pendingEntryOrder = null;
        this.pendingTradePlan = null;
        return;
      }

      if (order.status === "open" || order.status === "new") {
        logger.info(
          `[交易管理器] ${this.symbol} - 订单仍挂单中。请求 LLM 重新评估...`
        );

        // 获取最新 K 线
        const candles = await this.marketData.getConfirmedCandles(
          config.strategy.timeframe,
          config.strategy.lookback_candles
        );

        const decision = await this.llmService.analyzePendingOrder(
          this.symbol,
          candles,
          {
            action: this.pendingTradePlan.action,
            entryPrice:
              this.pendingTradePlan.entryOrder.price ||
              this.pendingTradePlan.entryOrder.stopPrice ||
              0,
            reason: this.pendingTradePlan.reason,
          }
        );

        logger.info(
          `[交易管理器] ${this.symbol} - LLM 对挂单的决策: ${decision.decision} (${decision.reason})`
        );

        if (decision.decision === "CANCEL") {
          logger.info(`[交易管理器] ${this.symbol} - 正在取消挂单...`);
          await this.exchangeManager
            .getExchange()
            .cancelOrder(order.id, this.symbol);
          this.state = TradeState.SEARCHING;
          this.pendingEntryOrder = null;
          this.pendingTradePlan = null;
        } else {
          logger.info(
            `[交易管理器] ${this.symbol} - 保持挂单，等待下一根 K 线。`
          );
        }
      }
    } catch (error: any) {
      logger.error(
        `[交易管理器] ${this.symbol} - 处理挂单出错: ${error.message}`
      );
      // 不要急着重置状态，以免因网络波动丢失订单追踪
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
