import { BacktestEngine } from "../backtest/engine";
import { BacktestConfig } from "../backtest/types";
import { logger } from "../utils/logger";
import { ReportGenerator } from "../backtest/report-generator";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  try {
    // You can point to the new Binance CSV file here
    const csvPath = path.join(__dirname, "../../src/data/test.csv");
    // Or fallback to default if it doesn't exist
    // const csvPath = "f:\\project\\llm-trade\\data\\backtest_data.csv";

    const config: BacktestConfig = {
      csvPath: csvPath,
      initialBalance: 10000,
      symbol: "SOL/USDT",
      timeframes: {
        trading: "1h",
        context: "4h",
        trend: "1d",
      },
      enableImageAnalysis: false, // Disable image analysis

      // Optional: Limit number of candles for testing
      // Useful for quick verification or saving costs. Set BACKTEST_LIMIT in .env or here.
      limit: process.env.BACKTEST_LIMIT
        ? parseInt(process.env.BACKTEST_LIMIT)
        : undefined, // Default to undefined (no limit, run all data)

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
