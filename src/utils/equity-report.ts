import fs from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import { logger } from "./logger";

type EquityPoint = {
  timestampMs: number;
  equityUsdt: number;
};

type RecordEquityOptions = {
  timestampMs: number;
  equityUsdt: number;
};

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "output", "equity");
const DEFAULT_CSV_PATH = path.join(DEFAULT_OUTPUT_DIR, "equity.csv");
const DEFAULT_PNG_PATH = path.join(DEFAULT_OUTPUT_DIR, "equity.png");

let equityReportQueue: Promise<void> = Promise.resolve();

export async function recordEquityPointAndRenderChart(
  options: RecordEquityOptions
): Promise<void> {
  equityReportQueue = equityReportQueue
    .then(async () => {
      await doRecordEquityPointAndRenderChart(options);
    })
    .catch(err => {
      logger.error(`[权益记录] 任务执行失败: ${err?.message || String(err)}`);
    });

  return equityReportQueue;
}

async function doRecordEquityPointAndRenderChart(
  options: RecordEquityOptions
): Promise<void> {
  const { timestampMs, equityUsdt } = options;
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    throw new Error(`无效时间戳: ${timestampMs}`);
  }
  if (!Number.isFinite(equityUsdt)) {
    throw new Error(`无效权益数值: ${equityUsdt}`);
  }

  ensureDir(DEFAULT_OUTPUT_DIR);
  appendCsvPoint(DEFAULT_CSV_PATH, { timestampMs, equityUsdt });

  const points = readCsvPoints(DEFAULT_CSV_PATH);
  if (!points.length) {
    logger.warn("[权益记录] CSV 无有效数据，跳过绘图");
    return;
  }

  renderEquityChartPng(points, DEFAULT_PNG_PATH);
}

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function appendCsvPoint(csvPath: string, point: EquityPoint) {
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, "timestamp_ms,equity_usdt\n", "utf8");
  }

  const line = `${Math.floor(point.timestampMs)},${point.equityUsdt}\n`;
  fs.appendFileSync(csvPath, line, "utf8");
}

function readCsvPoints(csvPath: string): EquityPoint[] {
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const startIndex = lines[0].toLowerCase().startsWith("timestamp") ? 1 : 0;
  const points: EquityPoint[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 2) continue;
    const timestampMs = Number(parts[0]);
    const equityUsdt = Number(parts[1]);
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) continue;
    if (!Number.isFinite(equityUsdt)) continue;
    points.push({ timestampMs, equityUsdt });
  }

  points.sort((a, b) => a.timestampMs - b.timestampMs);
  return points;
}

function renderEquityChartPng(points: EquityPoint[], pngPath: string) {
  const width = 1200;
  const height = 600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const margin = { left: 90, right: 30, top: 40, bottom: 70 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const left = margin.left;
  const top = margin.top;
  const right = left + plotW;
  const bottom = top + plotH;

  const minT = points[0].timestampMs;
  const maxT = points[points.length - 1].timestampMs;
  let minY = points.reduce((m, p) => Math.min(m, p.equityUsdt), Infinity);
  let maxY = points.reduce((m, p) => Math.max(m, p.equityUsdt), -Infinity);

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    throw new Error("权益数据无效，无法绘图");
  }

  if (minY === maxY) {
    const pad = minY === 0 ? 1 : Math.abs(minY) * 0.01;
    minY -= pad;
    maxY += pad;
  } else {
    const pad = (maxY - minY) * 0.05;
    minY -= pad;
    maxY += pad;
  }

  const xFor = (t: number) => {
    if (maxT === minT) return (left + right) / 2;
    return left + ((t - minT) / (maxT - minT)) * plotW;
  };
  const yFor = (v: number) => top + ((maxY - v) / (maxY - minY)) * plotH;

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  const gridXCount = 8;
  const gridYCount = 6;
  for (let i = 0; i <= gridXCount; i++) {
    const x = left + (i / gridXCount) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let i = 0; i <= gridYCount; i++) {
    const y = top + (i / gridYCount) * plotH;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();

  ctx.fillStyle = "#111827";
  ctx.font = "20px sans-serif";
  ctx.fillText("账户权益 (USDT)", left, 28);

  ctx.font = "12px sans-serif";
  ctx.fillStyle = "#374151";
  const yLabelValues = [maxY, (maxY + minY) / 2, minY];
  for (const v of yLabelValues) {
    const y = yFor(v);
    const label = v.toFixed(2);
    ctx.fillText(label, 12, Math.max(12, Math.min(height - 12, y + 4)));
  }

  const startLabel = formatTimestamp(minT);
  const endLabel = formatTimestamp(maxT);
  ctx.fillText(startLabel, left, height - 24);
  const endLabelWidth = ctx.measureText(endLabel).width;
  ctx.fillText(endLabel, right - endLabelWidth, height - 24);

  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, idx) => {
    const x = xFor(p.timestampMs);
    const y = yFor(p.equityUsdt);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#2563eb";
  for (const p of points) {
    const x = xFor(p.timestampMs);
    const y = yFor(p.equityUsdt);
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const buf = canvas.toBuffer("image/png");
  fs.writeFileSync(pngPath, buf);
  logger.info(`[权益记录] 已更新: ${path.relative(process.cwd(), pngPath)}`);
}

function formatTimestamp(tsMs: number): string {
  const d = new Date(tsMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
