import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT) || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../client/dist')));

// Health check - returns 200 immediately, no DB dependency
app.get('/', (req, res) => {
    res.send('Health Check OK');
});

// GET /api/tools - Return all available tools from the database
app.get('/api/tools', async (req, res) => {
    try {
        const tools = await prisma.tool.findMany();
        res.json(tools);
    } catch (error) {
        console.error('Error fetching tools:', error);
        res.status(500).json({ error: 'Failed to fetch tools' });
    }
});

// POST /api/agents - Create a new agent
app.post('/api/agents', async (req, res) => {
    try {
        const { name, role, goal, systemPrompt, tools } = req.body;

        const agent = await prisma.agent.create({
            data: {
                name,
                role,
                goal,
                systemPrompt,
                tools: {
                    connect: tools.map((id: string) => ({ id }))
                }
            },
            include: {
                tools: true
            }
        });

        console.log(`Created agent: ${agent.name}`);
        res.status(201).json(agent);
    } catch (error) {
        console.error('Error creating agent:', error);
        res.status(500).json({ error: 'Failed to create agent' });
    }
});

// GET /.well-known/agent.json — FRS Agent Card for runtime discovery
app.get('/.well-known/agent.json', async (req, res) => {
    try {
        const agents = await prisma.agent.findMany({ include: { tools: true } });
        res.json({
            name: 'EGAP Factory',
            version: '0.1.0',
            description: 'Enterprise-Grade Agentic Platform — Agent Building Service',
            capabilities: ['agent-creation', 'tool-management', 'deployment'],
            agents: agents.map(a => ({
                id: a.id,
                name: a.name,
                role: a.role,
                goal: a.goal,
                tools: a.tools.map(t => t.name),
            })),
        });
    } catch (error) {
        console.error('Error building agent card:', error);
        res.status(500).json({ error: 'Failed to build agent card' });
    }
});

// POST /api/deploy — Trigger Cloud Build to deploy the factory to Cloud Run
app.post('/api/deploy', async (req, res) => {
    try {
        const { exec } = await import('child_process');
        const projectId = process.env.PROJECT_ID || 'gls-training-486405';

        console.log('🚀 Triggering Cloud Build deployment...');

        exec(
            `gcloud builds submit --config cloudbuild.yaml --project ${projectId} .`,
            { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 10 },
            (error, stdout, stderr) => {
                if (error) {
                    console.error('❌ Cloud Build failed:', error.message);
                    // Don't send response here — it was already sent
                    return;
                }
                console.log('✅ Cloud Build completed:', stdout);
            }
        );

        // Return immediately — build runs in background
        res.status(202).json({
            status: 'BUILDING',
            message: 'Cloud Build triggered. Deployment in progress.',
            project: projectId,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error triggering deploy:', error);
        res.status(500).json({ error: 'Failed to trigger deployment' });
    }
});

// Catch-all route - serve React app for any unknown requests (React Router support)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

// Background database connection - non-blocking
async function startDatabase() {
    try {
        await prisma.$connect();
        console.log('✅ Database connected successfully');
    } catch (err) {
        console.error('⚠️ Database connection failed:', err);
        console.log('Server is running but database is unavailable. Retrying is handled by Prisma on next query.');
    }
}

// Start server IMMEDIATELY - Cloud Run health checks pass right away
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Factory API running on http://0.0.0.0:${PORT}`);
    // Connect to database in the background AFTER server is listening
    startDatabase();
});
