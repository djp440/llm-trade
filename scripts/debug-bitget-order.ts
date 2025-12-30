import { ExchangeManager } from "../src/market/exchange-manager";
import { logger } from "../src/utils/logger";
import { config } from "../src/config/config";

async function debugOrder() {
  const manager = new ExchangeManager();
  // await manager.initialize();
  const exchange = manager.getExchange();
  exchange.verbose = false; // Disable verbose for market loading

  logger.info("Loading Markets...");
  const markets = await exchange.loadMarkets();

  // Find market IDs for ETH
  const ethMarkets = Object.values(markets).filter(
    m => m && m.base === "ETH" && m.quote === "USDT" && m.swap
  );
  logger.info("ETH Swap Markets:");
  ethMarkets.forEach(m => {
    if (m) logger.info(`Symbol: ${m.symbol}, ID: ${m.id}, Type: ${m.type}`);
  });

  // Use the first valid ID found
  const targetMarket = ethMarkets[0];
  if (!targetMarket) {
    logger.error("No ETH swap market found!");
    return;
  }

  const symbol = targetMarket.symbol; // Use the unified symbol, CCXT handles mapping
  logger.info(`Using Symbol: ${symbol} (ID: ${targetMarket.id})`);

  exchange.verbose = true; // Enable verbose for order

  const price = parseFloat(exchange.priceToPrecision(symbol, 2000));
  const amount = 0.01;

  // Case 1: Plain Order (One-Way style)
  try {
    logger.info("Case 1: Plain Limit Buy (No params)");
    const order = await exchange.createOrder(
      symbol,
      "limit",
      "buy",
      amount,
      price,
      {}
    );
    logger.info(`Case 1 Success: ${order.id}`);
    await exchange.cancelOrder(order.id, symbol);
  } catch (e: any) {
    logger.error(`Case 1 Failed: ${e.message}`);
  }

  // Case 5: One-Way Mode with tradeSide='Open'
  try {
    logger.info("Case 5: Limit Buy with tradeSide='Open' (One-Way Mode)");
    const order = await exchange.createOrder(
      symbol,
      "limit",
      "buy",
      amount,
      price,
      { tradeSide: "Open" }
    );
    logger.info(`Case 5 Success: ${order.id}`);
    await exchange.cancelOrder(order.id, symbol);
  } catch (e: any) {
    logger.error(`Case 5 Failed: ${e.message}`);
  }

  // Case 6: One-Way Mode with tradeSide='Open' and marginMode='crossed'
  try {
    logger.info(
      "Case 6: Limit Buy with tradeSide='Open' & marginMode='crossed'"
    );
    const order = await exchange.createOrder(
      symbol,
      "limit",
      "buy",
      amount,
      price,
      { tradeSide: "Open", marginMode: "crossed" }
    );
    logger.info(`Case 6 Success: ${order.id}`);
    await exchange.cancelOrder(order.id, symbol);
  } catch (e: any) {
    logger.error(`Case 6 Failed: ${e.message}`);
  }
}

debugOrder();
