import fs from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { config } from "../config/config";
import { ExchangeManager } from "../market/exchange-manager";
import { MarketDataManager } from "../market/manager";
import { LLMService } from "../llm/llm-service";
import { OHLC } from "../types";
import { logger } from "../utils/logger";

type CliOptions = {
  symbol?: string;
  timeframe?: string;
  lookback?: number;
  bufferMs?: number;
  width?: number;
  height?: number;
  watch?: boolean;
  iterations?: number;
  offline?: boolean;
  noVision?: boolean;
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

  const lookback = map["lookback"] ? Number(map["lookback"]) : undefined;
  const bufferMs = map["bufferMs"] ? Number(map["bufferMs"]) : undefined;
  const width = map["width"] ? Number(map["width"]) : undefined;
  const height = map["height"] ? Number(map["height"]) : undefined;
  const iterations = map["iterations"] ? Number(map["iterations"]) : undefined;

  return {
    symbol: map["symbol"] ? String(map["symbol"]) : undefined,
    timeframe: map["timeframe"] ? String(map["timeframe"]) : undefined,
    lookback: Number.isFinite(lookback) ? lookback : undefined,
    bufferMs: Number.isFinite(bufferMs) ? bufferMs : undefined,
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
    watch: Boolean(map["watch"] || false),
    iterations:
      iterations !== undefined && Number.isFinite(iterations)
        ? Math.max(1, Math.floor(iterations))
        : undefined,
    offline: Boolean(map["offline"] || process.env.CANDLE_TEST_OFFLINE),
    noVision: Boolean(map["noVision"] || false),
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTimeframeToMs(tf: string): number {
  const unit = tf.slice(-1);
  const value = parseInt(tf.slice(0, -1));
  if (!Number.isFinite(value) || value <= 0) return 15 * 60 * 1000;

  switch (unit) {
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

function normalizeTimeMs(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  return Number.isFinite(n) ? n : Date.now();
}

function sanitizeFilename(input: string): string {
  return input.replace(/[\\/:*?"<>|]+/g, "_");
}

function formatTimeLabel(timestampMs: number): string {
  const d = new Date(timestampMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
}

function getNiceStep(min: number, max: number, tickCount: number): number {
  const range = Math.max(0, max - min);
  if (range === 0) return 1;
  const rough = range / Math.max(1, tickCount - 1);
  const exponent = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exponent);
  const fraction = rough / base;

  let niceFraction = 1;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;

  return niceFraction * base;
}

function inferDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  if (step >= 1) return 2;
  const decimals = Math.ceil(-Math.log10(step)) + 1;
  return Math.min(8, Math.max(2, decimals));
}

function makeOfflineCandles(
  timeframe: string,
  lookback: number,
  nowMs: number
): OHLC[] {
  const msPerCandle = parseTimeframeToMs(timeframe);
  const currentSlotStart = Math.floor(nowMs / msPerCandle) * msPerCandle;
  const lastOpen = currentSlotStart - msPerCandle;
  const startOpen = lastOpen - (lookback - 1) * msPerCandle;

  let price = 100;
  const out: OHLC[] = [];
  for (let i = 0; i < lookback; i++) {
    const timestamp = startOpen + i * msPerCandle;
    const drift = (Math.sin(i / 3) + (Math.random() - 0.5) * 0.8) * 0.6;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + Math.random() * 0.8;
    const low = Math.min(open, close) - Math.random() * 0.8;
    price = close;
    out.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume: 0,
    });
  }
  return out;
}

function renderCandlesToPng(options: {
  symbol: string;
  timeframe: string;
  candles: OHLC[];
  pngPath: string;
  width: number;
  height: number;
}) {
  const { symbol, timeframe, candles, pngPath, width, height } = options;
  if (!candles.length) throw new Error("OHLC 数据为空，无法绘图");

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const margin = { left: 110, right: 110, top: 55, bottom: 95 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const left = margin.left;
  const top = margin.top;
  const right = left + plotW;
  const bottom = top + plotH;

  const minT = candles[0].timestamp;
  const maxT = candles[candles.length - 1].timestamp;
  let minY = candles.reduce((m, c) => Math.min(m, c.low), Infinity);
  let maxY = candles.reduce((m, c) => Math.max(m, c.high), -Infinity);

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    throw new Error("OHLC 价格无效，无法绘图");
  }
  if (minY === maxY) {
    const pad = minY === 0 ? 1 : Math.abs(minY) * 0.01;
    minY -= pad;
    maxY += pad;
  } else {
    const pad = (maxY - minY) * 0.06;
    minY -= pad;
    maxY += pad;
  }

  const yFor = (price: number) =>
    top + ((maxY - price) / (maxY - minY)) * plotH;
  const xForIndex = (i: number) => {
    if (candles.length <= 1) return left + plotW / 2;
    return left + (i / (candles.length - 1)) * plotW;
  };

  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, plotW, plotH);

  const majorTickCount = Math.max(10, Math.min(18, Math.round(plotH / 50) + 1));
  const yStep = getNiceStep(minY, maxY, majorTickCount);
  const yDecimals = inferDecimals(yStep);
  const yStart = Math.floor(minY / yStep) * yStep;

  const minorDivisions = 2;
  const yMinorStep = yStep / minorDivisions;

  ctx.font = "12px Arial";
  ctx.fillStyle = "#111827";

  const minorLineCount =
    Number.isFinite(yMinorStep) && yMinorStep > 0
      ? (maxY - minY) / yMinorStep
      : Number.POSITIVE_INFINITY;
  if (
    Number.isFinite(yMinorStep) &&
    yMinorStep > 0 &&
    Number.isFinite(minorLineCount) &&
    minorLineCount <= 300
  ) {
    const minorStart = Math.floor(minY / yMinorStep) * yMinorStep;
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    for (let v = minorStart; v <= maxY + yMinorStep * 0.5; v += yMinorStep) {
      if (v < minY - 1e-12) continue;
      const y = yFor(v);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  for (let v = yStart; v <= maxY + yStep * 0.5; v += yStep) {
    if (v < minY - 1e-12) continue;
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    const label = v.toFixed(yDecimals);
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = "#111827";
    ctx.fillText(label, left - 10 - textW, y + 4);
    ctx.fillText(label, right + 10, y + 4);

    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left - 6, y);
    ctx.lineTo(left, y);
    ctx.moveTo(right, y);
    ctx.lineTo(right + 6, y);
    ctx.stroke();

    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
  }

  const perIndexW = plotW / Math.max(1, candles.length - 1);
  const minLabelSpacingPx = 120;
  const xLabelEvery = Math.max(1, Math.ceil(minLabelSpacingPx / perIndexW));

  ctx.strokeStyle = "#f3f4f6";
  ctx.fillStyle = "#111827";
  ctx.font = "12px Arial";

  for (let i = 0; i < candles.length; i++) {
    if (i % xLabelEvery !== 0 && i !== candles.length - 1 && i !== 0) continue;
    const x = xForIndex(i);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();

    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom + 6);
    ctx.stroke();
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;

    const t = formatTimeLabel(candles[i].timestamp);
    const w = ctx.measureText(t).width;
    const yLine = i % (xLabelEvery * 2) === 0 ? bottom + 20 : bottom + 38;
    const xText = Math.max(0, Math.min(width - w, x - w / 2));
    ctx.fillText(t, xText, yLine);
  }

  const candlePixelSpan = plotW / Math.max(1, candles.length);
  const bodyW = Math.max(2, Math.floor(candlePixelSpan * 0.6));
  const wickW = Math.max(1, Math.floor(bodyW / 3));

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const x = xForIndex(i);
    const yHigh = yFor(c.high);
    const yLow = yFor(c.low);
    const yOpen = yFor(c.open);
    const yClose = yFor(c.close);
    const isBull = c.close >= c.open;

    ctx.strokeStyle = "#111827";
    ctx.lineWidth = wickW;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    const bodyTop = Math.min(yOpen, yClose);
    const bodyBottom = Math.max(yOpen, yClose);
    const bodyH = Math.max(1, bodyBottom - bodyTop);
    ctx.fillStyle = isBull ? "#16a34a" : "#dc2626";
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 1;
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
    ctx.strokeRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
  }

  ctx.fillStyle = "#111827";
  ctx.font = "bold 16px Arial";
  const startStr = formatTimeLabel(minT);
  const endStr = formatTimeLabel(maxT);
  const title = `${symbol} | ${timeframe} | ${startStr} ~ ${endStr}`;
  ctx.fillText(title, margin.left, 28);

  ctx.font = "12px Arial";
  ctx.fillStyle = "#374151";
  ctx.fillText(
    `价格区间: ${minY.toFixed(yDecimals)} ~ ${maxY.toFixed(yDecimals)}`,
    margin.left,
    46
  );

  const buf = canvas.toBuffer("image/png");
  fs.writeFileSync(pngPath, buf);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const timeframe =
    opts.timeframe || config.strategy.timeframes.trading.interval;
  const lookback =
    opts.lookback !== undefined
      ? Math.max(2, Math.floor(opts.lookback))
      : config.strategy.timeframes.trading.limit;
  const bufferMs =
    opts.bufferMs !== undefined ? Math.max(0, Math.floor(opts.bufferMs)) : 5000;
  const width =
    opts.width !== undefined ? Math.max(800, Math.floor(opts.width)) : 1600;
  const height =
    opts.height !== undefined ? Math.max(500, Math.floor(opts.height)) : 900;

  const symbol =
    opts.symbol ||
    (Array.isArray(config.symbols.active) ? config.symbols.active[0] : "");
  if (!symbol) {
    throw new Error(
      "未找到 symbol。请在 config.toml 的 symbols.active 配置，或使用 --symbol 指定。"
    );
  }

  const outputDir = path.join(process.cwd(), "output", "candle");
  await fs.promises.mkdir(outputDir, { recursive: true });

  const msPerCandle = parseTimeframeToMs(timeframe);

  let exchangeManager: ExchangeManager | null = null;
  let marketData: MarketDataManager | null = null;

  if (!opts.offline) {
    exchangeManager = new ExchangeManager();
    const ex = exchangeManager.getExchange();
    await ex.loadMarkets();
    marketData = new MarketDataManager(exchangeManager, symbol);
  }

  const iterations = opts.watch
    ? opts.iterations ?? Number.POSITIVE_INFINITY
    : 1;
  for (let round = 0; round < iterations; round++) {
    const nowMs = opts.offline
      ? Date.now()
      : normalizeTimeMs(
          await exchangeManager!
            .getExchange()
            .fetchTime()
            .catch(() => Date.now())
        );
    const nextCloseMs = Math.ceil(nowMs / msPerCandle) * msPerCandle;
    const targetWakeMs = nextCloseMs + bufferMs;
    const waitTime = Math.max(0, targetWakeMs - nowMs);

    logger.info(
      `[测试脚本] ${symbol} 将等待 ${Math.round(
        waitTime / 1000
      )} 秒，直到 K 线收盘: ${new Date(
        nextCloseMs
      ).toISOString()} (缓冲 ${Math.round(bufferMs / 1000)} 秒)`
    );
    await sleep(waitTime);

    const refNowMs = opts.offline
      ? Date.now()
      : normalizeTimeMs(
          await exchangeManager!
            .getExchange()
            .fetchTime()
            .catch(() => Date.now())
        );
    const candles = opts.offline
      ? makeOfflineCandles(timeframe, lookback, refNowMs)
      : await marketData!.getConfirmedCandles(timeframe, lookback, refNowMs);

    const last = candles[candles.length - 1];
    const candleCloseMs = last.timestamp + msPerCandle;
    const fileStamp = new Date(candleCloseMs)
      .toISOString()
      .replace(/[:.]/g, "-");

    const pngName = `${sanitizeFilename(symbol)}_${sanitizeFilename(
      timeframe
    )}_${fileStamp}_N${candles.length}.png`;
    const pngPath = path.join(outputDir, pngName);

    renderCandlesToPng({
      symbol,
      timeframe,
      candles,
      pngPath,
      width,
      height,
    });

    logger.info(
      `[测试脚本] 已输出 K 线图: ${path.relative(process.cwd(), pngPath)}`
    );

    if (!opts.noVision) {
      try {
        const llmService = new LLMService();
        const accountEquity = 1000;
        const riskPerTrade = config.strategy.risk_per_trade;
        logger.info("[测试脚本] 正在调用 LLM 主分析(可选含图像)...");
        const signal = await llmService.analyzeMarket(
          symbol,
          candles,
          candles, // Mock context
          candles, // Mock trend
          accountEquity,
          riskPerTrade
        );
        logger.info(
          "[测试脚本] LLM 返回信号:\n" + JSON.stringify(signal, null, 2)
        );
      } catch (error: any) {
        logger.error(
          `[测试脚本] LLM 调用失败: ${error?.message || String(error)}`
        );
      }
    }

    if (!opts.watch) break;
  }
}

main().catch(err => {
  logger.error("[测试脚本] 执行失败", err);
  process.exitCode = 1;
});
