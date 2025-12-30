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
    const equity = balance.total["USDT"] || 0;

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

        // 切换状态到 MANAGING (目前是简单实现)
        // 在完整系统中，我们会通过 WebSocket 跟踪此订单
        // 目前，我们只记录它并可能循环回来（或暂停）
        // this.state = TradeState.MANAGING;
      } else {
        logger.warn(`[交易管理器] ${this.symbol} - 无法生成有效的交易计划。`);
      }
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
