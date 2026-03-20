import { MetricServiceClient } from '@google-cloud/monitoring';

async function main() {
    const metricsClient = new MetricServiceClient();
    const projectId = process.env.PROJECT_ID || 'gls-training-486405';
    
    console.log('Fetching CPU metrics for reasoning engines to see labels...');
    const [timeSeries] = await metricsClient.listTimeSeries({
        name: metricsClient.projectPath(projectId),
        filter: `metric.type="aiplatform.googleapis.com/reasoning_engine/cpu/allocation_time" AND resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
        interval: {
            startTime: { seconds: Math.floor(Date.now() / 1000) - 3600 },
            endTime: { seconds: Math.floor(Date.now() / 1000) }
        }
    });

    for (const ts of timeSeries) {
        console.log(JSON.stringify(ts.resource, null, 2));
        break;
    }
}

main().catch(console.error);
