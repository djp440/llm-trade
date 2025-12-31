import ccxt, { Exchange, Order } from "ccxt";
import dotenv from "dotenv";

dotenv.config();

type Side = "buy" | "sell";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw === "1" || raw.toLowerCase() === "true";
}

function envNumber(name: string, defaultValue?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    if (defaultValue === undefined) {
      throw new Error(`缺少环境变量 ${name}`);
    }
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`环境变量 ${name} 不是有效数字: ${raw}`);
  }
  return parsed;
}

function pickSide(): Side {
  const raw = (process.env["BITGET_SIDE"] || "buy").toLowerCase();
  if (raw !== "buy" && raw !== "sell") {
    throw new Error(`BITGET_SIDE 仅支持 buy/sell: ${raw}`);
  }
  return raw;
}

async function resolveSymbol(exchange: Exchange): Promise<string> {
  const specified = process.env["BITGET_SYMBOL"];
  if (specified) return specified;

  const markets = await exchange.loadMarkets();
  const base = (process.env["BITGET_BASE"] || "ETH").toUpperCase();
  const quote = (process.env["BITGET_QUOTE"] || "USDT").toUpperCase();
  const candidates = Object.values(markets).filter(
    m => m && m.swap && m.base === base && m.quote === quote
  );
  if (!candidates[0]) {
    throw new Error(`未找到 ${base}/${quote} 的永续合约市场，请设置 BITGET_SYMBOL`);
  }
  return candidates[0].symbol;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractOrderInfo(order: any) {
  const info = order?.info || {};
  const keys = [
    "orderId",
    "clientOid",
    "planType",
    "triggerPrice",
    "executePrice",
    "stopLossTriggerPrice",
    "stopLossExecutePrice",
    "stopLossTriggerType",
    "stopSurplusTriggerPrice",
    "stopSurplusExecutePrice",
    "stopSurplusTriggerType",
    "presetStopLossPrice",
    "presetStopSurplusPrice",
    "presetTakeProfitPrice",
  ];
  const picked: Record<string, unknown> = {};
  for (const k of keys) {
    if (info[k] !== undefined) picked[k] = info[k];
  }
  return {
    id: order?.id,
    status: order?.status,
    type: order?.type,
    side: order?.side,
    price: order?.price,
    stopPrice: order?.stopPrice,
    takeProfitPrice: order?.takeProfitPrice,
    stopLossPrice: order?.stopLossPrice,
    info: picked,
  };
}

async function fetchPlanOrders(exchange: Exchange, symbol: string): Promise<Order[]> {
  const orders = await exchange.fetchOpenOrders(symbol, undefined, undefined, {
    trigger: true,
  });
  return orders;
}

async function cancelPlanOrder(exchange: Exchange, symbol: string, id: string): Promise<void> {
  await exchange.cancelOrder(id, symbol, { trigger: true });
}

async function main() {
  const apiKey = requireEnv("BITGET_API_KEY");
  const apiSecret = requireEnv("BITGET_API_SECRET");
  const apiPassword = requireEnv("BITGET_API_PASSWORD");
  const verbose = envBool("BITGET_VERBOSE", true);
  const useSandbox = envBool("BITGET_SANDBOX", false);
  const side = pickSide();

  const exchange = new (ccxt as any).bitget({
    apiKey,
    secret: apiSecret,
    password: apiPassword,
    enableRateLimit: true,
    options: {
      defaultType: "swap",
    },
  }) as Exchange;

  exchange.verbose = verbose;

  if (useSandbox) {
    exchange.setSandboxMode(true);
  }

  const symbol = await resolveSymbol(exchange);
  await exchange.loadMarkets();

  const market = exchange.market(symbol);
  const amountEnv = process.env["BITGET_AMOUNT"];
  let amount = amountEnv ? envNumber("BITGET_AMOUNT") : 0;
  if (!amount || amount <= 0) {
    const min = market?.limits?.amount?.min;
    amount = typeof min === "number" && min > 0 ? min : 0.01;
  }
  amount = Number(exchange.amountToPrecision(symbol, amount));

  const ticker = await exchange.fetchTicker(symbol);
  const last = ticker.last;
  if (typeof last !== "number" || !Number.isFinite(last)) {
    throw new Error(`无法获取 ${symbol} 最新价，请检查网络/权限`);
  }

  const triggerOffsetPct = envNumber("BITGET_TRIGGER_OFFSET_PCT", 0.02);
  const slOffsetPct = envNumber("BITGET_SL_OFFSET_PCT", 0.01);
  const tpOffsetPct = envNumber("BITGET_TP_OFFSET_PCT", 0.01);

  const triggerPriceRaw = side === "buy" ? last * (1 + triggerOffsetPct) : last * (1 - triggerOffsetPct);
  const stopLossRaw = side === "buy" ? triggerPriceRaw * (1 - slOffsetPct) : triggerPriceRaw * (1 + slOffsetPct);
  const takeProfitRaw = side === "buy" ? triggerPriceRaw * (1 + tpOffsetPct) : triggerPriceRaw * (1 - tpOffsetPct);

  const triggerPrice = Number(exchange.priceToPrecision(symbol, triggerPriceRaw));
  const stopLoss = Number(exchange.priceToPrecision(symbol, stopLossRaw));
  const takeProfit = Number(exchange.priceToPrecision(symbol, takeProfitRaw));

  const dryRun = envBool("BITGET_DRY_RUN", false);

  const cases: Array<{
    name: string;
    params: Record<string, any>;
  }> = [
    {
      name: "错误用法：triggerPrice + presetStopLossPrice/presetStopSurplusPrice（通常不会附带到计划委托）",
      params: {
        triggerPrice,
        presetStopLossPrice: exchange.priceToPrecision(symbol, stopLoss),
        presetStopSurplusPrice: exchange.priceToPrecision(symbol, takeProfit),
      },
    },
    {
      name: "正确用法：triggerPrice + stopLoss/takeProfit 对象（会映射为 stopLossTriggerPrice/stopSurplusTriggerPrice）",
      params: {
        triggerPrice,
        stopLoss: {
          triggerPrice: stopLoss,
          price: stopLoss,
          type: "mark_price",
        },
        takeProfit: {
          triggerPrice: takeProfit,
          price: takeProfit,
          type: "mark_price",
        },
      },
    },
  ];

  console.log("[脚本] 交易对:", symbol);
  console.log("[脚本] 方向:", side);
  console.log("[脚本] 最新价:", last);
  console.log("[脚本] 触发价:", triggerPrice);
  console.log("[脚本] 止损价:", stopLoss);
  console.log("[脚本] 止盈价:", takeProfit);
  console.log("[脚本] 数量:", amount);
  console.log("[脚本] verbose:", verbose);
  console.log("[脚本] sandbox:", useSandbox);
  console.log("[脚本] dryRun:", dryRun);

  for (const c of cases) {
    console.log("\n============================");
    console.log("[脚本] 测试用例:", c.name);
    console.log("[脚本] createOrder params:", safeJson(c.params));

    if (dryRun) {
      continue;
    }

    let created: Order | null = null;
    try {
      created = await exchange.createOrder(symbol, "market", side, amount, undefined, c.params);
      console.log("[脚本] 下单成功，orderId:", created.id);
      console.log("[脚本] 解析订单要点:\n", safeJson(extractOrderInfo(created)));
    } catch (e: any) {
      console.log("[脚本] 下单失败:", e?.message || String(e));
      continue;
    }

    try {
      const open = await fetchPlanOrders(exchange, symbol);
      const matched = open.find(o => o.id === created?.id);
      console.log("[脚本] 当前计划委托数量:", open.length);
      if (matched) {
        console.log("[脚本] 在挂单列表中找到该单:\n", safeJson(extractOrderInfo(matched)));
      } else {
        console.log("[脚本] 未在挂单列表中找到该单（可能已触发/被拒/接口延迟）");
        if (open[0]) {
          console.log("[脚本] 示例返回(第一条):\n", safeJson(extractOrderInfo(open[0])));
        }
      }
    } catch (e: any) {
      console.log("[脚本] 拉取计划委托失败:", e?.message || String(e));
    }

    try {
      if (created?.id) {
        await cancelPlanOrder(exchange, symbol, created.id);
        console.log("[脚本] 已取消该计划委托:", created.id);
      }
    } catch (e: any) {
      console.log("[脚本] 取消计划委托失败:", e?.message || String(e));
    }
  }

  if (typeof (exchange as any).close === "function") {
    await (exchange as any).close();
  }
}

main().catch(e => {
  console.error("[脚本] 运行失败:", e?.message || String(e));
  process.exit(1);
});
