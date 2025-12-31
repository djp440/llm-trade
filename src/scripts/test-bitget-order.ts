// Force sandbox mode for safety
process.env.IS_SANDBOX = "true";

import { ExchangeManager } from "../market/exchange-manager";
import { TradeExecutor } from "../executor/trade-executor";
import { TradeSignal } from "../types";
import { logger } from "../utils/logger";

async function main() {
  try {
    logger.info("🚀 开始运行 Bitget 模拟盘下单测试脚本...");

    // 1. 初始化交易所管理器
    const exchangeManager = new ExchangeManager();
    // 测试连接
    await exchangeManager.testConnection();

    const exchange = exchangeManager.getExchange();
    // Bitget 永续合约在 CCXT 中通常表示为 BTC/USDT:USDT 以明确区分现货
    const symbol = "BTC/USDT:USDT";

    logger.info(`正在获取 ${symbol} 的市场数据...`);

    // 2. 获取当前价格
    const ticker = await exchange.fetchTicker(symbol);
    const currentPrice = ticker.last;

    if (!currentPrice) {
      throw new Error("无法获取当前价格");
    }
    logger.info(`当前 ${symbol} 价格: ${currentPrice}`);

    // 3. 获取账户权益 (用于计算仓位)
    const balance = await exchange.fetchBalance();
    const equity = (balance.total as any)["USDT"] || 0;

    logger.info(`账户 USDT 权益: ${equity}`);

    if (equity <= 0) {
      logger.warn(
        "⚠️ 账户余额为 0，下单可能会失败 (除非允许透支或仅仅是计算测试)"
      );
    }

    // 4. 构建模拟交易信号 (做多)
    // 目标: 市价买入
    const stopLoss = currentPrice * 0.99; // 1% 止损
    const takeProfit = currentPrice * 1.02; // 2% 止盈

    logger.info("构建测试信号 (做多)...");
    const signal: TradeSignal = {
      decision: "APPROVE",
      reason: "Test Script Manual Execution",
      action: "BUY",
      orderType: "MARKET",
      entryPrice: currentPrice, // 设置为当前价格以触发市价单逻辑
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      quantity: 0, // 将由 executor 计算
    };

    // 5. 初始化执行器
    const executor = new TradeExecutor(exchangeManager);

    // 6. 生成交易计划
    logger.info("正在生成交易计划...");
    const plan = executor.generateTradePlan(
      signal,
      currentPrice,
      equity,
      symbol
    );

    if (!plan) {
      logger.error("❌ 交易计划生成失败 (可能是余额不足或风险控制拒绝)");
      return;
    }

    logger.info("✅ 交易计划生成成功:");
    console.log(JSON.stringify(plan, null, 2));

    // 7. 执行交易计划
    logger.info("⚡ 正在执行交易计划 (实际下单)...");

    // 提示用户确认 (模拟脚本中我们直接执行，但在实际 CLI 工具中通常会暂停)
    const orders = await executor.executeTradePlan(plan);

    logger.info(`✅ 执行完成! 共创建 ${orders.length} 个订单`);
    orders.forEach((o, index) => {
      logger.info(
        `[订单 ${index + 1}] ID: ${o.id} | 类型: ${o.type} | 方向: ${
          o.side
        } | 状态: ${o.status}`
      );
    });
  } catch (error: any) {
    logger.error("❌ 测试脚本运行失败:", error);
    if (error.message.includes("40017")) {
      logger.error(
        "提示: 错误 40017 通常意味着 API Key 权限不足或配置错误 (例如没有交易权限)。"
      );
    }
  }
}

main();
