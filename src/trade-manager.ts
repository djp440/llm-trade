import { MarketDataManager } from "./market/manager";
import { LLMService } from "./llm/llm-service";
import { TradeExecutor } from "./executor/trade-executor";
import { ExchangeManager } from "./market/exchange-manager";
import { config } from "./config/config";
import { logger } from "./utils/logger";
import { TradePlan } from "./types";
import { Order } from "ccxt";
import { recordEquityPointAndRenderChart } from "./utils/equity-report";

enum TradeState {
  SEARCHING = "SEARCHING",
  PENDING_ENTRY = "PENDING_ENTRY",
  EXECUTING = "EXECUTING",
  MANAGING = "MANAGING",
}

export class TradeManager {
  private marketData: MarketDataManager;
  private executor: TradeExecutor;
  private isRunning: boolean = false;
  private state: TradeState = TradeState.SEARCHING;
  private activeOrders: Order[] = [];
  private pendingTradePlan: TradePlan | null = null;
  private pendingEntryOrder: Order | null = null;
  private hasSeenOpenPosition: boolean = false;

  constructor(
    private symbol: string,
    private exchangeManager: ExchangeManager,
    private llmService: LLMService
  ) {
    this.marketData = new MarketDataManager(exchangeManager, symbol);
    this.executor = new TradeExecutor(exchangeManager);
  }

  public async startLoop() {
    this.isRunning = true;
    logger.info(`[交易管理器] 正在启动 ${this.symbol} 的循环`);

    // 启动前先检查账户状态，避免重复开仓或忽略已有持仓
    await this.initializeState();

    while (this.isRunning) {
      try {
        if (this.state === TradeState.MANAGING) {
          await this.processManaging();
          await this.sleep(5000);
          continue;
        }

        const timeframe = config.strategy.timeframes.trading.interval;
        const msPerCandle = this.marketData.parseTimeframeToMs(timeframe);
        const closeBufferMs = 5000;

        const nowMs = await this.getReferenceTimeMs();
        const nextCloseMs = Math.ceil(nowMs / msPerCandle) * msPerCandle;
        const targetWakeMs = nextCloseMs + closeBufferMs;
        const waitTime = Math.max(0, targetWakeMs - nowMs);

        logger.info(
          `[交易管理器] ${this.symbol} 正在休眠 ${Math.round(
            waitTime / 1000
          )}秒，等待 K 线收盘: ${new Date(
            nextCloseMs
          ).toISOString()} (缓冲 ${Math.round(closeBufferMs / 1000)} 秒)`
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

  private async initializeState() {
    logger.info(`[交易管理器] 正在初始化状态...`);

    try {
      // 1. 检查是否有持仓
      const positionSize = await this.getPositionSize(this.symbol);
      if (Math.abs(positionSize) > 0) {
        logger.important(
          `[交易管理器] 初始化检测到现有持仓 (${positionSize})，恢复为 MANAGING 状态。`
        );
        this.state = TradeState.MANAGING;
        this.hasSeenOpenPosition = true;
        return;
      }

      // 2. 检查是否有挂单
      // 由于内存中丢失了 TradePlan，我们无法继续智能管理这些挂单（缺少止损/止盈/理由等上下文）。
      // 为了安全起见，建议取消这些残留挂单，从干净的状态开始。
      const exchange: any = this.exchangeManager.getExchange();
      try {
        const openOrders = await exchange.fetchOpenOrders(this.symbol);
        if (openOrders.length > 0) {
          logger.warn(
            `[交易管理器] 初始化检测到 ${openOrders.length} 个现有挂单。由于上下文丢失，将取消这些挂单以确保干净启动。`
          );
          for (const order of openOrders) {
            try {
              // 尝试作为触发单取消（如果是止损/止盈单）或普通单取消
              await exchange.cancelOrder(order.id, this.symbol);
              logger.info(`[交易管理器] 已取消残留挂单: ${order.id}`);
            } catch (cancelError: any) {
              // 某些交易所可能需要特定参数来取消止损单
              try {
                if (exchange.id === "bitget") {
                  await exchange.cancelOrder(order.id, this.symbol, {
                    trigger: true,
                    planType: "normal_plan",
                  });
                  logger.info(`[交易管理器] 已取消残留触发挂单: ${order.id}`);
                } else {
                  logger.error(
                    `[交易管理器] 取消挂单 ${order.id} 失败: ${cancelError.message}`
                  );
                }
              } catch (retryError: any) {
                logger.error(
                  `[交易管理器] 取消挂单 ${order.id} 最终失败: ${retryError.message}`
                );
              }
            }
          }
        }
      } catch (e: any) {
        logger.warn(`[交易管理器] 检查初始挂单失败 (可忽略): ${e.message}`);
      }

      logger.info(
        `[交易管理器] 初始状态检查完成: 无持仓，准备开始 SEARCHING。`
      );
      this.state = TradeState.SEARCHING;
    } catch (error: any) {
      logger.error(`[交易管理器] 初始化状态检查出错: ${error.message}`);
      // 出错时默认进入搜索模式，或者您可以选择抛出异常停止程序
      this.state = TradeState.SEARCHING;
    }
  }

  private async processSignalSearch() {
    logger.info(`[交易管理器] ${this.symbol} - 开始信号搜索阶段`);

    // 1. 获取数据 (Multi-Timeframe)
    const timeframes = config.strategy.timeframes;

    // 获取确认关闭的 K 线
    const nowMs = await this.getReferenceTimeMs();

    // 并行获取三个时间框架的数据
    // 确保至少获取25根以计算 EMA(20)
    const [tradingCandles, contextCandles, trendCandles] = await Promise.all([
      this.marketData.getConfirmedCandles(
        timeframes.trading.interval,
        Math.max(timeframes.trading.limit, 25),
        nowMs
      ),
      this.marketData.getConfirmedCandles(
        timeframes.context.interval,
        Math.max(timeframes.context.limit, 25),
        nowMs
      ),
      this.marketData.getConfirmedCandles(
        timeframes.trend.interval,
        Math.max(timeframes.trend.limit, 25),
        nowMs
      ),
    ]);

    const lastCandle = tradingCandles[tradingCandles.length - 1];
    const msPerCandle = this.marketData.parseTimeframeToMs(
      timeframes.trading.interval
    );
    const candleCloseMs = lastCandle.timestamp + msPerCandle;

    logger.info(
      `[交易管理器] ${this.symbol} - 分析 K 线收盘时间: ${new Date(
        candleCloseMs
      ).toISOString()}`
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
    logger.llm(`[交易管理器] ${this.symbol} - 正在请求 LLM 分析...`);

    const signal = await this.llmService.analyzeMarket(
      this.symbol,
      tradingCandles,
      contextCandles,
      trendCandles,
      equity,
      riskPerTrade
    );

    logger.llm(
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
        logger.important(
          `[交易管理器] ${this.symbol} - 交易计划已生成: ${plan.action} ${
            plan.quantity
          } @ ${plan.entryOrder.price || "市价"}`
        );

        const orders = await this.executor.executeTradePlan(plan);
        this.activeOrders.push(...orders);

        const entryOrder = orders[0];
        const isPendingBreakoutPlan =
          plan.entryOrder.type === "stop_market" ||
          plan.entryOrder.type === "stop";

        if (entryOrder && isPendingBreakoutPlan) {
          this.state = TradeState.PENDING_ENTRY;
          this.pendingEntryOrder = entryOrder;
          this.pendingTradePlan = plan;
          logger.important(
            `[交易管理器] ${this.symbol} - 进入 PENDING_ENTRY 状态，等待突破单成交...`
          );
        } else {
          if (entryOrder && entryOrder.status === "closed") {
            this.state = TradeState.MANAGING;
            this.hasSeenOpenPosition = false;
            logger.position(
              `[交易管理器] ${this.symbol} - 已进场，进入 MANAGING 状态，开始监控仓位...`
            );
          } else {
            this.state = TradeState.SEARCHING;
          }
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
      const exchange: any = this.exchangeManager.getExchange();
      const isTriggerOrder =
        this.pendingTradePlan.entryOrder.type === "stop_market" ||
        this.pendingTradePlan.entryOrder.type === "stop";

      const orderId = this.pendingEntryOrder.id;

      let order: Order | null = null;

      try {
        order = await exchange.fetchOrder(orderId, this.symbol, {
          ...(isTriggerOrder ? { trigger: true, planType: "normal_plan" } : {}),
        });
      } catch {
        try {
          if (isTriggerOrder) {
            const open: Order[] = await exchange.fetchOpenOrders(
              this.symbol,
              undefined,
              undefined,
              { trigger: true, planType: "normal_plan" }
            );
            const matched = open.find(o => String(o.id) === String(orderId));
            if (matched) order = matched;
          }
        } catch {
          order = null;
        }

        if (!order) {
          try {
            order = await exchange.fetchOrder(orderId, this.symbol);
          } catch (e: any) {
            logger.warn(
              `[交易管理器] ${
                this.symbol
              } - 获取订单详情失败 (可能已成交归档): ${e?.message || String(e)}`
            );
          }
        }
      }

      if (!order) {
        // 无法找到订单，检查是否已有持仓
        const positionSize = await this.getPositionSize(this.symbol);
        if (Math.abs(positionSize) > 0) {
          logger.tradeOpen(
            `[交易管理器] ${this.symbol} - 无法获取订单信息但检测到持仓，确认挂单已成交！`
          );
          this.state = TradeState.MANAGING;
          this.hasSeenOpenPosition = true;
          this.pendingEntryOrder = null;
          this.pendingTradePlan = null;
          return;
        }

        throw new Error("无法获取挂单状态且无持仓");
      }

      // 更新本地状态
      this.pendingEntryOrder = order;

      // 2. 处理不同状态
      if (order.status === "closed") {
        logger.tradeOpen(
          `[交易管理器] ${this.symbol} - 突破单已成交 (Closed/Executed)！`
        );

        // 注意: TP/SL 已在下单时通过 params (stopLoss/takeProfit) 附加。
        // 因此不需要在此处单独下达风险订单。
        // 我们只需确认仓位状态（可选），然后切换到管理状态。

        // 切换到管理状态
        this.state = TradeState.MANAGING;
        this.hasSeenOpenPosition = false;
        this.pendingEntryOrder = null;
        this.pendingTradePlan = null;
        return;
      }

      if (
        order.status === "canceled" ||
        order.status === "rejected" ||
        order.status === "expired"
      ) {
        logger.important(
          `[交易管理器] ${this.symbol} - 突破单已取消/拒绝/过期。重置为 SEARCHING。`
        );
        this.state = TradeState.SEARCHING;
        this.pendingEntryOrder = null;
        this.pendingTradePlan = null;
        return;
      }

      if (order.status === "open" || order.status === "new") {
        logger.llm(
          `[交易管理器] ${this.symbol} - 订单仍挂单中。请求 LLM 重新评估...`
        );

        const balance = await exchange.fetchBalance();
        const equity = (balance as any).total["USDT"] || 0;
        if (!equity) {
          logger.warn(
            `[交易管理器] ${this.symbol} - 无法获取权益，跳过本轮重新评估。`
          );
          return;
        }

        // 获取最新 K 线 (Multi-Timeframe)
        const timeframes = config.strategy.timeframes;
        const nowMs = await this.getReferenceTimeMs();

        const [tradingCandles, contextCandles, trendCandles] =
          await Promise.all([
            this.marketData.getConfirmedCandles(
              timeframes.trading.interval,
              Math.max(timeframes.trading.limit, 25),
              nowMs
            ),
            this.marketData.getConfirmedCandles(
              timeframes.context.interval,
              Math.max(timeframes.context.limit, 25),
              nowMs
            ),
            this.marketData.getConfirmedCandles(
              timeframes.trend.interval,
              Math.max(timeframes.trend.limit, 25),
              nowMs
            ),
          ]);

        const decision = await this.llmService.analyzePendingOrder(
          this.symbol,
          tradingCandles,
          contextCandles,
          trendCandles,
          equity,
          config.strategy.risk_per_trade,
          {
            action: this.pendingTradePlan.action,
            entryPrice:
              this.pendingTradePlan.entryOrder.price ||
              this.pendingTradePlan.entryOrder.stopPrice ||
              0,
            reason: this.pendingTradePlan.reason,
          }
        );

        logger.llm(
          `[交易管理器] ${this.symbol} - LLM 对挂单的决策: ${decision.decision} (${decision.reason})`
        );

        if (decision.decision === "CANCEL") {
          logger.important(`[交易管理器] ${this.symbol} - 正在取消挂单...`);
          try {
            if (isTriggerOrder) {
              await exchange.cancelOrder(order.id, this.symbol, {
                trigger: true,
                planType: "normal_plan",
              });
            } else {
              await exchange.cancelOrder(order.id, this.symbol);
            }
            this.state = TradeState.SEARCHING;
            this.pendingEntryOrder = null;
            this.pendingTradePlan = null;
          } catch (e: any) {
            logger.error(
              `[交易管理器] ${this.symbol} - 撤单失败，将继续追踪挂单: ${
                e?.message || String(e)
              }`
            );
          }
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

  private async getReferenceTimeMs(): Promise<number> {
    try {
      const serverTime = await this.exchangeManager.getExchange().fetchTime();
      if (typeof serverTime === "number" && Number.isFinite(serverTime)) {
        return serverTime;
      }
      return Date.now();
    } catch {
      return Date.now();
    }
  }

  private async processManaging() {
    try {
      const positionSize = await this.getPositionSize(this.symbol);
      const isOpen = Math.abs(positionSize) > 0;

      if (isOpen) {
        if (!this.hasSeenOpenPosition) {
          logger.position(
            `[交易管理器] ${this.symbol} - 检测到持仓已建立，开始等待止盈/止损完成...`
          );
        }
        this.hasSeenOpenPosition = true;
        return;
      }

      if (this.hasSeenOpenPosition) {
        logger.tradeClose(
          `[交易管理器] ${this.symbol} - 持仓已完全关闭，记录账户权益并生成折线图...`
        );
        await this.recordAccountEquitySnapshot();
      }

      this.hasSeenOpenPosition = false;
      this.activeOrders = [];
      this.state = TradeState.SEARCHING;
    } catch (error: any) {
      logger.error(
        `[交易管理器] ${this.symbol} - 管理仓位阶段出错: ${
          error?.message || String(error)
        }`
      );
    }
  }

  private async getPositionSize(symbol: string): Promise<number> {
    const exchange: any = this.exchangeManager.getExchange();

    if (typeof exchange.fetchPositions === "function") {
      try {
        const positions = await exchange.fetchPositions([symbol]);
        const p = Array.isArray(positions)
          ? positions.find((x: any) => x?.symbol === symbol)
          : null;
        return this.extractPositionSize(p);
      } catch {
        try {
          const positions = await exchange.fetchPositions();
          const p = Array.isArray(positions)
            ? positions.find((x: any) => x?.symbol === symbol)
            : null;
          return this.extractPositionSize(p);
        } catch {
          return 0;
        }
      }
    }

    if (typeof exchange.fetchPosition === "function") {
      try {
        const p = await exchange.fetchPosition(symbol);
        return this.extractPositionSize(p);
      } catch {
        return 0;
      }
    }

    return 0;
  }

  private extractPositionSize(position: any): number {
    if (!position) return 0;

    const candidates = [
      position.contracts,
      position.contractSize,
      position.size,
      position.amount,
      position?.info?.total,
      position?.info?.available,
      position?.info?.pos,
      position?.info?.position,
      position?.info?.positionAmt,
    ];

    for (const c of candidates) {
      const v = typeof c === "string" ? Number(c) : (c as number);
      if (Number.isFinite(v) && v !== 0) return v;
    }
    return 0;
  }

  private async recordAccountEquitySnapshot(): Promise<void> {
    try {
      const timestampMs = await this.getReferenceTimeMs();
      const balance = await this.exchangeManager.getExchange().fetchBalance();
      const equityUsdt = this.extractUsdtEquity(balance);

      await recordEquityPointAndRenderChart({
        timestampMs,
        equityUsdt,
      });

      logger.info(
        `[交易管理器] ${this.symbol} - 权益快照已记录: ${equityUsdt.toFixed(
          2
        )} USDT`
      );
    } catch (error: any) {
      logger.error(
        `[交易管理器] ${this.symbol} - 记录权益快照失败: ${
          error?.message || String(error)
        }`
      );
    }
  }

  private extractUsdtEquity(balance: any): number {
    const tryPick = (v: any) => {
      const n = typeof v === "string" ? Number(v) : (v as number);
      return Number.isFinite(n) ? n : 0;
    };

    const total = balance?.total;
    const direct =
      tryPick(total?.USDT) ||
      tryPick(total?.usdt) ||
      tryPick(total?.["USDT"]) ||
      tryPick(total?.["usdt"]);
    if (direct) return direct;

    const usdtBucket = balance?.USDT || balance?.usdt;
    const bucketTotal = tryPick(usdtBucket?.total);
    if (bucketTotal) return bucketTotal;

    const free =
      tryPick(balance?.free?.USDT) ||
      tryPick(balance?.free?.usdt) ||
      tryPick(usdtBucket?.free);
    const used =
      tryPick(balance?.used?.USDT) ||
      tryPick(balance?.used?.usdt) ||
      tryPick(usdtBucket?.used);
    const sum = free + used;
    return Number.isFinite(sum) ? sum : 0;
  }
}
