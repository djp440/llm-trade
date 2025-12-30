import { ExchangeManager } from "../src/market/exchange-manager";
import { logger } from "../src/utils/logger";
import { config } from "../src/config/config";

async function debugStopOrder() {
  const manager = new ExchangeManager();
  const exchange = manager.getExchange();
  exchange.verbose = true;

  // 设置市场
  logger.info("正在加载市场...");
  const markets = await exchange.loadMarkets();
  const ethMarkets = Object.values(markets).filter(
    m => m && m.base === "ETH" && m.quote === "USDT" && m.swap
  );
  const targetMarket = ethMarkets[0];
  if (!targetMarket) return;
  const symbol = targetMarket.symbol;

  logger.info(`正在使用交易对: ${symbol}`);

  const currentPrice = 3000;
  const stopPrice = 3100; // 在当前价格之上触发 (买入止损)
  const amount = 0.01;

  // 案例 1: CCXT 标准 stop_market
  try {
    logger.info("案例 1: stop_market");
    const order = await exchange.createOrder(
      symbol,
      "stop_market",
      "buy",
      amount,
      undefined,
      {
        stopPrice: stopPrice,
        tradeSide: "Open", // 根据之前的修复添加
      }
    );
    logger.info(`案例 1 成功: ${order.id}`);
    // await exchange.cancelOrder(order.id, symbol); // 可能是计划委托，取消方式不同？
  } catch (e: any) {
    logger.error(`案例 1 失败: ${e.message}`);
  }

  // 案例 2: 带 triggerPrice 的市价单
  try {
    logger.info("案例 2: 带 triggerPrice 的市价单");
    const order = await exchange.createOrder(
      symbol,
      "market",
      "buy",
      amount,
      undefined,
      {
        triggerPrice: stopPrice,
        tradeSide: "Open",
      }
    );
    logger.info(`案例 2 成功: ${order.id}`);
  } catch (e: any) {
    logger.error(`案例 2 失败: ${e.message}`);
  }
}

debugStopOrder();
