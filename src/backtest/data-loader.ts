import * as fs from "fs";
import { OHLC } from "../types";
import { logger } from "../utils/logger";

export class DataLoader {
  public static async loadCSV(filePath: string): Promise<OHLC[]> {
    logger.info(`[DataLoader] Loading CSV from ${filePath}`);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(line => line.trim() !== "");

    // Assume standard format or detect header
    // Common Binance format: open_time, open, high, low, close, volume, ...
    // If header exists, skip it

    const data: OHLC[] = [];
    let startIndex = 0;

    // Default indices (Standard / Binance format)
    let idx = {
      timestamp: 0,
      open: 1,
      high: 2,
      low: 3,
      close: 4,
      volume: 5,
    };

    // Check if first line is header (contains letters)
    if (lines.length > 0 && /[a-zA-Z]/.test(lines[0])) {
      startIndex = 1;
      const headerLine = lines[0]
        .toLowerCase()
        .split(",")
        .map(c => c.trim());

      // Helper to find column index
      const findCol = (names: string[]) =>
        headerLine.findIndex(h => names.some(n => h === n || h.includes(n)));

      // Dynamic mapping
      const tsIndex = findCol(["timestamp", "open_time", "time", "date"]);
      const openIndex = findCol(["open"]);
      const highIndex = findCol(["high"]);
      const lowIndex = findCol(["low"]);
      const closeIndex = findCol(["close"]);
      const volIndex = findCol(["volume", "vol"]);

      // Only override if we found at least the critical columns
      if (tsIndex !== -1 && closeIndex !== -1) {
        idx = {
          timestamp: tsIndex,
          open: openIndex !== -1 ? openIndex : 1,
          high: highIndex !== -1 ? highIndex : 2,
          low: lowIndex !== -1 ? lowIndex : 3,
          close: closeIndex !== -1 ? closeIndex : 4,
          volume: volIndex !== -1 ? volIndex : 5,
        };
        logger.info(
          `[DataLoader] Detected CSV Header. Mapping: ${JSON.stringify(idx)}`
        );
      }
    }

    for (let i = startIndex; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 6) continue; // Basic check, might need adjustment if using custom indices

      // Helper to safely parse float
      const getVal = (index: number) => {
        if (index >= parts.length) return NaN;
        return parseFloat(parts[index]);
      };

      let timestamp = getVal(idx.timestamp);

      // Handle Date String if parseFloat failed or resulted in small number (like year 2023)
      // But typically Binance open_time is ms timestamp.
      // If timestamp is NaN, try Date.parse
      if (isNaN(timestamp)) {
        const dateStr = parts[idx.timestamp];
        const parsed = Date.parse(dateStr);
        if (!isNaN(parsed)) {
          timestamp = parsed;
        }
      }

      const open = getVal(idx.open);
      const high = getVal(idx.high);
      const low = getVal(idx.low);
      const close = getVal(idx.close);
      const volume = getVal(idx.volume);

      if (isNaN(timestamp) || isNaN(close)) continue;

      data.push({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
      });
    }

    // Sort by timestamp just in case
    data.sort((a, b) => a.timestamp - b.timestamp);

    logger.info(`[DataLoader] Loaded ${data.length} candles`);
    return data;
  }
}
