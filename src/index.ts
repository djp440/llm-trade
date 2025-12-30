import { config } from "./config/config";
import { ExchangeManager } from "./market/exchange-manager";
import { logger } from "./utils/logger";
import { TradeManager } from "./trade-manager";

async function main() {
  logger.info("Starting LLM-PriceAction-Bot...");
  logger.info("--------------------------------");

  try {
    // 1. Validate Config
    logger.info(`Loaded Config:`);
    logger.info(
      `- Exchange: ${config.exchange.id} (Sandbox: ${config.exchange.isSandbox})`
    );
    logger.info(`- Strategy: ${config.strategy.timeframe} timeframe`);
    logger.info(`- LLM: ${config.llm.provider} (${config.llm.model})`);
    logger.info("--------------------------------");

    // 2. Initialize Exchange Manager
    const exchangeManager = new ExchangeManager();

    // 3. Test Connection
    await exchangeManager.testConnection();

    logger.info("--------------------------------");
    logger.info(
      "System initialization check complete. Starting Trading Loops..."
    );

    // 4. Start Trading Managers
    const activeSymbols = config.symbols.active;

    if (activeSymbols.length === 0) {
      logger.warn("No active symbols configured in config.toml");
      return;
    }

    const managers = activeSymbols.map(
      symbol => new TradeManager(symbol, exchangeManager)
    );

    // Run all loops in parallel
    // We catch individual loop errors inside TradeManager, so this Promise.all should theoretically run forever.
    await Promise.all(managers.map(m => m.startLoop()));
  } catch (error) {
    logger.error("Fatal Error during initialization:", error);
    process.exit(1);
  }
}

main();
