import { config } from './config/config';
import { ExchangeManager } from './market/exchange-manager';

async function main() {
    console.log("Starting LLM-PriceAction-Bot...");
    console.log("--------------------------------");
    
    try {
        // 1. Validate Config
        console.log(`Loaded Config:`);
        console.log(`- Exchange: ${config.exchange.id} (Sandbox: ${config.exchange.isSandbox})`);
        console.log(`- Strategy: ${config.strategy.timeframe} timeframe`);
        console.log(`- LLM: ${config.llm.provider} (${config.llm.model})`);
        console.log("--------------------------------");

        // 2. Initialize Exchange Manager
        const exchangeManager = new ExchangeManager();
        
        // 3. Test Connection
        await exchangeManager.testConnection();
        
        console.log("--------------------------------");
        console.log("System initialization check complete.");
        
    } catch (error) {
        console.error("Fatal Error during initialization:");
        console.error(error);
        process.exit(1);
    }
}

main();
