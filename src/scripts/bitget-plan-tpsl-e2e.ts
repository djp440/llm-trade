import ccxt, { Exchange } from "ccxt";
import { config } from "../config/config";
import { logger } from "../utils/logger";

type Scenario = "success" | "invalid" | "query" | "all";

type CliOptions = {
  scenario: Scenario;
  symbol?: string;
  amount?: number;
  side?: "buy" | "sell";
  pollSeconds: number;
  pollIntervalMs: number;
  keepOrder: boolean;
  orderId?: string;
  clientOid?: string;
};

type PlanPendingItem = {
  orderId?: string;
  clientOid?: string;
  symbol?: string;
  planType?: string;
  planStatus?: string;
  triggerPrice?: string;
  executePrice?: string;
  stopLossTriggerPrice?: string;
  stopSurplusTriggerPrice?: string;
  stopLossExecutePrice?: string;
  stopSurplusExecutePrice?: string;
  stopLossTriggerType?: string;
  stopSurplusTriggerType?: string;
  marginMode?: string;
  marginCoin?: string;
  side?: string;
  tradeSide?: string;
  orderType?: string;
  cTime?: string;
  uTime?: string;
};

type PlanPendingResponse = {
  code?: string;
  msg?: string;
  requestTime?: number;
  data?: {
    entrustedList?: PlanPendingItem[];
    endId?: string;
    nextFlag?: boolean;
    idLessThan?: string;
  };
};

function parseArgs(argv: string[]): CliOptions {
  const map: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map[key] = next;
      i++;
    } else {
      map[key] = true;
    }
  }

  const scenario = (String(map["scenario"] || "all") as Scenario) || "all";
  const symbol = map["symbol"] ? String(map["symbol"]) : undefined;
  const amount = map["amount"] ? Number(map["amount"]) : undefined;
  const side = map["side"]
    ? (String(map["side"]) as "buy" | "sell")
    : undefined;
  const pollSeconds = map["pollSeconds"] ? Number(map["pollSeconds"]) : 20;
  const pollIntervalMs = map["pollIntervalMs"]
    ? Number(map["pollIntervalMs"])
    : 2000;
  const keepOrder = Boolean(map["keepOrder"] || false);
  const orderId = map["orderId"] ? String(map["orderId"]) : undefined;
  const clientOid = map["clientOid"] ? String(map["clientOid"]) : undefined;

  return {
    scenario,
    symbol,
    amount,
    side,
    pollSeconds: Number.isFinite(pollSeconds) ? pollSeconds : 20,
    pollIntervalMs: Number.isFinite(pollIntervalMs) ? pollIntervalMs : 2000,
    keepOrder,
    orderId,
    clientOid,
  };
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function safeStringify(value: any) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeVerboseLog(text: string) {
  return text
    .replace(/"ACCESS-KEY"\s*:\s*"[^"]*"/g, '"ACCESS-KEY": "***"')
    .replace(/"ACCESS-SIGN"\s*:\s*"[^"]*"/g, '"ACCESS-SIGN": "***"')
    .replace(/"ACCESS-PASSPHRASE"\s*:\s*"[^"]*"/g, '"ACCESS-PASSPHRASE": "***"')
    .replace(
      /"X-CHANNEL-API-CODE"\s*:\s*"[^"]*"/g,
      '"X-CHANNEL-API-CODE": "***"'
    )
    .replace(/"apiKey"\s*:\s*"[^"]*"/gi, '"apiKey": "***"')
    .replace(/"secret"\s*:\s*"[^"]*"/gi, '"secret": "***"')
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password": "***"');
}

function formatCcxtError(e: any) {
  const name = e?.name ? String(e.name) : "UnknownError";
  const message = e?.message ? String(e.message) : String(e);
  const code = e?.code ? String(e.code) : undefined;
  const httpStatus = e?.status ? String(e.status) : undefined;
  const body = e?.body ? String(e.body) : undefined;
  const requestId =
    e?.headers?.["x-request-id"] || e?.headers?.["X-Request-Id"];
  return {
    name,
    message,
    code,
    httpStatus,
    requestId: requestId ? String(requestId) : undefined,
    body,
    stack: e?.stack ? String(e.stack) : undefined,
  };
}

function detectProductTypeFromMarket(market: any): string {
  const settle = String(market?.settle || market?.settleId || "").toUpperCase();
  if (settle === "USDT") return "USDT-FUTURES";
  if (settle === "USDC") return "USDC-FUTURES";
  return "COIN-FUTURES";
}

async function createExchange(): Promise<Exchange> {
  if (!config.exchange.apiKey || !config.exchange.apiSecret) {
    throw new Error(
      "缺少交易所 API Key/Secret。请检查 .env 中 DEMO_API_KEY/DEMO_API_SECRET (模拟盘)。"
    );
  }

  const exchangeClass = (ccxt as any)[config.exchange.id];
  if (!exchangeClass) {
    throw new Error(`在 CCXT 中未找到交易所 ${config.exchange.id}`);
  }

  const exchange: Exchange = new exchangeClass({
    apiKey: config.exchange.apiKey,
    secret: config.exchange.apiSecret,
    password: config.exchange.apiPassword,
    enableRateLimit: true,
    options: {
      defaultType: "swap",
    },
  });

  exchange.setSandboxMode(Boolean(config.exchange.isSandbox));
  exchange.verbose = true;
  (exchange as any).log = (...args: any[]) => {
    const msg = args
      .map(a => (typeof a === "string" ? a : safeStringify(a)))
      .join(" ");
    logger.debug(`[CCXT] ${sanitizeVerboseLog(msg)}`);
  };

  return exchange;
}

async function pickSymbol(exchange: Exchange, preferredSymbol?: string) {
  await exchange.loadMarkets();
  if (preferredSymbol) {
    const m = exchange.market(preferredSymbol);
    if (!m) throw new Error(`未找到交易对: ${preferredSymbol}`);
    return { symbol: preferredSymbol, market: m };
  }

  const markets = Object.values(exchange.markets || {});
  const swapUsdt = markets.filter(
    (m: any) => m && m.swap && String(m.settle).toUpperCase() === "USDT"
  );
  const pick =
    swapUsdt.find((m: any) => m.base === "ETH" && m.quote === "USDT") ||
    swapUsdt.find((m: any) => m.base === "BTC" && m.quote === "USDT") ||
    swapUsdt[0] ||
    markets.find((m: any) => m && m.swap) ||
    markets[0];

  if (!pick) throw new Error("未找到任何可用市场");
  return { symbol: pick.symbol as string, market: pick };
}

async function getHedgeMode(exchange: Exchange, symbol: string) {
  if (exchange.id !== "bitget") return false;
  try {
    const mode: any = await (exchange as any).fetchPositionMode(symbol);
    return Boolean(mode?.hedged);
  } catch (e: any) {
    logger.warn(
      `[测试脚本] 获取持仓模式失败，默认按单向持仓处理: ${
        formatCcxtError(e).message
      }`
    );
    return false;
  }
}

async function createOrderWithModeRetry(
  exchange: Exchange,
  symbol: string,
  type: string,
  side: "buy" | "sell",
  amount: number,
  price: number | undefined,
  params: Record<string, any>
) {
  if (exchange.id !== "bitget") {
    return exchange.createOrder(symbol, type, side, amount, price, params);
  }

  const initialHedged = await getHedgeMode(exchange, symbol);

  const attempt = async (hedged: boolean) => {
    const p = { ...params, hedged };
    return exchange.createOrder(symbol, type, side, amount, price, p);
  };

  try {
    return await attempt(initialHedged);
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.includes("40774")) {
      logger.warn(
        `[测试脚本] 订单因模式不匹配失败，切换 hedged=${!initialHedged} 重试`
      );
      return await attempt(!initialHedged);
    }
    throw e;
  }
}

async function fetchPlanPendingRaw(
  exchange: Exchange,
  market: any,
  planType: string
) {
  if (exchange.id !== "bitget") {
    throw new Error(
      "当前脚本仅实现 Bitget 合约计划委托查询 (orders-plan-pending)"
    );
  }

  const productType = detectProductTypeFromMarket(market);
  const request = {
    symbol: market.id,
    productType,
    planType,
  };
  logger.debug(
    `[测试脚本] 原始查询参数 orders-plan-pending: ${safeStringify(request)}`
  );
  const resp: PlanPendingResponse = await (
    exchange as any
  ).privateMixGetV2MixOrderOrdersPlanPending(request);
  logger.debug(`[测试脚本] orders-plan-pending 响应: ${safeStringify(resp)}`);
  return resp;
}

function findPendingItem(
  resp: PlanPendingResponse,
  orderId?: string,
  clientOid?: string
) {
  const list = resp?.data?.entrustedList || [];
  const byOrderId = orderId ? list.find(x => x.orderId === orderId) : undefined;
  if (byOrderId) return byOrderId;
  const byClientOid = clientOid
    ? list.find(x => x.clientOid === clientOid)
    : undefined;
  if (byClientOid) return byClientOid;
  return undefined;
}

async function scenarioSuccess(exchange: Exchange, options: CliOptions) {
  logger.info("[场景1] 成功附加止盈止损的计划委托");

  const { symbol, market } = await pickSymbol(exchange, options.symbol);
  logger.info(`[场景1] 选择交易对: ${symbol} (marketId=${market.id})`);

  const ticker = await exchange.fetchTicker(symbol);
  const last = ticker.last;
  if (!last) throw new Error("无法获取最新价格 (ticker.last 为空)");

  const desiredSide: "buy" | "sell" = options.side || "buy";
  const triggerPriceRaw = desiredSide === "buy" ? last * 1.05 : last * 0.95;
  const triggerPrice = Number(
    exchange.priceToPrecision(symbol, triggerPriceRaw)
  );
  const stopLossTriggerRaw =
    desiredSide === "buy" ? triggerPrice * 0.98 : triggerPrice * 1.02;
  const takeProfitTriggerRaw =
    desiredSide === "buy" ? triggerPrice * 1.02 : triggerPrice * 0.98;
  const stopLossTriggerPrice = Number(
    exchange.priceToPrecision(symbol, stopLossTriggerRaw)
  );
  const takeProfitTriggerPrice = Number(
    exchange.priceToPrecision(symbol, takeProfitTriggerRaw)
  );

  const minAmount = market?.limits?.amount?.min
    ? Number(market.limits.amount.min)
    : 0;
  const rawAmount = options.amount ?? (minAmount > 0 ? minAmount : 0.01);
  const amount = Number(
    exchange.amountToPrecision(symbol, Math.max(rawAmount, minAmount || 0))
  );

  const clientOid = `tpsl-plan-${Date.now()}`;
  const params = {
    triggerPrice,
    triggerType: "mark_price",
    marginMode: "cross",
    clientOid,
    stopLoss: {
      triggerPrice: stopLossTriggerPrice,
      price: stopLossTriggerPrice,
      type: "mark_price",
    },
    takeProfit: {
      triggerPrice: takeProfitTriggerPrice,
      price: takeProfitTriggerPrice,
      type: "mark_price",
    },
  };

  logger.debug(
    `[场景1] 原始下单参数 createOrder: ${safeStringify({
      symbol,
      type: "market",
      side: desiredSide,
      amount,
      price: undefined,
      params,
    })}`
  );

  const order = await createOrderWithModeRetry(
    exchange,
    symbol,
    "market",
    desiredSide,
    amount,
    undefined,
    params
  );
  logger.info(
    `[场景1] 下单成功: orderId=${order.id} clientOid=${clientOid} status=${order.status}`
  );
  logger.debug(`[场景1] createOrder 返回: ${safeStringify(order)}`);

  const pendingResp = await fetchPlanPendingRaw(
    exchange,
    market,
    "normal_plan"
  );
  const item = findPendingItem(pendingResp, order.id, clientOid);

  const verified = Boolean(
    item &&
      item.stopLossTriggerPrice &&
      item.stopSurplusTriggerPrice &&
      Number(item.stopLossTriggerPrice) === stopLossTriggerPrice &&
      Number(item.stopSurplusTriggerPrice) === takeProfitTriggerPrice
  );

  if (item) {
    logger.info(
      `[场景1] 附加校验: SL=${item.stopLossTriggerPrice} TP=${item.stopSurplusTriggerPrice} planStatus=${item.planStatus}`
    );
  } else {
    logger.warn(
      "[场景1] 未在 orders-plan-pending 中找到该计划委托 (可能需要等待同步)"
    );
  }

  if (!verified) {
    logger.warn("[场景1] 校验未通过：止盈止损字段缺失或不匹配");
  } else {
    logger.info("[场景1] 校验通过：计划委托已附加止盈止损参数");
  }

  return { symbol, market, orderId: String(order.id), clientOid, verified };
}

async function scenarioInvalid(exchange: Exchange, options: CliOptions) {
  logger.info("[场景2] 无效参数情况下的错误处理");
  const { symbol, market } = await pickSymbol(exchange, options.symbol);
  logger.info(`[场景2] 选择交易对: ${symbol} (marketId=${market.id})`);

  const ticker = await exchange.fetchTicker(symbol);
  const last = ticker.last;
  if (!last) throw new Error("无法获取最新价格 (ticker.last 为空)");

  const minAmount = market?.limits?.amount?.min
    ? Number(market.limits.amount.min)
    : 0;
  const rawAmount = options.amount ?? (minAmount > 0 ? minAmount : 0.01);
  const amount = Number(
    exchange.amountToPrecision(symbol, Math.max(rawAmount, minAmount || 0))
  );

  const clientOid = `tpsl-invalid-${Date.now()}`;
  const params = {
    triggerPrice: -1,
    triggerType: "mark_price",
    marginMode: "cross",
    clientOid,
    stopLoss: {
      triggerPrice: Number(exchange.priceToPrecision(symbol, last * 0.9)),
      price: Number(exchange.priceToPrecision(symbol, last * 0.9)),
      type: "mark_price",
    },
    takeProfit: {
      triggerPrice: Number(exchange.priceToPrecision(symbol, last * 1.1)),
      price: Number(exchange.priceToPrecision(symbol, last * 1.1)),
      type: "mark_price",
    },
  };

  logger.debug(
    `[场景2] 原始下单参数 createOrder: ${safeStringify({
      symbol,
      type: "market",
      side: "buy",
      amount,
      price: undefined,
      params,
    })}`
  );
  try {
    await createOrderWithModeRetry(
      exchange,
      symbol,
      "market",
      "buy",
      amount,
      undefined,
      params
    );
    logger.warn("[场景2] 预期失败但实际下单成功，请检查交易所校验规则");
  } catch (e: any) {
    const fe = formatCcxtError(e);
    logger.info(`[场景2] 捕获到预期错误: ${fe.name} ${fe.message}`);
    logger.debug(`[场景2] 错误详情: ${safeStringify(fe)}`);
  }
}

async function scenarioQuery(exchange: Exchange, options: CliOptions) {
  logger.info("[场景3] 订单状态查询验证");

  const { symbol, market } = await pickSymbol(exchange, options.symbol);
  logger.info(`[场景3] 选择交易对: ${symbol} (marketId=${market.id})`);

  let orderId = options.orderId;
  let clientOid = options.clientOid;

  if (!orderId && !clientOid) {
    const created = await scenarioSuccess(exchange, {
      ...options,
      scenario: "success",
      keepOrder: true,
    });
    orderId = created.orderId;
    clientOid = created.clientOid;
  }

  const pollEnd = Date.now() + options.pollSeconds * 1000;
  let lastSeenStatus: string | undefined;
  let found = false;

  while (Date.now() < pollEnd) {
    try {
      const resp = await fetchPlanPendingRaw(exchange, market, "normal_plan");
      const item = findPendingItem(resp, orderId, clientOid);
      if (item) {
        found = true;
        const status = item.planStatus || "unknown";
        if (status !== lastSeenStatus) {
          lastSeenStatus = status;
          logger.info(
            `[场景3] 状态变更: orderId=${item.orderId} clientOid=${item.clientOid} planStatus=${status} triggerPrice=${item.triggerPrice}`
          );
        } else {
          logger.debug(
            `[场景3] 状态轮询: orderId=${item.orderId} clientOid=${item.clientOid} planStatus=${status}`
          );
        }
      } else {
        logger.debug("[场景3] 未找到目标计划委托，继续轮询...");
      }
    } catch (e: any) {
      logger.warn(
        `[场景3] 查询失败，将继续重试: ${formatCcxtError(e).message}`
      );
    }
    await sleep(options.pollIntervalMs);
  }

  if (!found) {
    logger.warn("[场景3] 在轮询窗口内未找到目标计划委托");
  }

  if (!options.keepOrder && orderId) {
    try {
      logger.info(`[场景3] 尝试撤销计划委托: ${orderId}`);
      const canceled = await exchange.cancelOrder(orderId, symbol, {
        trigger: true,
        planType: "normal_plan",
      });
      logger.info(`[场景3] 撤销请求已提交: ${safeStringify(canceled)}`);

      const respAfter = await fetchPlanPendingRaw(
        exchange,
        market,
        "normal_plan"
      );
      const stillThere = findPendingItem(respAfter, orderId, clientOid);
      if (stillThere) {
        logger.warn("[场景3] 撤销后仍能查到该计划委托，可能存在延迟");
      } else {
        logger.info("[场景3] 撤销后查询不到该计划委托 (符合预期)");
      }
    } catch (e: any) {
      logger.warn(`[场景3] 撤销失败: ${formatCcxtError(e).message}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  logger.info("Bitget 合约计划委托(附带止盈止损) 独立验证脚本启动");
  logger.info(
    `运行模式: ${config.exchange.isSandbox ? "模拟盘" : "实盘"} | 交易所: ${
      config.exchange.id
    }`
  );
  logger.info(`场景: ${options.scenario} | keepOrder=${options.keepOrder}`);

  const exchange = await createExchange();

  try {
    if (options.scenario === "success") {
      await scenarioSuccess(exchange, options);
    } else if (options.scenario === "invalid") {
      await scenarioInvalid(exchange, options);
    } else if (options.scenario === "query") {
      await scenarioQuery(exchange, options);
    } else {
      const created = await scenarioSuccess(exchange, {
        ...options,
        scenario: "success",
        keepOrder: true,
      });
      await scenarioInvalid(exchange, { ...options, scenario: "invalid" });
      await scenarioQuery(exchange, {
        ...options,
        scenario: "query",
        orderId: created.orderId,
        clientOid: created.clientOid,
      });
    }
  } catch (e: any) {
    logger.error("脚本执行失败", e);
    process.exitCode = 1;
  } finally {
    try {
      await exchange.close();
    } catch (e: any) {
      logger.warn(`[测试脚本] 关闭连接失败: ${formatCcxtError(e).message}`);
    }
  }
}

main();
