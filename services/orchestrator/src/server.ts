import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

// ── ESM __dirname ────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Clients ──────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const app = Fastify({ logger: true });

// ── Static Files ─────────────────────────────────────────────────────
app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
});

// ── API Routes ───────────────────────────────────────────────────────
app.get('/api/agents', async (_request, _reply) => {
    const agents = await prisma.agent.findMany({
        include: { tools: true },
    });
    return agents;
});

// ── Start Server ─────────────────────────────────────────────────────
const start = async () => {
    try {
        await app.listen({ port: 3001, host: '0.0.0.0' });
        console.log('──────────────────────────────────────────────');
        console.log('🖥️  EGAP Command Center is running');
        console.log('   Dashboard : http://localhost:3001');
        console.log('   API       : http://localhost:3001/api/agents');
        console.log('──────────────────────────────────────────────');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
