import { PubSub, Message } from '@google-cloud/pubsub';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

// ── Config ───────────────────────────────────────────────────────────
dotenv.config();

const PROJECT_ID = process.env.PROJECT_ID;
const SUBSCRIPTION_NAME = process.env.SUBSCRIPTION_NAME;

if (!PROJECT_ID || !SUBSCRIPTION_NAME) {
    console.error(
        '❌ Missing required env vars: PROJECT_ID and SUBSCRIPTION_NAME must be set in .env',
    );
    process.exit(1);
}

// ── Clients ──────────────────────────────────────────────────────────
const pubsub = new PubSub({ projectId: PROJECT_ID });
const subscription = pubsub.subscription(SUBSCRIPTION_NAME);
const prisma = new PrismaClient();

// ── Message Handler ──────────────────────────────────────────────────
async function handleMessage(message: Message): Promise<void> {
    const rootStart = Date.now();
    let traceId = '';
    let rootSpanId = randomUUID();

    try {
        // 1. Log incoming message ID & parse the data
        const data = JSON.parse(message.data.toString());
        console.log(`📩 Received message ${message.id}`);
        console.log('   Data:', JSON.stringify(data, null, 2));

        // 2. Trace Injection (Week 8)
        //    Use existing traceId from the message attributes/data, or generate a new one
        traceId =
            message.attributes?.traceId || data.traceId || randomUUID();

        if (message.attributes?.traceId || data.traceId) {
            console.log(`🔗 Trace ID (inherited): ${traceId}`);
        } else {
            console.log(`🆕 Trace ID (generated): ${traceId}`);
        }

        // FRS: Record root span for message processing
        await prisma.traceSpan.create({
            data: {
                id: rootSpanId,
                traceId,
                service: 'orchestrator',
                operation: 'process_message',
                metadata: { messageId: message.id },
            },
        });

        // 2b. Handle RESUME signals from the HITL approval flow
        if (data.type === 'RESUME') {
            console.log(`🚀 RESUMING AGENT for Task ${data.taskId}! Executing tool call...`);

            // FRS: Cost Accounting — log token usage for the resume action
            if (data.agentId) {
                await prisma.usageLog.create({
                    data: {
                        agentId: data.agentId,
                        action: 'resume',
                        tokens: 50,
                        costUsd: 0.0005,
                        metadata: { taskId: data.taskId, traceId },
                    },
                });
                console.log(`💰 Logged 50 tokens for agent ${data.agentId} (resume)`);
            }

            // FRS: Record resume span
            await prisma.traceSpan.create({
                data: {
                    traceId,
                    parentId: rootSpanId,
                    service: 'orchestrator',
                    operation: 'resume_agent',
                    durationMs: Date.now() - rootStart,
                    metadata: { taskId: data.taskId },
                },
            });

            // Update root span duration
            await prisma.traceSpan.update({
                where: { id: rootSpanId },
                data: { durationMs: Date.now() - rootStart },
            });

            message.ack();
            console.log(`✅ Message ${message.id} acknowledged.\n`);
            return;
        }

        // 3. Agent Lookup — match the message source to an Agent role
        const agentLookupStart = Date.now();
        const source: string = data.source || 'unknown';
        const agent = await prisma.agent.findFirst({
            where: { role: source },
        });

        // FRS: Record agent_lookup span
        await prisma.traceSpan.create({
            data: {
                traceId,
                parentId: rootSpanId,
                service: 'orchestrator',
                operation: 'agent_lookup',
                durationMs: Date.now() - agentLookupStart,
                metadata: { source, found: !!agent },
            },
        });

        if (agent) {
            console.log(`🎯 Found Agent: ${agent.name} (ID: ${agent.id})`);

            // 4. Create a Task for HITL governance — awaits human approval
            const taskCreateStart = Date.now();
            const task = await prisma.task.create({
                data: {
                    description: `Signal from ${source}: ${JSON.stringify(data.payload ?? data)}`,
                    inputPayload: data,
                    agentId: agent.id,
                },
            });
            console.log(`📝 Created Task ${task.id} - Waiting for Approval`);

            // FRS: Record task_create span
            await prisma.traceSpan.create({
                data: {
                    traceId,
                    parentId: rootSpanId,
                    service: 'orchestrator',
                    operation: 'task_create',
                    durationMs: Date.now() - taskCreateStart,
                    metadata: { taskId: task.id, agentName: agent.name },
                },
            });

            // FRS: Cost Accounting — log token usage for the tool call
            await prisma.usageLog.create({
                data: {
                    agentId: agent.id,
                    action: 'tool_call',
                    tokens: 120,
                    costUsd: 0.0012,
                    metadata: { taskId: task.id, source, traceId },
                },
            });
            console.log(`💰 Logged 120 tokens for agent ${agent.name} (tool_call)`);
        } else {
            console.log(`⚠️ No agent found for source: ${source}`);
        }

        // Update root span duration
        await prisma.traceSpan.update({
            where: { id: rootSpanId },
            data: { durationMs: Date.now() - rootStart },
        });

        // 5. Acknowledge the message so it is not redelivered
        message.ack();
        console.log(`✅ Message ${message.id} acknowledged.\n`);
    } catch (err) {
        console.error(`⚠️  Error processing message ${message.id}:`, err);
        // Record error span
        if (traceId) {
            await prisma.traceSpan.update({
                where: { id: rootSpanId },
                data: { status: 'ERROR', durationMs: Date.now() - rootStart },
            }).catch(() => { });
        }
        // Still acknowledge to prevent infinite redelivery of a bad message.
        // In production you might nack() or send to a dead-letter topic instead.
        message.ack();
    }
}

// ── Error Handler ────────────────────────────────────────────────────
subscription.on('error', (err: Error) => {
    console.error('🚨 Subscription error (not crashing):', err.message);
});

// ── Start Listening ──────────────────────────────────────────────────
subscription.on('message', handleMessage);

console.log('──────────────────────────────────────────────');
console.log('🚀 EGAP Orchestrator Worker is running');
console.log(`   PROJECT_ID        : ${PROJECT_ID}`);
console.log(`   SUBSCRIPTION_NAME : ${SUBSCRIPTION_NAME}`);
console.log('   Listening for messages…');
console.log('──────────────────────────────────────────────');
