import { LLMPromptContext, TradeSignal } from "../types";

/**
 * LLM Brain: Responsible for constructing prompts and parsing signals
 */
export class LLMBrain {
    /**
     * Analyze market data using LLM
     */
    public async analyze(context: LLMPromptContext): Promise<TradeSignal> {
        // TODO: Construct prompt and call LLM API
        throw new Error("Not implemented");
    }

    /**
     * Generate ASCII Chart from OHLC data
     */
    public generateASCIIChart(data: any[]): string {
        return "";
    }
}