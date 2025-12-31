
import { LLMService } from "../llm/llm-service";
import { logger } from "../utils/logger";

async function testConnection() {
  try {
    logger.info("Starting LLM connection test...");
    
    // We'll mock the OHLC data just enough to pass the type check
    // The content doesn't matter much, we just want to see if the API responds
    const mockOHLC = Array(20).fill(null).map((_, i) => ({
      timestamp: Date.now() - (20 - i) * 15 * 60 * 1000,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000
    }));

    const service = new LLMService();
    
    // We expect this to fail or succeed, but at least connect
    // Since the prompt is complex, we just want to see if we get a response (even an error from the model)
    // or a network error.
    
    logger.info("Sending request to LLM...");
    const result = await service.analyzeMarket("BTC/USDT", mockOHLC, 1000, 0.01);
    
    logger.info("LLM Response received:");
    console.log(JSON.stringify(result, null, 2));
    
  } catch (error: any) {
    logger.error("LLM Connection Test Failed:");
    logger.error(error.message);
    if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Data: ${JSON.stringify(error.response.data)}`);
    }
  }
}

testConnection();
