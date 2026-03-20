import { MetricServiceClient } from '@google-cloud/monitoring';

async function main() {
    const metricsClient = new MetricServiceClient();
    const projectId = process.env.PROJECT_ID || 'gls-training-486405';
    
    console.log('Fetching metrics for reasoning engines...');
    const [timeSeries] = await metricsClient.listTimeSeries({
        name: metricsClient.projectPath(projectId),
        // Filter by any metric on a reasoning engine over the last hour
        filter: `resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
        interval: {
            startTime: { seconds: Math.floor(Date.now() / 1000) - 3600 },
            endTime: { seconds: Math.floor(Date.now() / 1000) }
        }
    });

    console.log(`Found ${timeSeries.length} time series.`);
    const metricTypes = new Set(timeSeries.map(ts => ts.metric?.type));
    console.log('Available Metric Types:', Array.from(metricTypes));
    
    // Dump actual structure of the first token-related metric
    for (const ts of timeSeries) {
        if (ts.metric?.type?.includes('token')) {
            console.log('\nToken Metric Example:');
            console.log(JSON.stringify(ts, null, 2));
            break;
        }
    }
}

main().catch(console.error);
