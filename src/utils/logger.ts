import * as fs from "fs";
import * as path from "path";

class Logger {
  private logFilePath: string;

  constructor() {
    // 确保 logs 目录存在
    const logsDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // 生成文件名: log_YYYY-MM-DD_HH-mm-ss.log
    const now = new Date();
    const timestamp = this.formatDateForFilename(now);
    this.logFilePath = path.join(logsDir, `log_${timestamp}.log`);

    // 初始化日志
    this.write("SYSTEM", `日志系统已初始化。日志文件: ${this.logFilePath}`);
  }

  /**
   * 格式化日期用于文件名
   */
  private formatDateForFilename(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const yyyy = date.getFullYear();
    const MM = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const HH = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}`;
  }

  /**
   * 格式化日志消息
   */
  private formatMessage(level: string, message: string): string {
    const now = new Date().toISOString();
    return `[${now}] [${level}] ${message}`;
  }

  /**
   * 写入日志到控制台和文件
   */
  private isColorEnabled(): boolean {
    const forceColor = process.env.FORCE_COLOR;
    if (forceColor && forceColor !== "0") return true;
    if (process.env.NO_COLOR !== undefined) return false;
    return Boolean(process.stdout.isTTY);
  }

  private colorize(level: string, text: string): string {
    const RESET = "\x1b[0m";
    const GRAY = "\x1b[90m";
    const RED = "\x1b[31m";
    const YELLOW = "\x1b[33m";
    const CYAN = "\x1b[36m";
    const MAGENTA = "\x1b[35m";
    const BLUE = "\x1b[34m";
    const BRIGHT_GREEN = "\x1b[92m";
    const BRIGHT_MAGENTA = "\x1b[95m";
    const BRIGHT_YELLOW = "\x1b[93m";
    const BRIGHT_BLUE = "\x1b[94m";
    const BOLD = "\x1b[1m";

    let color = "";
    switch (level) {
      case "错误":
        color = RED;
        break;
      case "警告":
        color = YELLOW;
        break;
      case "信息":
        color = CYAN;
        break;
      case "调试":
        color = GRAY;
        break;
      case "SYSTEM":
        color = MAGENTA;
        break;
      case "模型":
        color = BRIGHT_MAGENTA;
        break;
      case "开仓":
        color = BRIGHT_GREEN;
        break;
      case "平仓":
        color = BRIGHT_MAGENTA;
        break;
      case "仓位":
        color = BRIGHT_BLUE;
        break;
      case "重要":
        color = `${BOLD}${BRIGHT_YELLOW}`;
        break;
      default:
        color = "";
        break;
    }

    if (!color) return text;
    return `${color}${text}${RESET}`;
  }

  private write(level: string, message: string) {
    const formatted = this.formatMessage(level, message);

    const consoleMessage = this.isColorEnabled()
      ? this.colorize(level, formatted)
      : formatted;

    // 控制台输出
    if (level === "错误") {
      console.error(consoleMessage);
    } else if (level === "警告") {
      console.warn(consoleMessage);
    } else {
      console.log(consoleMessage);
    }

    // 文件输出 (同步写入以确保不丢失)
    try {
      fs.appendFileSync(this.logFilePath, formatted + "\n");
    } catch (err) {
      console.error("写入日志文件失败:", err);
    }
  }

  public info(message: string) {
    this.write("信息", message);
  }

  public important(message: string) {
    this.write("重要", message);
  }

  public llm(message: string) {
    this.write("模型", message);
  }

  public tradeOpen(message: string) {
    this.write("开仓", message);
  }

  public tradeClose(message: string) {
    this.write("平仓", message);
  }

  public position(message: string) {
    this.write("仓位", message);
  }

  public warn(message: string) {
    this.write("警告", message);
  }

  public error(message: string, error?: any) {
    let msg = message;
    if (error) {
      msg += ` | 错误: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (error instanceof Error && error.stack) {
        msg += `\n堆栈: ${error.stack}`;
      }
    }
    this.write("错误", msg);
  }

  public debug(message: string) {
    this.write("调试", message);
  }
}

// 导出单例
export const logger = new Logger();
