import { BacktestEngine } from "../backtest/engine";
import { BacktestConfig } from "../backtest/types";
import { logger } from "../utils/logger";
import { ReportGenerator } from "../backtest/report-generator";
import { ConfigLoader } from "../config/config"; // Import ConfigLoader
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  try {
    // Load config from config.toml
    const globalConfig = ConfigLoader.getInstance();

    // You can point to the new Binance CSV file here
    const csvPath = path.join(__dirname, "../../src/data/test.csv");
    // Or fallback to default if it doesn't exist
    // const csvPath = "f:\\project\\llm-trade\\data\\backtest_data.csv";

    // Use timeframes from config.toml
    const timeframes = globalConfig.strategy.timeframes;

    const config: BacktestConfig = {
      csvPath: csvPath,
      initialBalance: 10000,
      symbol: "SUI/USDT", // Keep SUI for now, or use globalConfig.symbols.active[0]
      timeframes: {
        trading: timeframes.trading.interval,
        context: timeframes.context.interval,
        trend: timeframes.trend.interval,
      },
      enableImageAnalysis: globalConfig.llm.visionEnabled,

      // Optional: Limit number of candles for testing
      limit: process.env.BACKTEST_LIMIT
        ? parseInt(process.env.BACKTEST_LIMIT)
        : 900,

      // Optional: Configure a dedicated LLM for backtesting
      llmConfig: process.env.BACKTEST_LLM_API_KEY
        ? {
            provider: "openrouter",
            apiKey: process.env.BACKTEST_LLM_API_KEY,
            baseUrl:
              process.env.BACKTEST_LLM_BASE_URL ||
              "https://openrouter.ai/api/v1",
            model: process.env.BACKTEST_LLM_MODEL || "google/gemma-3-27b-it",
            visionEnabled: false,
            identityRole: "trader",
            logInteractions: true,
          }
        : undefined, // If undefined, engine might use global config or defaults.
      // Ideally engine uses passed llmConfig OR falls back to global if we change engine.ts.
      // But engine.ts currently merges llmConfig.
      // If we want to use global LLM config when backtest env is not set:
      // llmConfig: process.env.BACKTEST_LLM_API_KEY ? ... : globalConfig.llm

      // Select strategy type from config
      strategyType: globalConfig.strategy.type,

      // Pass the full strategy config (including EMA params)
      strategyConfig: globalConfig.strategy,
    };

    const engine = new BacktestEngine(config);
    const reportPath = await engine.run();

    logger.info(`Backtest finished. Report path: ${reportPath}`);

    if (reportPath) {
      const htmlPath = reportPath.replace(".json", ".html");
      ReportGenerator.generateHTML(reportPath, htmlPath);
      logger.info("Backtest completed successfully!");
    } else {
      logger.error("Backtest failed to generate report.");
    }
  } catch (error) {
    logger.error("Backtest failed", error);
  }
}

main();
