import { BacktestEngine } from "../backtest/engine";
import { BacktestConfig } from "../backtest/types";
import { logger } from "../utils/logger";
import { ReportGenerator } from "../backtest/report-generator";
import { AlBrooksLLMStrategy } from "../llm/strategies/al-brooks-strategy";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  try {
    // You can point to the new Binance CSV file here
    const csvPath = path.join(__dirname, "../../src/data/test.csv");
    // Or fallback to default if it doesn't exist
    // const csvPath = "f:\\project\\llm-trade\\data\\backtest_data.csv";

    // Use default timeframes from the strategy, or override here
    const defaultStrategyConfig = new AlBrooksLLMStrategy().getStrategyConfig();

    const config: BacktestConfig = {
      csvPath: csvPath,
      initialBalance: 10000,
      symbol: "SUI/USDT",
      timeframes: {
        trading: defaultStrategyConfig.timeframes.trading.interval, // e.g. "5m"
        context: defaultStrategyConfig.timeframes.context.interval, // e.g. "1h"
        trend: defaultStrategyConfig.timeframes.trend.interval, // e.g. "4h"
      },
      enableImageAnalysis: false, // Disable image analysis

      // Optional: Limit number of candles for testing
      // Useful for quick verification or saving costs. Set BACKTEST_LIMIT in .env or here.
      limit: process.env.BACKTEST_LIMIT
        ? parseInt(process.env.BACKTEST_LIMIT)
        : 900, // Default to undefined (no limit, run all data)

      // Optional: Configure a dedicated LLM for backtesting
      // Uses environment variables starting with BACKTEST_LLM_
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
        : undefined,

      // Optional: Select strategy type (default: "al-brooks")
      strategyType: "al-brooks",
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
