import { config } from "./config/config";
import { ExchangeManager } from "./market/exchange-manager";
import { createLLMService } from "./llm/llm-factory";
import { logger } from "./utils/logger";
import { TradeManager } from "./trade-manager";

async function main() {
  logger.info("正在启动 LLM-PriceAction-Bot...");
  logger.info("--------------------------------");

  try {
    // 1. 验证配置
    logger.info(`已加载配置:`);
    logger.info(
      `- 交易所: ${config.exchange.id} (沙盒模式: ${config.exchange.isSandbox})`
    );
    logger.info(
      `- 策略: ${config.strategy.timeframes.trading.interval} 时间框架 (MTF)`
    );
    logger.info(`- LLM: ${config.llm.provider} (${config.llm.model})`);
    logger.info(`- K线图像分析: ${config.llm.visionEnabled ? "启用" : "禁用"}`);
    logger.info("--------------------------------");

    // 2. 初始化交易所管理器
    const exchangeManager = new ExchangeManager();
    const llmService = createLLMService();

    // 3. 测试连接
    await exchangeManager.testConnection();

    const isLlmConnected = await llmService.testConnection();
    if (!isLlmConnected) {
      throw new Error("无法连接到 LLM 服务");
    }

    if (config.llm.visionEnabled) {
      await llmService.validateVisionCapability();
    }

    logger.info("--------------------------------");
    logger.important("系统初始化检查完成。正在启动交易循环...");

    // 4. 启动交易管理器
    const activeSymbols = config.symbols.active;

    if (activeSymbols.length === 0) {
      logger.warn("config.toml 中未配置活跃交易对");
      return;
    }

    const managers = activeSymbols.map(
      symbol => new TradeManager(symbol, exchangeManager, llmService)
    );

    // 并行运行所有循环
    // 我们在 TradeManager 内部捕获单个循环错误，因此 Promise.all 理论上应该永远运行。
    await Promise.all(managers.map(m => m.startLoop()));
  } catch (error) {
    logger.error("初始化过程中发生致命错误:", error);
    process.exit(1);
  }
}

main();
