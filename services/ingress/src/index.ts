import Fastify from 'fastify';
import { PubSub } from '@google-cloud/pubsub';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

// ── Config ───────────────────────────────────────────────────────────
dotenv.config();

const PROJECT_ID = process.env.PROJECT_ID;
const TOPIC_NAME = process.env.TOPIC_NAME;
const PORT = Number(process.env.PORT) || 8080;

if (!PROJECT_ID || !TOPIC_NAME) {
    console.error('❌ Missing required env vars: PROJECT_ID and TOPIC_NAME must be set in .env');
    process.exit(1);
}

// ── Clients ──────────────────────────────────────────────────────────
const fastify = Fastify({ logger: true });
const pubsub = new PubSub({ projectId: PROJECT_ID });
const topic = pubsub.topic(TOPIC_NAME);
const prisma = new PrismaClient();

// ── FRS Ingress Audit Counter ────────────────────────────────────────
const auditCounters = {
    totalReceived: 0,
    totalPublished: 0,
    totalFailed: 0,
    startedAt: new Date().toISOString(),
};

// ── Types ────────────────────────────────────────────────────────────
interface WebhookBody {
    source: string;
    payload: Record<string, unknown>;
}

// ── Routes ───────────────────────────────────────────────────────────

/** Health check */
fastify.get('/health', async () => {
    return { status: 'ok', service: 'egap-ingress' };
});

/** Audit stats endpoint — FRS Ingress Audit Counter */
fastify.get('/api/stats', async () => {
    return {
        ...auditCounters,
        uptime: `${Math.floor((Date.now() - new Date(auditCounters.startedAt).getTime()) / 1000)}s`,
    };
});

/** Webhook ingestion endpoint */
fastify.post<{ Body: WebhookBody }>('/webhook', async (request, reply) => {
    const rootStart = Date.now();
    const body = request.body;

    // Validate required fields
    if (!body || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }

    // FRS: Increment audit counter
    auditCounters.totalReceived++;

    // FRS: Generate traceId for this request flow
    const traceId = randomUUID();

    const source: string = body.source || 'unknown';
    const payload: Record<string, unknown> = body.payload || body;

    // FRS: Record root span for webhook receive
    const rootSpanId = randomUUID();
    await prisma.traceSpan.create({
        data: {
            id: rootSpanId,
            traceId,
            service: 'ingress',
            operation: 'webhook_receive',
            metadata: { source },
        },
    });

    // Build the Pub/Sub message
    const message = {
        source,
        payload,
        traceId,
        receivedAt: new Date().toISOString(),
    };

    const dataBuffer = Buffer.from(JSON.stringify(message));

    try {
        const pubsubStart = Date.now();
        const messageId = await topic.publishMessage({
            data: dataBuffer,
            attributes: { traceId },
        });
        auditCounters.totalPublished++;

        // FRS: Record pubsub_publish span
        await prisma.traceSpan.create({
            data: {
                traceId,
                parentId: rootSpanId,
                service: 'ingress',
                operation: 'pubsub_publish',
                durationMs: Date.now() - pubsubStart,
                metadata: { messageId, topic: TOPIC_NAME },
            },
        });

        // Update root span duration
        await prisma.traceSpan.update({
            where: { id: rootSpanId },
            data: { durationMs: Date.now() - rootStart },
        });

        fastify.log.info(
            { messageId, source, traceId, audit: auditCounters },
            'Published to Pub/Sub',
        );

        return reply.status(200).send({
            status: 'queued',
            messageId,
            traceId,
        });
    } catch (err) {
        auditCounters.totalFailed++;

        // FRS: Record error on root span
        await prisma.traceSpan.update({
            where: { id: rootSpanId },
            data: { status: 'ERROR', durationMs: Date.now() - rootStart },
        }).catch(() => { });

        fastify.log.error({ err, source, audit: auditCounters }, 'Failed to publish to Pub/Sub');
        return reply.status(500).send({ error: 'Failed to queue message' });
    }
});

// ── Start ────────────────────────────────────────────────────────────
async function start() {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`🚀 EGAP Ingress Gateway listening on http://0.0.0.0:${PORT}`);
        console.log(`   PROJECT_ID : ${PROJECT_ID}`);
        console.log(`   TOPIC_NAME : ${TOPIC_NAME}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
}

start();
