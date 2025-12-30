
import { ExchangeManager } from "../src/market/exchange-manager";
import { logger } from "../src/utils/logger";
import { config } from "../src/config/config";

async function debugStopOrder() {
    const manager = new ExchangeManager();
    const exchange = manager.getExchange();
    exchange.verbose = true;
    
    // Setup Market
    logger.info("Loading Markets...");
    const markets = await exchange.loadMarkets();
    const ethMarkets = Object.values(markets).filter(m => m && m.base === 'ETH' && m.quote === 'USDT' && m.swap);
    const targetMarket = ethMarkets[0];
    if (!targetMarket) return;
    const symbol = targetMarket.symbol;
    
    logger.info(`Using Symbol: ${symbol}`);

    const currentPrice = 3000; 
    const stopPrice = 3100; // Trigger above current (Buy Stop)
    const amount = 0.01;

    // Case 1: CCXT Standard stop_market
    try {
        logger.info("Case 1: stop_market");
        const order = await exchange.createOrder(symbol, 'stop_market', 'buy', amount, undefined, {
            stopPrice: stopPrice,
            tradeSide: 'Open' // Added per previous fix
        });
        logger.info(`Case 1 Success: ${order.id}`);
        // await exchange.cancelOrder(order.id, symbol); // Might be a plan order, different cancel?
    } catch (e: any) {
        logger.error(`Case 1 Failed: ${e.message}`);
    }

    // Case 2: Market with triggerPrice
    try {
        logger.info("Case 2: market with triggerPrice");
        const order = await exchange.createOrder(symbol, 'market', 'buy', amount, undefined, {
            triggerPrice: stopPrice,
            tradeSide: 'Open'
        });
        logger.info(`Case 2 Success: ${order.id}`);
    } catch (e: any) {
        logger.error(`Case 2 Failed: ${e.message}`);
    }
}

debugStopOrder();
