import * as fs from 'fs';
import * as path from 'path';

class Logger {
    private logFilePath: string;

    constructor() {
        // 确保 logs 目录存在
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        
        // 生成文件名: log_YYYY-MM-DD_HH-mm-ss.log
        const now = new Date();
        const timestamp = this.formatDateForFilename(now);
        this.logFilePath = path.join(logsDir, `log_${timestamp}.log`);
        
        // 初始化日志
        this.write('SYSTEM', `Logger initialized. Log file: ${this.logFilePath}`);
    }

    /**
     * 格式化日期用于文件名
     */
    private formatDateForFilename(date: Date): string {
        const pad = (n: number) => n.toString().padStart(2, '0');
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
    private write(level: string, message: string) {
        const formatted = this.formatMessage(level, message);
        
        // 控制台输出
        console.log(formatted);
        
        // 文件输出 (同步写入以确保不丢失)
        try {
            fs.appendFileSync(this.logFilePath, formatted + '\n');
        } catch (err) {
            console.error('Failed to write to log file:', err);
        }
    }

    public info(message: string) {
        this.write('INFO', message);
    }

    public warn(message: string) {
        this.write('WARN', message);
    }

    public error(message: string, error?: any) {
        let msg = message;
        if (error) {
            msg += ` | Error: ${error instanceof Error ? error.message : String(error)}`;
            if (error instanceof Error && error.stack) {
                msg += `\nStack: ${error.stack}`;
            }
        }
        this.write('ERROR', msg);
    }

    public debug(message: string) {
        this.write('DEBUG', message);
    }
}

// 导出单例
export const logger = new Logger();
