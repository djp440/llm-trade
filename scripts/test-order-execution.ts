import { TradeExecutor } from "../src/executor/trade-executor";
import { ExchangeManager } from "../src/market/exchange-manager";
import { TradePlan } from "../src/types";
import { logger } from "../src/utils/logger";
import { config } from "../src/config/config";
import { Order } from "ccxt";

async function runTests() {
  logger.info("正在启动真实订单执行测试...");

  // 1. 初始化交易所
  const exchangeManager = new ExchangeManager();
  const exchange = exchangeManager.getExchange();

  logger.info(`[设置] 交易所: ${exchange.id}`);
  logger.info(`[设置] 沙盒模式: ${config.exchange.isSandbox}`);

  if (!config.exchange.isSandbox) {
    logger.warn("!!! 警告: 正在真实交易所运行 (非沙盒模式) !!!");
    logger.warn("等待 5 秒... 按 Ctrl+C 终止。");
    await new Promise(r => setTimeout(r, 5000));
  }

  // 2. 加载市场和交易对
  logger.info("[设置] 正在加载市场...");
  const markets = await exchange.loadMarkets();
  logger.info(`[设置] 已加载 ${Object.keys(markets).length} 个市场。`);
  logger.info(
    `[设置] 示例交易对: ${Object.keys(markets).slice(0, 10).join(", ")}`
  );

  // 找到一个有效的 ETH 永续合约交易对
  const ethSymbols = Object.keys(markets).filter(s => {
    const m = markets[s];
    return m && s.includes("ETH") && m.swap && m.quote === "USDT";
  });
  logger.info(`[设置] 找到 ETH 永续合约交易对: ${ethSymbols.join(", ")}`);

  const symbol = config.symbols.active[0] || "ETH/USDT:USDT";
  logger.info(`[设置] 测试交易对: ${symbol}`);

  const market = exchange.market(symbol);
  if (!market) {
    throw new Error(`未找到市场 ${symbol}`);
  }

  // 3. 获取当前价格
  const ticker = await exchange.fetchTicker(symbol);
  if (!ticker || !ticker.last) {
    throw new Error(`无法获取 ${symbol} 的行情`);
  }
  const currentPrice = ticker.last;
  logger.info(`[设置] 当前价格: ${currentPrice}`);

  // 检查余额
  const balance = await exchange.fetchBalance();
  logger.info(`[设置] USDT 余额: ${balance["USDT"]?.free}`);

  // --- 清理开始 ---
  logger.info("\n[设置] 正在执行强制清理以启用模式切换...");
  try {
    // 1. 取消所有未成交订单 (普通 + 计划)
    logger.info("[清理] 正在取消所有未成交订单...");

    // 普通订单
    const openOrders = await exchange.fetchOpenOrders(symbol);
    for (const order of openOrders) {
      try {
        await exchange.cancelOrder(order.id, symbol);
        logger.info(`[清理] 已取消普通订单 ${order.id}`);
      } catch (e) {
        logger.warn(`[清理] 取消普通订单 ${order.id} 失败: ${e}`);
      }
    }

    // 计划委托订单 (触发单)
    try {
      // Bitget 特有: 获取计划委托订单
      // CCXT 可能支持带参数的 fetchOpenOrders，或者我们尝试特定处理
      // 尝试带 { stop: true } 的 fetchOpenOrders
      const planOrders = await exchange.fetchOpenOrders(
        symbol,
        undefined,
        undefined,
        { stop: true }
      );
      for (const order of planOrders) {
        try {
          await exchange.cancelOrder(order.id, symbol, { stop: true });
          logger.info(`[清理] 已取消计划委托订单 ${order.id}`);
        } catch (e) {
          logger.warn(`[清理] 取消计划委托订单 ${order.id} 失败: ${e}`);
        }
      }
    } catch (e) {
      logger.warn(`[清理] 获取/取消计划委托订单失败: ${e}`);
    }

    // 2. Close all positions
    logger.info("[清理] 正在平仓所有仓位...");
    const positions = await exchange.fetchPositions([symbol]);
    const targetPos = positions.filter(
      p => p.symbol === symbol && (p.contracts || 0) > 0
    );

    for (const pos of targetPos) {
      const size = pos.contracts || 0;
      const side = pos.side === "long" ? "sell" : "buy";
      logger.info(`[清理] 正在平仓: ${pos.side} ${size}`);

      // 首先尝试使用对冲模式参数进行平仓 (因为我们可能处于对冲模式)
      try {
        await exchange.createOrder(symbol, "market", side, size, undefined, {
          tradeSide: "Close",
        });
        logger.info(`[清理] 已平仓 (对冲模式逻辑)`);
      } catch (e: any) {
        // 退回到单向持仓逻辑
        try {
          await exchange.createOrder(symbol, "market", side, size, undefined, {
            reduceOnly: true,
          });
          logger.info(`[清理] 已平仓 (单向持仓逻辑)`);
        } catch (e2: any) {
          logger.error(`[清理] 平仓失败: ${e2.message}`);
        }
      }
    }

    // 等待清理操作传播
    await new Promise(r => setTimeout(r, 2000));
  } catch (e: any) {
    logger.warn(`[清理] 清理过程中出错: ${e.message}`);
  }
  // --- 清理结束 ---

  // 如果可能，将持仓模式设置为单向持仓
  try {
    // 尝试直接强制设置为单向持仓 (false)
    logger.info("[设置] 正在尝试强制设置单向持仓模式...");
    await exchange.setPositionMode(false, symbol);
    logger.info("[设置] 成功设置为单向持仓模式。");
  } catch (e: any) {
    logger.warn(`[设置] 设置持仓模式失败: ${e.message}`);
    // 如果设置失败，我们可能处于对冲模式，或者不支持设置。
    // 我们将继续，但会发出警告。
  }

  // 确定安全数量
  // 默认为最小金额或一个安全的小数字
  let quantity = market.limits.amount?.min || 0.01;
  // 稍微增加一点以避免如果最小值很严格时出现“太小”错误
  quantity = quantity * 1.5;
  // 格式化精度
  quantity = parseFloat(exchange.amountToPrecision(symbol, quantity));

  logger.info(`[设置] 测试数量: ${quantity}`);

  const executor = new TradeExecutor(exchangeManager);
  const createdOrders: Order[] = [];

  try {
    // --- 测试用例 1: 带止盈止损的市价买入 ---
    logger.info("\n--- 测试用例 1: 带止盈止损的市价买入 ---");

    // 止盈: +2%, 止损: -2%
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
      reason: "测试真实市价买入",
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
    logger.info(`[测试 1] 已生成 ${orders1.length} 个订单。`);

    // --- 测试用例 2: 限价止损买入 (突破) ---
    logger.info("\n--- 测试用例 2: 限价止损买入 (挂单突破) ---");

    // 进场: +5% (远离当前价格以避免成交)
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
      reason: "测试真实突破买入",
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
    logger.info(`[测试 2] 已生成 ${orders2.length} 个订单。`);
  } catch (error: any) {
    logger.error(`[测试失败] 错误: ${error.message}`);
  } finally {
    logger.info("\n--- 清理阶段 ---");
    logger.info("正在尝试取消所有已创建的订单并平仓...");

    // 使用与设置时相同的稳健清理逻辑
    try {
      // 1. 取消普通订单
      const openOrders = await exchange.fetchOpenOrders(symbol);
      for (const order of openOrders) {
        try {
          await exchange.cancelOrder(order.id, symbol);
          logger.info(`[清理] 已取消普通订单 ${order.id}`);
        } catch (e) {
          /* 忽略 */
        }
      }

      // 2. 取消计划委托订单
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
            logger.info(`[清理] 已取消计划委托订单 ${order.id}`);
          } catch (e) {
            /* 忽略 */
          }
        }
      } catch (e) {
        /* 忽略 */
      }

      // 3. 平仓
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
          logger.info(`[清理] 已平仓 ${size} ${side}`);
        } catch (e: any) {
          logger.error(`[清理] 平仓失败: ${e.message}`);
        }
      }
    } catch (e) {
      logger.error(`[清理] 最终清理失败: ${e}`);
    }

    logger.info("测试执行完成。");
  }
}

runTests().catch(console.error);
