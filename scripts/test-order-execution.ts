import { TradeExecutor } from "../src/executor/trade-executor";
import { ExchangeManager } from "../src/market/exchange-manager";
import { TradePlan } from "../src/types";
import { logger } from "../src/utils/logger";
import { config } from "../src/config/config";
import { Order } from "ccxt";

async function runTests() {
  logger.info("Starting REAL Order Execution Tests...");

  // 1. Initialize Exchange
  const exchangeManager = new ExchangeManager();
  const exchange = exchangeManager.getExchange();

  logger.info(`[Setup] Exchange: ${exchange.id}`);
  logger.info(`[Setup] Sandbox Mode: ${config.exchange.isSandbox}`);

  if (!config.exchange.isSandbox) {
    logger.warn("!!! WARNING: RUNNING ON REAL EXCHANGE (NOT SANDBOX) !!!");
    logger.warn("Waiting 5 seconds... Press Ctrl+C to abort.");
    await new Promise(r => setTimeout(r, 5000));
  }

  // 2. Load Markets & Symbol
  logger.info("[Setup] Loading markets...");
  const markets = await exchange.loadMarkets();
  logger.info(`[Setup] Loaded ${Object.keys(markets).length} markets.`);
  logger.info(
    `[Setup] Sample symbols: ${Object.keys(markets).slice(0, 10).join(", ")}`
  );

  // Find a valid ETH swap symbol
  const ethSymbols = Object.keys(markets).filter(s => {
    const m = markets[s];
    return m && s.includes("ETH") && m.swap && m.quote === "USDT";
  });
  logger.info(`[Setup] Found ETH Swap Symbols: ${ethSymbols.join(", ")}`);

  const symbol = config.symbols.active[0] || "ETH/USDT:USDT";
  logger.info(`[Setup] Testing Symbol: ${symbol}`);

  const market = exchange.market(symbol);
  if (!market) {
    throw new Error(`Market ${symbol} not found`);
  }

  // 3. Get Current Price
  const ticker = await exchange.fetchTicker(symbol);
  if (!ticker || !ticker.last) {
    throw new Error(`Could not fetch ticker for ${symbol}`);
  }
  const currentPrice = ticker.last;
  logger.info(`[Setup] Current Price: ${currentPrice}`);

  // Check Balance
  const balance = await exchange.fetchBalance();
  logger.info(`[Setup] USDT Balance: ${balance["USDT"]?.free}`);

  // --- CLEANUP START ---
  logger.info("\n[Setup] performing HARD CLEANUP to enable mode switch...");
  try {
    // 1. Cancel all open orders (Normal + Plan)
    logger.info("[Cleanup] Cancelling all open orders...");

    // Normal Orders
    const openOrders = await exchange.fetchOpenOrders(symbol);
    for (const order of openOrders) {
      try {
        await exchange.cancelOrder(order.id, symbol);
        logger.info(`[Cleanup] Cancelled normal order ${order.id}`);
      } catch (e) {
        logger.warn(
          `[Cleanup] Failed to cancel normal order ${order.id}: ${e}`
        );
      }
    }

    // Plan Orders (Trigger Orders)
    try {
      // Bitget specific: fetch plan orders
      // CCXT might support fetchOpenOrders with params, or we try specific handling
      // Attempting fetchOpenOrders with stop: true
      const planOrders = await exchange.fetchOpenOrders(
        symbol,
        undefined,
        undefined,
        { stop: true }
      );
      for (const order of planOrders) {
        try {
          await exchange.cancelOrder(order.id, symbol, { stop: true });
          logger.info(`[Cleanup] Cancelled plan order ${order.id}`);
        } catch (e) {
          logger.warn(
            `[Cleanup] Failed to cancel plan order ${order.id}: ${e}`
          );
        }
      }
    } catch (e) {
      logger.warn(`[Cleanup] Failed to fetch/cancel plan orders: ${e}`);
    }

    // 2. Close all positions
    logger.info("[Cleanup] Closing all positions...");
    const positions = await exchange.fetchPositions([symbol]);
    const targetPos = positions.filter(
      p => p.symbol === symbol && (p.contracts || 0) > 0
    );

    for (const pos of targetPos) {
      const size = pos.contracts || 0;
      const side = pos.side === "long" ? "sell" : "buy";
      logger.info(`[Cleanup] Closing position: ${pos.side} ${size}`);

      // Try closing with Hedge mode param first (since we might be in Hedge)
      try {
        await exchange.createOrder(symbol, "market", side, size, undefined, {
          tradeSide: "Close",
        });
        logger.info(`[Cleanup] Closed position (Hedge logic)`);
      } catch (e: any) {
        // Fallback to One-Way logic
        try {
          await exchange.createOrder(symbol, "market", side, size, undefined, {
            reduceOnly: true,
          });
          logger.info(`[Cleanup] Closed position (One-Way logic)`);
        } catch (e2: any) {
          logger.error(`[Cleanup] Failed to close position: ${e2.message}`);
        }
      }
    }

    // Wait a bit for cleanup to propagate
    await new Promise(r => setTimeout(r, 2000));
  } catch (e: any) {
    logger.warn(`[Cleanup] Error during cleanup: ${e.message}`);
  }
  // --- CLEANUP END ---

  // Set Position Mode to One-Way if possible
  try {
    // Try to force set to One-Way (false) directly
    logger.info("[Setup] Attempting to force One-Way Mode...");
    await exchange.setPositionMode(false, symbol);
    logger.info("[Setup] Successfully set to One-Way Mode.");
  } catch (e: any) {
    logger.warn(`[Setup] Failed to set Position Mode: ${e.message}`);
    // If set fails, we might be in Hedge mode or it's not supported.
    // We'll proceed but warn.
  }

  // Determine safe quantity
  // Default to min amount or a safe small number
  let quantity = market.limits.amount?.min || 0.01;
  // Boost slightly to avoid "too small" errors if min is strict
  quantity = quantity * 1.5;
  // Format precision
  quantity = parseFloat(exchange.amountToPrecision(symbol, quantity));

  logger.info(`[Setup] Test Quantity: ${quantity}`);

  const executor = new TradeExecutor(exchangeManager);
  const createdOrders: Order[] = [];

  try {
    // --- Test Case 1: Market Buy with TP/SL ---
    logger.info("\n--- Test Case 1: Market Buy with TP/SL ---");

    // TP: +2%, SL: -2%
    const tpPrice = parseFloat(
      exchange.priceToPrecision(symbol, currentPrice * 1.02)
    );
    const slPrice = parseFloat(
      exchange.priceToPrecision(symbol, currentPrice * 0.98)
    );

    const plan1: TradePlan = {
      symbol: symbol,
      action: "BUY",
      quantity: quantity,
      riskAmount: 10,
      reason: "Test Real Market Buy",
      entryOrder: {
        symbol: symbol,
        side: "buy",
        type: "market",
        amount: quantity,
      },
      stopLossOrder: {
        symbol: symbol,
        side: "sell",
        type: "stop_market",
        amount: quantity,
        stopPrice: slPrice,
        params: { reduceOnly: true },
      },
      takeProfitOrder: {
        symbol: symbol,
        side: "sell",
        type: "limit",
        amount: quantity,
        price: tpPrice,
        params: { reduceOnly: true },
      },
    };

    const orders1 = await executor.executeTradePlan(plan1);
    createdOrders.push(...orders1);
    logger.info(`[Test 1] Generated ${orders1.length} orders.`);

    // --- Test Case 2: Stop Market Buy (Breakout) ---
    logger.info("\n--- Test Case 2: Stop Market Buy (Pending Breakout) ---");

    // Entry: +5% (Far away to avoid fill)
    const entryPrice = parseFloat(
      exchange.priceToPrecision(symbol, currentPrice * 1.05)
    );
    const pendingSlPrice = parseFloat(
      exchange.priceToPrecision(symbol, entryPrice * 0.98)
    );
    const pendingTpPrice = parseFloat(
      exchange.priceToPrecision(symbol, entryPrice * 1.02)
    );

    const plan2: TradePlan = {
      symbol: symbol,
      action: "BUY",
      quantity: quantity,
      riskAmount: 10,
      reason: "Test Real Breakout Buy",
      entryOrder: {
        symbol: symbol,
        side: "buy",
        type: "stop_market",
        amount: quantity,
        stopPrice: entryPrice,
        price: entryPrice,
      },
      stopLossOrder: {
        symbol: symbol,
        side: "sell",
        type: "stop_market",
        amount: quantity,
        stopPrice: pendingSlPrice,
        params: { reduceOnly: true },
      },
      takeProfitOrder: {
        symbol: symbol,
        side: "sell",
        type: "limit",
        amount: quantity,
        price: pendingTpPrice,
        params: { reduceOnly: true },
      },
    };

    const orders2 = await executor.executeTradePlan(plan2);
    createdOrders.push(...orders2);
    logger.info(`[Test 2] Generated ${orders2.length} orders.`);
  } catch (error: any) {
    logger.error(`[Test Failed] Error: ${error.message}`);
  } finally {
    logger.info("\n--- Cleanup Phase ---");
    logger.info(
      "Attempting to cancel all created orders and close positions..."
    );

    // Use the same robust cleanup logic as setup
    try {
      // 1. Cancel Normal Orders
      const openOrders = await exchange.fetchOpenOrders(symbol);
      for (const order of openOrders) {
        try {
          await exchange.cancelOrder(order.id, symbol);
          logger.info(`[Cleanup] Cancelled normal order ${order.id}`);
        } catch (e) {
          /* ignore */
        }
      }

      // 2. Cancel Plan Orders
      try {
        const planOrders = await exchange.fetchOpenOrders(
          symbol,
          undefined,
          undefined,
          { stop: true }
        );
        for (const order of planOrders) {
          try {
            await exchange.cancelOrder(order.id, symbol, { stop: true });
            logger.info(`[Cleanup] Cancelled plan order ${order.id}`);
          } catch (e) {
            /* ignore */
          }
        }
      } catch (e) {
        /* ignore */
      }

      // 3. Close Positions
      const positions = await exchange.fetchPositions([symbol]);
      const targetPos = positions.filter(
        p => p.symbol === symbol && (p.contracts || 0) > 0
      );
      for (const pos of targetPos) {
        const size = pos.contracts || 0;
        const side = pos.side === "long" ? "sell" : "buy";
        try {
          await exchange.createOrder(symbol, "market", side, size, undefined, {
            reduceOnly: true,
          });
          logger.info(`[Cleanup] Closed position ${size} ${side}`);
        } catch (e: any) {
          logger.error(`[Cleanup] Failed to close position: ${e.message}`);
        }
      }
    } catch (e) {
      logger.error(`[Cleanup] Final cleanup failed: ${e}`);
    }

    logger.info("Test execution finished.");
  }
}

runTests().catch(console.error);
