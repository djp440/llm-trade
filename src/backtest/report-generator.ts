
import * as fs from "fs";
import * as path from "path";
import { BacktestReport } from "./types";
import { logger } from "../utils/logger";

export class ReportGenerator {
  public static generateHTML(reportPath: string, outputPath: string) {
    try {
      const reportRaw = fs.readFileSync(reportPath, "utf-8");
      const report: BacktestReport = JSON.parse(reportRaw);

      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Backtest Report - ${report.config.symbol}</title>
    <script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1e1e1e; color: #e0e0e0; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: #2d2d2d; padding: 15px; border-radius: 8px; border: 1px solid #333; }
        .stat-label { font-size: 0.9em; color: #aaa; }
        .stat-value { font-size: 1.5em; font-weight: bold; margin-top: 5px; }
        .green { color: #4caf50; }
        .red { color: #f44336; }
        #chart { width: 100%; height: 500px; background: #2d2d2d; margin-bottom: 20px; border-radius: 8px; overflow: hidden; }
        table { width: 100%; border-collapse: collapse; background: #2d2d2d; border-radius: 8px; overflow: hidden; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #333; }
        th { background: #333; font-weight: 600; }
        tr:hover { background: #383838; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Backtest Report: ${report.config.symbol}</h1>
            <div>${new Date(report.startTime).toLocaleString()} - ${new Date(report.endTime).toLocaleString()}</div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Final Equity</div>
                <div class="stat-value ${report.finalEquity >= report.initialBalance ? 'green' : 'red'}">
                    $${report.finalEquity.toFixed(2)}
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total Return</div>
                <div class="stat-value ${report.totalReturn >= 0 ? 'green' : 'red'}">
                    ${report.totalReturn.toFixed(2)}%
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total Trades</div>
                <div class="stat-value">${report.totalTrades}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Win Rate</div>
                <div class="stat-value">${report.winRate.toFixed(2)}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Profit Factor</div>
                <div class="stat-value">${report.profitFactor.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Max Drawdown</div>
                <div class="stat-value red">${report.maxDrawdown.toFixed(2)}%</div>
            </div>
        </div>

        <div id="chart"></div>

        <h2>Trade History</h2>
        <table>
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Type</th>
                    <th>Entry Time</th>
                    <th>Entry Price</th>
                    <th>Exit Time</th>
                    <th>Exit Price</th>
                    <th>PnL</th>
                </tr>
            </thead>
            <tbody>
                ${report.trades.map(t => `
                <tr>
                    <td>${t.id.substring(0, 8)}</td>
                    <td style="color: ${t.side === 'long' ? '#4caf50' : '#f44336'}">${t.side.toUpperCase()}</td>
                    <td>${new Date(t.entryTime).toLocaleString()}</td>
                    <td>${t.entryPrice.toFixed(2)}</td>
                    <td>${t.exitTime ? new Date(t.exitTime).toLocaleString() : '-'}</td>
                    <td>${t.exitPrice ? t.exitPrice.toFixed(2) : '-'}</td>
                    <td class="${t.realizedPnL >= 0 ? 'green' : 'red'}">${t.realizedPnL.toFixed(2)}</td>
                </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

    <script>
        // Data Injection
        const candleData = ${JSON.stringify(report.candleData || [])}; 
        // Note: candleData needs to be populated in JSON report. 
        // If not present, we can't draw chart.
        // Assuming we add candleData to report or load it separately?
        // For now, let's assume report includes simplified candle data or we skip chart if missing.
        
        const trades = ${JSON.stringify(report.trades)};

        if (candleData.length > 0) {
            const chart = LightweightCharts.createChart(document.getElementById('chart'), {
                layout: { background: { color: '#2d2d2d' }, textColor: '#d1d4dc' },
                grid: { vertLines: { color: '#404040' }, horzLines: { color: '#404040' } },
                timeScale: { timeVisible: true, secondsVisible: false },
            });

            const candlestickSeries = chart.addCandlestickSeries();
            
            // Format data for Lightweight Charts
            const chartData = candleData.map(c => ({
                time: c.timestamp / 1000, // Unix timestamp in seconds
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close
            }));
            
            candlestickSeries.setData(chartData);

            // Add markers
            const markers = [];
            trades.forEach(t => {
                markers.push({
                    time: t.entryTime / 1000,
                    position: t.side === 'long' ? 'belowBar' : 'aboveBar',
                    color: t.side === 'long' ? '#4caf50' : '#f44336',
                    shape: t.side === 'long' ? 'arrowUp' : 'arrowDown',
                    text: 'ENTRY ' + t.side.toUpperCase()
                });
                if (t.exitTime) {
                    markers.push({
                        time: t.exitTime / 1000,
                        position: t.side === 'long' ? 'aboveBar' : 'belowBar',
                        color: t.realizedPnL >= 0 ? '#4caf50' : '#f44336',
                        shape: 'circle',
                        text: 'EXIT (' + t.realizedPnL.toFixed(2) + ')'
                    });
                }
            });
            
            candlestickSeries.setMarkers(markers.sort((a, b) => a.time - b.time));
            
            chart.timeScale().fitContent();
        } else {
            document.getElementById('chart').innerHTML = '<div style="padding: 20px; text-align: center; color: #aaa;">No candle data available in report</div>';
        }
    </script>
</body>
</html>
      `;

      fs.writeFileSync(outputPath, html);
      logger.info(`HTML Report generated at: ${outputPath}`);
    } catch (error) {
      logger.error("Failed to generate HTML report", error);
    }
  }
}
