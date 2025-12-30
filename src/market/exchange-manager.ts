import ccxt, { Exchange } from "ccxt";
import { config } from "../config/config";
import { logger } from "../utils/logger";

export class ExchangeManager {
  private exchange: Exchange;

  constructor() {
    const exchangeId = config.exchange.id;
    const exchangeClass = (ccxt as any)[exchangeId];

    if (!exchangeClass) {
      throw new Error(`在 CCXT 中未找到交易所 ${exchangeId}`);
    }

    this.exchange = new exchangeClass({
      apiKey: config.exchange.apiKey,
      secret: config.exchange.apiSecret,
      password: config.exchange.apiPassword,
      enableRateLimit: true,
      options: {
        defaultType: "swap", // 默认进行永续合约交易
      },
    });

    if (config.exchange.isSandbox) {
      this.exchange.setSandboxMode(true);
      console.log(`[交易所管理器] ${exchangeId} 已启用沙盒模式`);
    }
  }

  public getExchange(): Exchange {
    return this.exchange;
  }

  public async testConnection(): Promise<void> {
    try {
      logger.info(`[交易所管理器] 正在测试与 ${this.exchange.id} 的连接...`);

      // 获取余额是测试身份验证的好方法
      const balance = await this.exchange.fetchBalance();

      logger.info(`[交易所管理器] 连接成功！`);
      logger.info(`[交易所管理器] 账户余额 (总计):`);

      // 打印非零余额
      let hasBalance = false;
      for (const [currency, amount] of Object.entries(balance.total)) {
        if (amount && (amount as number) > 0) {
          logger.info(`  - ${currency}: ${amount}`);
          hasBalance = true;
        }
      }

      if (!hasBalance) {
        logger.info(`  (未发现非零余额)`);
      }
    } catch (error: any) {
      logger.error(`[交易所管理器] 连接失败:`, error.message);
      throw error;
    }
  }
}
