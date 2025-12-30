import { ExchangeManager } from "../src/market/exchange-manager";
import { logger } from "../src/utils/logger";
import { config } from "../src/config/config";

async function debugOrder() {
  const manager = new ExchangeManager();
  // await manager.initialize();
  const exchange = manager.getExchange();
  exchange.verbose = false; // 加载市场时禁用详细输出

  logger.info("正在加载市场...");
  const markets = await exchange.loadMarkets();

  // 查找 ETH 的市场 ID
  const ethMarkets = Object.values(markets).filter(
    m => m && m.base === "ETH" && m.quote === "USDT" && m.swap
  );
  logger.info("ETH 永续合约市场:");
  ethMarkets.forEach(m => {
    if (m) logger.info(`交易对: ${m.symbol}, ID: ${m.id}, 类型: ${m.type}`);
  });

  // 使用找到的第一个有效 ID
  const targetMarket = ethMarkets[0];
  if (!targetMarket) {
    logger.error("未找到 ETH 永续合约市场！");
    return;
  }

  const symbol = targetMarket.symbol; // 使用统一的交易对，CCXT 会处理映射
  logger.info(`正在使用交易对: ${symbol} (ID: ${targetMarket.id})`);

  exchange.verbose = true; // 下单时启用详细输出

  const price = parseFloat(exchange.priceToPrecision(symbol, 2000));
  const amount = 0.01;

  // 案例 1: 普通订单 (单向持仓风格)
  try {
    logger.info("案例 1: 普通限价买入 (无参数)");
    const order = await exchange.createOrder(
      symbol,
      "limit",
      "buy",
      amount,
      price,
      {}
    );
    logger.info(`案例 1 成功: ${order.id}`);
    await exchange.cancelOrder(order.id, symbol);
  } catch (e: any) {
    logger.error(`案例 1 失败: ${e.message}`);
  }

  // 案例 5: 单向持仓模式，tradeSide='Open'
  try {
    logger.info("案例 5: 限价买入，带 tradeSide='Open' (单向持仓模式)");
    const order = await exchange.createOrder(
      symbol,
      "limit",
      "buy",
      amount,
      price,
      { tradeSide: "Open" }
    );
    logger.info(`案例 5 成功: ${order.id}`);
    await exchange.cancelOrder(order.id, symbol);
  } catch (e: any) {
    logger.error(`案例 5 失败: ${e.message}`);
  }

  // 案例 6: 单向持仓模式，tradeSide='Open' 且 marginMode='crossed'
  try {
    logger.info(
      "案例 6: 限价买入，带 tradeSide='Open' 和 marginMode='crossed'"
    );
    const order = await exchange.createOrder(
      symbol,
      "limit",
      "buy",
      amount,
      price,
      { tradeSide: "Open", marginMode: "crossed" }
    );
    logger.info(`案例 6 成功: ${order.id}`);
    await exchange.cancelOrder(order.id, symbol);
  } catch (e: any) {
    logger.error(`案例 6 失败: ${e.message}`);
  }
}

debugOrder();
