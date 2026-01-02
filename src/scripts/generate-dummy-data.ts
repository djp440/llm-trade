
import * as fs from "fs";
import * as path from "path";

const filePath = path.join(process.cwd(), "data", "backtest_data.csv");

// Generate 200 candles of sine wave data
const candles = [];
const startPrice = 50000;
const startTime = Date.now() - 200 * 15 * 60 * 1000;

for (let i = 0; i < 200; i++) {
  const time = startTime + i * 15 * 60 * 1000;
  const angle = i * 0.1;
  const price = startPrice + Math.sin(angle) * 1000 + Math.random() * 100;
  
  const open = price;
  const close = price + (Math.random() - 0.5) * 50;
  const high = Math.max(open, close) + Math.random() * 20;
  const low = Math.min(open, close) - Math.random() * 20;
  const volume = 100 + Math.random() * 500;

  candles.push(`${time},${open.toFixed(2)},${high.toFixed(2)},${low.toFixed(2)},${close.toFixed(2)},${volume.toFixed(2)}`);
}

// Write header? Data loader logic checks for header.
// Let's add header
const content = "timestamp,open,high,low,close,volume\n" + candles.join("\n");

fs.writeFileSync(filePath, content);
console.log(`Generated ${candles.length} candles to ${filePath}`);
