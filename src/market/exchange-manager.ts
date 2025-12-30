import ccxt, { Exchange } from "ccxt";
import { config } from "../config/config";
import { logger } from "../utils/logger";

export class ExchangeManager {
  private exchange: Exchange;

  constructor() {
    const exchangeId = config.exchange.id;
    const exchangeClass = (ccxt as any)[exchangeId];

    if (!exchangeClass) {
      throw new Error(`Exchange ${exchangeId} not found in CCXT`);
    }

    this.exchange = new exchangeClass({
      apiKey: config.exchange.apiKey,
      secret: config.exchange.apiSecret,
      password: config.exchange.apiPassword,
      enableRateLimit: true,
      options: {
        defaultType: "swap", // Default to swap/futures for crypto trading usually
      },
    });

    if (config.exchange.isSandbox) {
      this.exchange.setSandboxMode(true);
      console.log(`[ExchangeManager] Sandbox mode enabled for ${exchangeId}`);
    }
  }

  public getExchange(): Exchange {
    return this.exchange;
  }

  public async testConnection(): Promise<void> {
    try {
      logger.info(
        `[ExchangeManager] Testing connection to ${this.exchange.id}...`
      );

      // Fetch balance is a good way to test auth
      const balance = await this.exchange.fetchBalance();

      logger.info(`[ExchangeManager] Connection successful!`);
      logger.info(`[ExchangeManager] Account Balance (Total):`);

      // Print non-zero balances
      let hasBalance = false;
      for (const [currency, amount] of Object.entries(balance.total)) {
        if (amount && amount > 0) {
          logger.info(`  - ${currency}: ${amount}`);
          hasBalance = true;
        }
      }

      if (!hasBalance) {
        logger.info(`  (No non-zero balances found)`);
      }
    } catch (error: any) {
      logger.error(`[ExchangeManager] Connection failed:`, error.message);
      throw error;
    }
  }
}
