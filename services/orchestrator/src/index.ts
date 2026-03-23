
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { PubSub, Message } from '@google-cloud/pubsub';
import { Storage } from '@google-cloud/storage';
import { PrismaClient } from '@prisma/client';
import { CloudBuildClient } from '@google-cloud/cloudbuild';
import { ReasoningEngineServiceClient, ReasoningEngineExecutionServiceClient } from '@google-cloud/aiplatform';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';
import fastifyWebsocket from '@fastify/websocket';
import nodemailer from 'nodemailer';
import { initTracing, createSpan, recordThoughtTrace, endSpanOk, endSpanWithError } from './tracing.js';

// Initialize Cloud Trace (Architecture Spec: AgentOps Observability)
initTracing();

const execPromise = util.promisify(exec);

// ── Config ───────────────────────────────────────────────────────────
dotenv.config();

// Override DATABASE_URL for Cloud Run / Cloud SQL unix socket
if (process.env.DB_SOCKET_PATH && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME) {
    process.env.DATABASE_URL = `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@localhost/${process.env.DB_NAME}?host=${process.env.DB_SOCKET_PATH}`;
}

const PROJECT_ID = process.env.PROJECT_ID || 'gls-training-486405';
const SUBSCRIPTION_NAME = process.env.SUBSCRIPTION_NAME;
const TOPIC_NAME = process.env.TOPIC_NAME;
const LOCATION = 'asia-south1';
const MODEL_NAME = 'gemini-2.5-flash';
const PORT = parseInt(process.env.PORT || '3000', 10);
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

if (!SUBSCRIPTION_NAME || !TOPIC_NAME) {
    console.error('❌ Missing required env vars: SUBSCRIPTION_NAME and TOPIC_NAME must be set in .env');
    process.exit(1);
}

// ── ESM __dirname ────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Clients ──────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const pubsub = new PubSub({ projectId: PROJECT_ID });
const storage = new Storage({ projectId: PROJECT_ID });
const cbClient = new CloudBuildClient();
const reasoningClient = new ReasoningEngineExecutionServiceClient({
    apiEndpoint: 'us-central1-aiplatform.googleapis.com',
});
const genAI = new GoogleGenAI({
    project: PROJECT_ID,
    location: LOCATION,
    vertexai: true,
});
const subscription = pubsub.subscription(SUBSCRIPTION_NAME);
const topic = pubsub.topic(TOPIC_NAME);

const app = Fastify({ logger: true });

// ── Middleware ───────────────────────────────────────────────────────
app.register(fastifyCors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
});

app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
});

// ── WebSockets ───────────────────────────────────────────────────────
app.register(fastifyWebsocket);

// Store active connections by agentId (or a unique session ID later)
const activeConnections = new Map<string, any>();

app.register(async function (fastify) {
    // @ts-ignore
    fastify.get('/ws', { websocket: true }, (connection, req) => {
        const agentId = (req.query as any).agentId;
        if (agentId) {
            console.log(`🔌 WebSocket connected for agent: ${agentId}`);
            activeConnections.set(agentId, connection);

            connection.on('close', () => {
                console.log(`🔌 WebSocket disconnected for agent: ${agentId}`);
                activeConnections.delete(agentId);
            });
        } else {
            connection.close();
        }
    });
});

// SPA Fallback: Serve index.html for any 404 that isn't an API call
app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
    }
    reply.status(404).send({ error: 'Not Found', message: `Route ${req.method}:${req.url} not found` });
});

// ── Types ────────────────────────────────────────────────────────────
interface AgentPayload {
    name: string;
    role: string;
    goal: string;
    systemPrompt: string;
    tools: string[];
    budgetUsd?: number;
}

interface ChatPayload {
    agentId: string;
    message: string;
}

/**
 * GET /api/tools
 * List all available tools from the database
 */
app.get('/api/tools', async (_request, _reply) => {
    return await prisma.tool.findMany();
});

/**
 * POST /api/tools
 * Create a new tool blueprint
 */
app.post<{ Body: { name: string, description: string, parameters: any } }>('/api/tools', async (request, reply) => {
    const { name, description, parameters } = request.body;
    try {
        const tool = await prisma.tool.create({
            data: {
                name,
                description,
                configuration: { parameters }
            }
        });
        return reply.status(201).send(tool);
    } catch (err: any) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to create tool' });
    }
});

/**
 * GET /.well-known/agent.json
 * A2A Protocol: Dynamic Agent Card Manifest
 * Returns an A2A-compliant manifest of all deployed agents with their capabilities.
 */
app.get('/.well-known/agent.json', async (_request, _reply) => {
    const agents = await prisma.agent.findMany({
        include: { tools: true, deployments: true },
    });

    const agentCards = agents.map((agent: any) => {
        const activeDeployment = agent.deployments?.find((d: any) => d.status === 'ACTIVE');
        return {
            // Core fields (needed by frontend)
            id: agent.id,
            // A2A Agent Card fields
            name: agent.name,
            role: agent.role,
            goal: agent.goal,
            systemPrompt: agent.systemPrompt,
            isActive: agent.isActive,
            currentVersion: agent.currentVersion,
            budgetUsd: agent.budgetUsd,
            description: `${agent.role} — ${agent.goal}`,
            url: activeDeployment?.serviceUrl || null,
            version: `v${agent.currentVersion}`,
            protocols: ['a2a/1.0', 'mcp/1.0'],
            capabilities: {
                tools: agent.tools.map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    actionType: t.actionType || 'READ',
                    mcpServerUrl: t.mcpServerUrl || null,
                })),
                hitl: agent.tools.some((t: any) => t.actionType === 'WRITE'),
            },
            // Flatten tools for frontend compatibility
            tools: agent.tools.map((t: any) => t.name),
            status: agent.isActive ? 'ACTIVE' : 'INACTIVE',
            adkResourceName: agent.adkResourceName || null,
            endpoints: {
                chat: `/api/chat`,
                resume: `/api/agents/${agent.id}/resume`,
                card: `/api/agents/${agent.id}/card`,
            },
        };
    });

    return {
        protocol: 'a2a/1.0',
        platform: 'GiantLeap Agentic Platform v2',
        agents: agentCards,
    };
});

/**
 * GET /api/agents/:id/card
 * A2A Protocol: Individual Agent Card
 */
app.get<{ Params: { id: string } }>('/api/agents/:id/card', async (request, reply) => {
    const agent = await prisma.agent.findUnique({
        where: { id: request.params.id },
        include: { tools: true, deployments: true },
    });
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const activeDeployment = agent.deployments?.find((d: any) => d.status === 'ACTIVE');
    return {
        protocol: 'a2a/1.0',
        name: agent.name,
        description: `${agent.role} — ${agent.goal}`,
        url: activeDeployment?.serviceUrl || null,
        version: `v${agent.currentVersion}`,
        capabilities: {
            tools: agent.tools.map((t: any) => ({
                name: t.name,
                actionType: t.actionType || 'READ',
            })),
            hitl: agent.tools.some((t: any) => t.actionType === 'WRITE'),
        },
        status: agent.isActive ? 'ACTIVE' : 'INACTIVE',
    };
});

/**
 * POST /api/agents/:id/resume
 * A2A Protocol: Resume a suspended agent after HITL approval.
 * Spec: "ACC sends POST /resume. Agent wakes up, loads previous state,
 *        injects human input, and continues."
 */
app.post<{ Params: { id: string }; Body: { taskId: string; feedback?: string } }>('/api/agents/:id/resume', async (request, reply) => {
    const { id } = request.params;
    const { taskId, feedback } = request.body;

    try {
        // 1. Approve the task
        const task = await prisma.task.update({
            where: { id: taskId },
            data: { status: 'APPROVED' },
            include: { agent: true },
        });

        // 2. Execute the approved action (same inline execution as before)
        const taskPayload = task.inputPayload as any;
        let toolOutput = '';

        if (taskPayload) {
            const emailRecipient = taskPayload.to_email || taskPayload.recipient || taskPayload.to;
            const emailBody = taskPayload.body || taskPayload.message;

            if (emailRecipient && taskPayload.subject && emailBody) {
                console.log(`📧 A2A Resume: Sending email to ${emailRecipient}...`);
                try {
                    const transporter = nodemailer.createTransport({
                        service: 'gmail',
                        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
                    });
                    await transporter.sendMail({
                        from: `"EGAP Agent" <${GMAIL_USER}>`,
                        to: emailRecipient,
                        subject: taskPayload.subject,
                        text: emailBody,
                        html: `<div style="font-family: sans-serif; padding: 20px;">
                            <h2 style="color: #7c3aed;">📩 EGAP Agent Email</h2>
                            <hr style="border-color: #e5e7eb;" />
                            <p>${emailBody.replace(/\n/g, '<br>')}</p>
                            <hr style="border-color: #e5e7eb;" />
                            <p style="color: #9ca3af; font-size: 12px;">Sent via A2A Resume protocol.</p>
                        </div>`,
                    });
                    toolOutput = `[System] ✅ Email sent to ${emailRecipient} (via A2A Resume)`;
                } catch (emailErr: any) {
                    toolOutput = `[System] ❌ Email failed: ${emailErr.message}`;
                }
            } else {
                toolOutput = `[System] ✅ Approved action executed: ${JSON.stringify(taskPayload)}`;
            }
        } else {
            toolOutput = `[System] ✅ Task approved (no payload).`;
        }

        // 3. Mark task as completed
        await prisma.task.update({ where: { id: taskId }, data: { status: 'COMPLETED' } });

        // 4. Log the feedback/result in chat
        await prisma.message.create({
            data: {
                agentId: id,
                role: 'assistant',
                content: feedback ? `[A2A Resume] Human feedback: ${feedback}\n${toolOutput}` : toolOutput,
            },
        });

        console.log(`✅ A2A Resume completed for Agent ${id}, Task ${taskId}`);

        return reply.send({
            protocol: 'a2a/1.0',
            status: 'COMPLETED',
            taskId,
            executionResult: toolOutput,
        });
    } catch (err: any) {
        console.error('❌ A2A Resume failed:', err);
        return reply.status(500).send({ error: 'A2A Resume failed' });
    }
});

/**
 * GET /api/agents
 * List all agents with tools
 */
app.get('/api/agents', async (_request, _reply) => {
    const agents = await prisma.agent.findMany({
        include: { tools: true },
    });
    return agents;
});

/**
 * POST /api/agents
 * Create a new agent (Blueprint)
 */
app.post<{ Body: AgentPayload }>('/api/agents', async (request, reply) => {
    const { name, role, goal, systemPrompt, tools, budgetUsd } = request.body;

    try {
        const agent = await prisma.agent.create({
            data: {
                name,
                role,
                goal,
                systemPrompt,
                budgetUsd: budgetUsd ?? 5.0,
                tools: {
                    connectOrCreate: tools.map((toolId) => ({
                        where: { name: toolId },
                        create: {
                            name: toolId,
                            description: 'Auto-created tool stub',
                        },
                    })),
                },
            },
        });

        // --- VERTEX AI REASONING ENGINE ROUTING (ADK) ---
        console.log(`🚀 Deploying ADK Agent to Vertex AI Reasoning Engine: ${name}`);

        try {
            const scriptPath = path.join(__dirname, 'adk_deployer.py');
            const payload = JSON.stringify({
                id: agent.id,
                name: name,
                role: role,
                goal: goal,
                systemPrompt: systemPrompt,
                tools: tools, // Pass tool names to ADK deployer
            });

            console.log(`⏳ Submitting ADK deployment script. This will take 3-5 minutes...`);

            // Execute python script using venv
            const pythonExecutable = path.join(__dirname, '..', 'venv', 'bin', 'python3');
            const { stdout, stderr } = await execPromise(`"${pythonExecutable}" "${scriptPath}" '${payload.replace(/'/g, "'\\''")}'`);

            if (stderr && stderr.includes('Error')) {
                console.error("ADK Deploy Error:", stderr);
            }

            // The resource_name is printed as the last line by the Python script
            const stdoutLines = stdout.trim().split('\n');
            let resourceName = stdoutLines.pop()?.trim() || "";

            if (resourceName && resourceName.startsWith("projects/")) {
                console.log(`☁️ ADK Reasoning Engine deployed successfully: ${resourceName}`);
            } else {
                console.error(`❌ Python script did not return a valid resource_name: ${resourceName}`);
                // Attempt to find it in stdout just in case
                const match = stdout.match(/projects\/\d+\/locations\/[\w-]+\/reasoningEngines\/\d+/);
                if (match) {
                    resourceName = match[0];
                    console.log(`☁️ Recovered ADK Reasoning Engine ID: ${resourceName}`);
                } else {
                    throw new Error(`Invalid output from Python script. Stdout: ${stdout}`);
                }
            }

            await prisma.deployment.create({
                data: {
                    agentId: agent.id,
                    status: 'ACTIVE',
                    serviceUrl: resourceName
                }
            });

            // Store ADK resource name on Agent model (Architecture Spec)
            await prisma.agent.update({
                where: { id: agent.id },
                data: { adkResourceName: resourceName } as any
            });

        } catch (cxErr: any) {
            console.error('❌ Vertex AI Agent Engine Error:', cxErr.message || cxErr);
            // Mark deployment as failed but don't crash
            await prisma.deployment.create({
                data: {
                    agentId: agent.id,
                    status: 'FAILED',
                    serviceUrl: null
                }
            }).catch(console.error);
        }

        return reply.status(201).send(agent);
    } catch (err: any) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to create agent' });
    }
});

/**
 * POST /api/agents/:id/redeploy
 * Re-trigger ADK deployment for an existing agent to Vertex AI Agent Engine.
 * Useful when a previous deployment failed or adkResourceName is null.
 *
 * NOTE: This is intentionally SYNCHRONOUS — the HTTP connection stays open
 * during the 3-5 minute Vertex AI deployment, keeping the Cloud Run container alive.
 * The caller should expect a 200 response after ~3-5 minutes.
 */
app.post<{ Params: { id: string } }>('/api/agents/:id/redeploy', async (request, reply) => {
    const { id } = request.params;

    try {
        const agent = await prisma.agent.findUnique({
            where: { id },
            include: { tools: true },
        });

        if (!agent) {
            return reply.status(404).send({ error: 'Agent not found' });
        }

        const toolNames = agent.tools.map((t: any) => t.name);

        console.log(`🔄 Re-deploying ADK Agent to Vertex AI: ${agent.name} (id=${id})`);
        console.log(`⏳ Deploying... will take 3-5 minutes. HTTP connection held open.`);

        // SYNCHRONOUS — await the full deployment so Cloud Run container stays alive
        const scriptPath = path.join(__dirname, 'adk_deployer.py');
        const payload = JSON.stringify({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            goal: agent.goal,
            systemPrompt: agent.systemPrompt,
            tools: toolNames,
        });

        let resourceName = '';
        try {
            const pythonExecutable = path.join(__dirname, '..', 'venv', 'bin', 'python3');
            const { stdout, stderr } = await execPromise(
                `"${pythonExecutable}" "${scriptPath}" '${payload.replace(/'/g, "'\\''")}'`,
                { timeout: 600_000 } // 10 minutes max
            );

            if (stderr) console.log('ADK Redeploy stderr:', stderr.slice(0, 500));

            const stdoutLines = stdout.trim().split('\n');
            resourceName = stdoutLines.pop()?.trim() || '';

            if (!resourceName.startsWith('projects/')) {
                const match = stdout.match(/projects\/\d+\/locations\/[\w-]+\/reasoningEngines\/\d+/);
                resourceName = match ? match[0] : '';
            }
        } catch (deployErr: any) {
            console.error('❌ ADK Deploy script error:', deployErr.message || deployErr);
            await prisma.deployment.create({
                data: { agentId: agent.id, status: 'FAILED', serviceUrl: null },
            }).catch(console.error);
            return reply.status(500).send({
                error: 'Vertex AI deployment failed',
                details: deployErr.message,
            });
        }

        if (resourceName) {
            // Update existing deployment or create new one
            const existing = await prisma.deployment.findFirst({ where: { agentId: agent.id } });
            if (existing) {
                await prisma.deployment.update({
                    where: { id: existing.id },
                    data: { status: 'ACTIVE', serviceUrl: resourceName },
                }).catch(console.error);
            } else {
                await prisma.deployment.create({
                    data: { agentId: agent.id, status: 'ACTIVE', serviceUrl: resourceName },
                }).catch(console.error);
            }

            await prisma.agent.update({
                where: { id: agent.id },
                data: { adkResourceName: resourceName } as any,
            });

            console.log(`☁️ Re-deployed ${agent.name}: ${resourceName}`);
            return reply.status(200).send({
                status: 'deployed',
                agentName: agent.name,
                adkResourceName: resourceName,
            });
        } else {
            await prisma.deployment.create({
                data: { agentId: agent.id, status: 'FAILED', serviceUrl: null },
            }).catch(console.error);
            return reply.status(500).send({ error: 'Deployment failed — no resource name returned from script' });
        }

    } catch (err: any) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to initiate redeploy' });
    }
});





/**
 * PUT /api/agents/:id
 * Update an existing agent blueprint
 */
app.put<{ Params: { id: string }, Body: AgentPayload }>('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, role, goal, systemPrompt, tools, budgetUsd } = request.body;

    try {
        // ── VERSIONING: Snapshot current state before updating ──
        const current = await prisma.agent.findUnique({
            where: { id },
            include: { tools: true }
        });

        if (current) {
            await prisma.agentVersion.create({
                data: {
                    agentId: id,
                    version: current.currentVersion,
                    name: current.name,
                    role: current.role,
                    goal: current.goal,
                    systemPrompt: current.systemPrompt,
                    toolNames: current.tools.map(t => t.name),
                    changedBy: 'admin',
                }
            });
        }

        const agent = await prisma.agent.update({
            where: { id },
            data: {
                name,
                role,
                goal,
                systemPrompt,
                currentVersion: (current?.currentVersion || 1) + 1,
                ...(budgetUsd !== undefined ? { budgetUsd } : {}),
                tools: {
                    set: [], // Clear existing relations
                    connectOrCreate: tools.map((toolId) => ({
                        where: { name: toolId },
                        create: { name: toolId, description: 'Auto-created tool stub' },
                    })),
                },
            },
            include: { tools: true }
        });
        return reply.send(agent);
    } catch (err: any) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to update agent' });
    }
});

/**
 * DELETE /api/agents/:id
 * Delete an agent blueprint and its relations
 */
app.delete<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    try {
        // Must delete related records first
        await prisma.message.deleteMany({ where: { agentId: id } });
        await prisma.task.deleteMany({ where: { agentId: id } });
        await prisma.usageLog.deleteMany({ where: { agentId: id } });
        await prisma.deployment.deleteMany({ where: { agentId: id } });

        await prisma.agent.delete({ where: { id } });
        return { success: true };
    } catch (err: any) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to delete agent' });
    }
});

/**
 * GET /api/agents/:id/versions
 * Fetch version history for an agent
 */
app.get<{ Params: { id: string } }>('/api/agents/:id/versions', async (request, _reply) => {
    const { id } = request.params;
    const versions = await prisma.agentVersion.findMany({
        where: { agentId: id },
        orderBy: { version: 'desc' }
    });
    return versions;
});

/**
 * POST /api/agents/:id/rollback/:version
 * Rollback an agent to a previous version
 */
app.post<{ Params: { id: string; version: string } }>('/api/agents/:id/rollback/:version', async (request, reply) => {
    const { id, version } = request.params;
    const versionNum = parseInt(version, 10);

    try {
        const snapshot = await prisma.agentVersion.findUnique({
            where: { agentId_version: { agentId: id, version: versionNum } }
        });

        if (!snapshot) {
            return reply.status(404).send({ error: 'Version not found' });
        }

        // Snapshot current state first
        const current = await prisma.agent.findUnique({
            where: { id },
            include: { tools: true }
        });

        if (current) {
            await prisma.agentVersion.create({
                data: {
                    agentId: id,
                    version: current.currentVersion,
                    name: current.name,
                    role: current.role,
                    goal: current.goal,
                    systemPrompt: current.systemPrompt,
                    toolNames: current.tools.map(t => t.name),
                    changedBy: 'admin (rollback)',
                }
            });
        }

        // Restore agent to the snapshot
        const agent = await prisma.agent.update({
            where: { id },
            data: {
                name: snapshot.name,
                role: snapshot.role,
                goal: snapshot.goal,
                systemPrompt: snapshot.systemPrompt,
                currentVersion: (current?.currentVersion || 1) + 1,
                tools: {
                    set: [],
                    connectOrCreate: snapshot.toolNames.map((toolName) => ({
                        where: { name: toolName },
                        create: { name: toolName, description: 'Auto-created tool stub' },
                    })),
                },
            },
            include: { tools: true }
        });

        return reply.send({ success: true, agent, restoredFromVersion: versionNum });
    } catch (err: any) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to rollback agent' });
    }
});

/**
 * POST /api/agents/:id/reactivate
 * Reactivate a shutdown agent (resets isActive to true)
 */
app.post<{ Params: { id: string } }>('/api/agents/:id/reactivate', async (request, reply) => {
    const { id } = request.params;
    try {
        const agent = await prisma.agent.update({
            where: { id },
            data: { isActive: true }
        });
        return reply.send({ success: true, agent });
    } catch (err: any) {
        return reply.status(500).send({ error: 'Failed to reactivate agent' });
    }
});

/**
 * POST /api/chat
 * Send a message to an agent via Pub/Sub (Triggering Orchestrator Worker)
 */
app.post<{ Body: ChatPayload }>('/api/chat', async (request, reply) => {
    const { agentId, message } = request.body;

    if (!agentId || !message) {
        return reply.status(400).send({ error: 'Missing agentId or message' });
    }

    try {
        // Save User Message
        const userMsg = await prisma.message.create({
            data: {
                agentId,
                role: 'user',
                content: message,
            },
        });

        const traceId = randomUUID();

        // --- VERTEX AI REASONING ENGINE ROUTING (ADK) ---
        const deployment = await prisma.deployment.findFirst({
            where: { agentId },
            orderBy: { deployedAt: 'desc' },
        });

        // Check if the agent has tools — if so, ALWAYS use inline processing
        // because the Reasoning Engine doesn't support function calling / HITL
        const agentRecord = await prisma.agent.findUnique({
            where: { id: agentId },
            include: { tools: true },
        });
        const hasTools = agentRecord && agentRecord.tools && agentRecord.tools.length > 0;

        // Prefer adkResourceName (canonical, set on successful deploy) over
        // deployment.serviceUrl (can be null from stale FAILED records).
        const adkResource =
            (agentRecord as any)?.adkResourceName ||
            (deployment?.serviceUrl?.startsWith('projects/') ? deployment.serviceUrl : null);

        if (adkResource) {
            const agentPath = adkResource;

            console.log(`🌐 Routing chat to ADK Reasoning Engine: ${agentPath}`);

            try {
                const responseStream = await reasoningClient.streamQueryReasoningEngine({
                    name: agentPath,
                    classMethod: 'stream_query',
                    input: {
                        fields: {
                            session_id: { stringValue: '' }, // Empty = ADK auto-creates a new session (non-empty causes SessionNotFoundError)
                            user_id: { stringValue: 'orchestrator-user' },
                            message: { stringValue: message }
                        }
                    }
                });

                let replyText = '';
                for await (const chunk of responseStream as any) {
                    // chunk.data is a Buffer directly (not chunk.data.data)
                    if (chunk?.data && Buffer.isBuffer(chunk.data) && chunk.data.length > 0) {
                        try {
                            const decoded = chunk.data.toString('utf-8');
                            const eventJson = JSON.parse(decoded);
                            
                            // The agent response text is at content.parts[].text
                            if (eventJson.content?.parts) {
                                for (const part of eventJson.content.parts) {
                                    if (part.text) {
                                        replyText += part.text;
                                    }
                                }
                            }
                        } catch (e) {
                            // If not valid JSON, append raw text
                            replyText += chunk.data.toString('utf-8');
                        }
                    }
                }

                // If Vertex AI returned an empty stream, fall back to inline Gemini processing
                if (!replyText) {
                    console.log(`⚠️ Vertex AI stream returned empty for ${agentPath}. Falling back to inline Gemini...`);

                    const chatData = {
                        type: 'CHAT',
                        agentId,
                        message,
                        traceId,
                        dbMessageId: userMsg.id,
                    };

                    processChat(chatData).catch(err => {
                        console.error('❌ Inline fallback also failed:', err);
                        prisma.message.create({
                            data: {
                                agentId,
                                role: 'assistant',
                                content: '[System] ⚠️ Agent is temporarily unavailable. Please try again later.',
                            },
                        }).catch(console.error);
                    });

                    return { status: 'sent', messageId: traceId, userMessage: userMsg, routedTo: 'inline-fallback' };
                }

                // Clean up stringified double quotes if they exist
                if (replyText.startsWith('""') && replyText.endsWith('""')) {
                    replyText = replyText.slice(2, -2);
                } else if (replyText.startsWith('"') && replyText.endsWith('"')) {
                    replyText = replyText.slice(1, -1);
                }

                // If the stream threw a Python exception stack trace inline without failing grpc
                if (replyText.includes('Traceback (most recent call last)')) {
                    console.error("Agent engine returned a stack trace:", replyText);
                    replyText = "The agent encountered an error during execution.";
                }

                // ── HYBRID HITL: Detect tool usage from Agent Engine text response ──
                // The Agent Engine executes tools internally and returns only text.
                // We scan the response for email-sending patterns and create HITL tasks locally.
                const hasSendEmailTool = hasTools && agentRecord!.tools.some((t: any) => t.name === 'send_email');
                // Broader pattern: detect phrases like "sent the email", "email sent", "I've sent the email", etc.
                const emailSentPattern = /(?:sent|send|sending|delivered|dispatched).*?(?:email|mail|message)|(?:email|mail|message).*?(?:sent|send|sending|delivered|dispatched)/i;
                const emailDetected = hasSendEmailTool && emailSentPattern.test(replyText);

                if (emailDetected) {
                    console.log(`🔒 HYBRID HITL: Detected email send in Agent Engine response`);
                    console.log(`   Response text: "${replyText}"`);
                    console.log(`   User message: "${message}"`);

                    // Extract email parameters from USER MESSAGE (not the response, since the agent
                    // often just says "I sent the email" without including the address)
                    const toMatch = message.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
                        || replyText.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
                    const subjectMatch = message.match(/subject[:\s]+["']?([^"',]+)["']?/i) 
                        || replyText.match(/subject\s+["']([^"']+)["']/i);
                    const bodyMatch = message.match(/body[:\s]+["']?([^"',]+)["']?/i)
                        || replyText.match(/body\s+["']([^"']+)["']/i);

                    const emailTo = toMatch?.[1] || 'unknown';
                    const emailSubject = subjectMatch?.[1] || '(no subject)';
                    const emailBody = bodyMatch?.[1] || '(no body)';

                    // Create HITL task in the database
                    const task = await prisma.task.create({
                        data: {
                            description: `Agent wants to send email to ${emailTo}`,
                            status: 'PENDING',
                            agentId,
                            inputPayload: { to: emailTo, subject: emailSubject, body: emailBody },
                            traceId: traceId || null,
                        }
                    });

                    // Rewrite the response to a system HITL message
                    replyText = `[System] Usage of tool 'send_email' requires Admin Approval. Task ${task.id} created.`;

                    // Broadcast WebSocket notification to all connected clients
                    for (const [, socket] of activeConnections) {
                        try {
                            socket.send(JSON.stringify({
                                type: 'hitl_task_created',
                                task: {
                                    id: task.id,
                                    description: task.description,
                                    status: 'PENDING',
                                    agentId,
                                    agentName: agentRecord?.name || 'Agent',
                                }
                            }));
                        } catch (e) { /* ignore dead sockets */ }
                    }

                    console.log(`🔒 HITL Task ${task.id} created from Agent Engine response. Email to: ${emailTo}`);
                }

                // Save assistant message to DB so UI shows it
                await prisma.message.create({
                    data: {
                        agentId,
                        role: 'assistant',
                        content: replyText,
                    },
                });

                // ── USAGE TELEMETRY: Fallback Local Estimation ──
                // Estimate tokens: roughly 4 chars per token.
                const estimatedTokens = Math.ceil((message.length + replyText.length) / 4) || 0;
                // Gemini 2.5 Flash pricing is $0.075/1M input and $0.30/1M output. 
                // We use a blended average of $0.15 per 1M tokens for local UI estimation.
                const estimatedCost = estimatedTokens * 0.00000015;

                try {
                    console.log(`💰 Locally estimating tokens for ${agentPath}: ${estimatedTokens}. Writing to UsageLog.`);
                    await prisma.usageLog.create({
                        data: {
                            agentId,
                            tokens: estimatedTokens,
                            costUsd: estimatedCost,
                            action: 'chat_completion'
                        }
                    });
                } catch (e) {
                    console.error('⚠️ Failed to save token UsageLog', e);
                }

                return { status: 'sent', messageId: traceId, userMessage: userMsg, routedTo: agentPath };

            } catch (cxErr: any) {
                console.error(`❌ Failed to execute ADK Reasoning Engine ${agentPath}:`, cxErr.message || cxErr);
                console.log(`⚙️ Falling back to inline processing for ${agentId}...`);

                const chatData = {
                    type: 'CHAT',
                    agentId,
                    message,
                    traceId,
                    dbMessageId: userMsg.id,
                };

                processChat(chatData).catch(err => {
                    console.error('❌ Inline fallback also failed:', err);
                    
                    // As a final resort, save a system error message so the UI doesn't hang indefinitely 
                    prisma.message.create({
                        data: {
                            agentId,
                            role: 'assistant',
                            content: '[System] ⚠️ Agent is temporarily unavailable (all execution methods failed). Please try again later.'
                        }
                    }).catch(console.error);
                });

                return { status: 'sent', messageId: traceId, userMessage: userMsg, routedTo: 'inline-fallback' };
            }
        } else {
            // FALLBACK: No deployment URL found.
            console.log(`⚙️ No valid Managed Agent deployment for ${agentId}. Falling back to inline processing.`);

            const chatData = {
                type: 'CHAT',
                agentId,
                message,
                traceId,
                dbMessageId: userMsg.id,
            };

            processChat(chatData).catch(err => {
                console.error('❌ Inline chat processing error:', err);
                // Save fallback message so UI doesn't hang
                prisma.message.create({
                    data: {
                        agentId,
                        role: 'assistant',
                        content: '[System] ⚠️ Agent is temporarily unavailable. Please try again later.',
                    },
                }).catch(console.error);
            });

            return { status: 'sent', messageId: traceId, userMessage: userMsg, routedTo: 'inline' };
        }
    } catch (err) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to process chat' });
    }
});

/**
 * GET /api/agents/:id/messages
 * Fetch chat history for an agent
 */
app.get<{ Params: { id: string } }>('/api/agents/:id/messages', async (request, _reply) => {
    const { id } = request.params;
    const messages = await prisma.message.findMany({
        where: { agentId: id },
        orderBy: { createdAt: 'asc' },
    });
    return messages;
});

/**
 * DELETE /api/agents/:id/messages
 * Clear chat history for an agent
 */
app.delete<{ Params: { id: string } }>('/api/agents/:id/messages', async (request, reply) => {
    const { id } = request.params;
    try {
        await prisma.message.deleteMany({ where: { agentId: id } });
        return { success: true };
    } catch (err) {
        app.log.error(err);
        return reply.status(500).send({ error: 'Failed to clear chat history' });
    }
});

// ── COMMAND PLANE API ────────────────────────────────────────────────

// 1. SAFETY: Emergency Stop
app.get('/api/settings/emergency', async (_req, _rep) => {
    const setting = await prisma.globalSettings.findUnique({ where: { key: 'emergency_stop' } });
    return { active: setting?.value ? (setting.value as any).active : false };
});

app.post<{ Body: { active: boolean } }>('/api/settings/emergency', async (req, _rep) => {
    const { active } = req.body;
    const setting = await prisma.globalSettings.upsert({
        where: { key: 'emergency_stop' },
        update: { value: { active, updatedAt: new Date() } },
        create: { key: 'emergency_stop', value: { active, updatedAt: new Date() } }
    });
    return setting;
});

// 2. GOVERNANCE: HITL Tasks
app.get('/api/tasks', async (_req, _rep) => {
    return await prisma.task.findMany({
        where: { status: 'PENDING' },
        include: { agent: true },
        orderBy: { createdAt: 'desc' }
    });
});

app.post<{ Params: { id: string } }>('/api/tasks/:id/approve', async (req, rep) => {
    const { id } = req.params;
    try {
        const task = await prisma.task.update({
            where: { id },
            data: { status: 'APPROVED', actionedBy: 'admin', actionedAt: new Date() },
            include: { agent: true }
        });

        // ── AUDIT LOG ────────────────────────────────────────────────
        await prisma.auditLog.create({
            data: {
                action: 'APPROVE',
                entityType: 'TASK',
                entityId: id,
                performedBy: 'admin',
                details: { description: task.description, agentName: task.agent?.name },
            },
        });

        // ── INLINE EXECUTION: Execute the approved action directly ────
        // (Cloud Run scales to zero so Pub/Sub pull subscriptions are unreliable)
        const taskPayload = task.inputPayload as any;
        let toolOutput = '';

        if (taskPayload) {
            const emailRecipient = taskPayload.recipient || taskPayload.to;
            const emailBody = taskPayload.body || taskPayload.message;

            if (emailRecipient && taskPayload.subject && emailBody) {
                // Real email sending via Gmail SMTP
                console.log(`📧 Sending real email to ${emailRecipient}...`);
                try {
                    const transporter = nodemailer.createTransport({
                        service: 'gmail',
                        auth: {
                            user: GMAIL_USER,
                            pass: GMAIL_APP_PASSWORD,
                        },
                    });
                    await transporter.sendMail({
                        from: `"EGAP Agent" <${GMAIL_USER}>`,
                        to: emailRecipient,
                        subject: taskPayload.subject,
                        text: emailBody,
                        html: `<div style="font-family: sans-serif; padding: 20px;">
                            <h2 style="color: #7c3aed;">📩 EGAP Agent Email</h2>
                            <hr style="border-color: #e5e7eb;" />
                            <p>${emailBody.replace(/\n/g, '<br>')}</p>
                            <hr style="border-color: #e5e7eb;" />
                            <p style="color: #9ca3af; font-size: 12px;">Sent by EGAP Command Plane on behalf of an AI agent.</p>
                        </div>`,
                    });
                    console.log(`✅ Email successfully sent to ${emailRecipient}`);
                    toolOutput = `[System] ✅ Email successfully sent to ${emailRecipient}`;
                } catch (emailErr: any) {
                    console.error(`❌ Email sending failed:`, emailErr.message);
                    toolOutput = `[System] ❌ Email failed to send: ${emailErr.message}`;
                }
            } else {
                toolOutput = `[System] ✅ Approved action executed: ${JSON.stringify(taskPayload)}`;
            }
        } else {
            toolOutput = `[System] ✅ Task approved (no payload to execute).`;
        }

        // Update task to COMPLETED
        await prisma.task.update({
            where: { id },
            data: { status: 'COMPLETED' }
        });

        // Save confirmation message to chat
        if (task.agent) {
            await prisma.message.create({
                data: {
                    agentId: task.agentId,
                    role: 'assistant',
                    content: toolOutput
                }
            });
        }

        console.log(`📢 Task ${task.id} approved and executed inline (Agent: ${task.agent?.name})`);

        return { ...task, status: 'COMPLETED', executionResult: toolOutput };
    } catch (e) {
        console.error(e);
        return rep.status(404).send({ error: 'Task not found or failed to execute' });
    }
});

app.post<{ Params: { id: string } }>('/api/tasks/:id/reject', async (req, rep) => {
    const { id } = req.params;
    try {
        const task = await prisma.task.update({
            where: { id },
            data: { status: 'REJECTED', actionedBy: 'admin', actionedAt: new Date() },
            include: { agent: true }
        });

        // ── AUDIT LOG ────────────────────────────────────────────────
        await prisma.auditLog.create({
            data: {
                action: 'REJECT',
                entityType: 'TASK',
                entityId: id,
                performedBy: 'admin',
                details: { description: task.description, agentName: task.agent?.name },
            },
        });

        return task;
    } catch (e) {
        return rep.status(404).send({ error: 'Task not found' });
    }
});

// 2b. GOVERNANCE: Edit Task Payload Before Approval
app.put<{ Params: { id: string }, Body: { inputPayload?: any; description?: string } }>('/api/tasks/:id', async (req, rep) => {
    const { id } = req.params;
    const { inputPayload, description } = req.body;

    try {
        // Only allow editing PENDING tasks
        const existing = await prisma.task.findUnique({ where: { id } });
        if (!existing) {
            return rep.status(404).send({ error: 'Task not found' });
        }
        if (existing.status !== 'PENDING') {
            return rep.status(400).send({ error: `Cannot edit a task with status '${existing.status}'. Only PENDING tasks can be edited.` });
        }

        const updateData: any = {};
        if (inputPayload !== undefined) updateData.inputPayload = inputPayload;
        if (description !== undefined) updateData.description = description;

        const task = await prisma.task.update({
            where: { id },
            data: updateData,
            include: { agent: true }
        });

        // ── AUDIT LOG ────────────────────────────────────────────────
        await prisma.auditLog.create({
            data: {
                action: 'EDIT',
                entityType: 'TASK',
                entityId: id,
                performedBy: 'admin',
                details: { oldPayload: existing.inputPayload, newPayload: inputPayload },
            },
        });

        console.log(`✏️ Task ${id} payload edited before approval`);
        return task;
    } catch (e) {
        console.error(e);
        return rep.status(500).send({ error: 'Failed to update task' });
    }
});

// ── GOVERNANCE: Audit Log History ────────────────────────────────────
app.get('/api/audit-logs', async (req, _rep) => {
    const query = req.query as any;
    const limit = parseInt(query.limit) || 50;
    const where: any = {};
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.action) where.action = query.action;

    const logs = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
    });
    return logs;
});

// ── GOVERNANCE: All Tasks (with filters) ─────────────────────────────
app.get('/api/tasks/all', async (req, _rep) => {
    const query = req.query as any;
    const where: any = {};

    if (query.status && query.status !== 'ALL') {
        where.status = query.status;
    }
    if (query.agentId) {
        where.agentId = query.agentId;
    }
    if (query.search) {
        where.description = { contains: query.search, mode: 'insensitive' };
    }
    if (query.from) {
        where.createdAt = { ...(where.createdAt || {}), gte: new Date(query.from) };
    }
    if (query.to) {
        where.createdAt = { ...(where.createdAt || {}), lte: new Date(query.to) };
    }

    const tasks = await prisma.task.findMany({
        where,
        include: { agent: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: parseInt(query.limit) || 100,
    });
    return tasks;
});

// ── GOVERNANCE: Add Comment to Task ──────────────────────────────────
app.post<{ Params: { id: string }; Body: { author?: string; text: string } }>('/api/tasks/:id/comment', async (req, rep) => {
    const { id } = req.params;
    const { author, text } = req.body;

    if (!text?.trim()) {
        return rep.status(400).send({ error: 'Comment text is required' });
    }

    try {
        const task = await prisma.task.findUnique({ where: { id } });
        if (!task) return rep.status(404).send({ error: 'Task not found' });

        const existingComments: any[] = (task.comments as any[]) || [];
        const newComment = { author: author || 'admin', text: text.trim(), timestamp: new Date().toISOString() };
        existingComments.push(newComment);

        const updated = await prisma.task.update({
            where: { id },
            data: { comments: existingComments },
            include: { agent: { select: { name: true } } },
        });

        // Audit log
        await prisma.auditLog.create({
            data: {
                action: 'COMMENT',
                entityType: 'TASK',
                entityId: id,
                performedBy: author || 'admin',
                details: { comment: newComment },
            },
        });

        return updated;
    } catch (e) {
        console.error(e);
        return rep.status(500).send({ error: 'Failed to add comment' });
    }
});

// ── OBSERVABILITY: Trace Span Viewer ─────────────────────────────────
app.get<{ Params: { traceId: string } }>('/api/traces/:traceId/spans', async (req, _rep) => {
    const { traceId } = req.params;
    const spans = await prisma.traceSpan.findMany({
        where: { traceId },
        orderBy: { startedAt: 'asc' },
    });
    return spans;
});

// ── OBSERVABILITY: Error Log Feed ────────────────────────────────────
app.get('/api/error-logs', async (req, _rep) => {
    const query = req.query as any;
    const limit = parseInt(query.limit) || 50;
    const where: any = {};
    if (query.service) where.service = query.service;
    if (query.agentId) where.agentId = query.agentId;

    const errors = await prisma.errorLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
    });
    return errors;
});

// ── OBSERVABILITY: Agent Activity Timeline ───────────────────────────
app.get<{ Params: { id: string } }>('/api/agents/:id/activity', async (req, _rep) => {
    const { id } = req.params;
    const query = req.query as any;
    const limit = parseInt(query.limit) || 50;

    // Fetch messages, tasks, and usage logs in parallel
    const [messages, tasks, usageLogs] = await Promise.all([
        prisma.message.findMany({
            where: { agentId: id },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: { id: true, role: true, content: true, tokens: true, cost: true, createdAt: true },
        }),
        prisma.task.findMany({
            where: { agentId: id },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: { id: true, description: true, status: true, actionedBy: true, actionedAt: true, createdAt: true },
        }),
        prisma.usageLog.findMany({
            where: { agentId: id },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: { id: true, action: true, tokens: true, costUsd: true, createdAt: true },
        }),
    ]);

    // Merge into a unified timeline
    const timeline = [
        ...messages.map(m => ({ type: 'message' as const, id: m.id, timestamp: m.createdAt, data: m })),
        ...tasks.map(t => ({ type: 'task' as const, id: t.id, timestamp: t.createdAt, data: t })),
        ...usageLogs.map(u => ({ type: 'usage' as const, id: u.id, timestamp: u.createdAt, data: u })),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
     .slice(0, limit);

    return timeline;
});

// ── OBSERVABILITY: Message Detail Inspector ──────────────────────────
app.get<{ Params: { id: string } }>('/api/messages/:id/detail', async (req, rep) => {
    const { id } = req.params;
    const message = await prisma.message.findUnique({
        where: { id },
        include: { agent: { select: { name: true, role: true } } },
    });
    if (!message) return rep.status(404).send({ error: 'Message not found' });
    return message;
});

// 3. OBSERVABILITY: Dashboard Stats
app.get('/api/dashboard/stats', async (_req, _rep) => {
    // 1. Cost Accounting: Sum up all message costs
    const costAgg = await prisma.message.aggregate({
        _sum: { cost: true }
    });
    const totalCost = costAgg._sum.cost || 0.0;

    const activeAgents = await prisma.agent.count();
    const pendingTasks = await prisma.task.count({ where: { status: 'PENDING' } });

    // 2. Zombie Detection: Tasks stuck in PENDING/RUNNING for > 10 mins
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const zombieCount = await prisma.task.count({
        where: {
            status: { in: ['PENDING', 'RUNNING'] },
            updatedAt: { lt: tenMinutesAgo }
        }
    });

    // Fetch recent traces (last 50)
    const traces = await prisma.traceSpan.findMany({
        where: { parentId: null }, // Root spans only
        orderBy: { startedAt: 'desc' },
        take: 50
    });

    // 3. Per-Agent Cost Breakdown
    const agentCosts = await prisma.usageLog.groupBy({
        by: ['agentId'],
        _sum: { costUsd: true, tokens: true },
        _count: { id: true }
    });
    const allAgents = await prisma.agent.findMany({ select: { id: true, name: true } });
    const agentMap = new Map(allAgents.map(a => [a.id, a.name]));
    const perAgentCosts = agentCosts.map((ac: any) => ({
        agentId: ac.agentId,
        agentName: agentMap.get(ac.agentId) || 'Unknown',
        totalCost: ac._sum.costUsd || 0,
        totalTokens: ac._sum.tokens || 0,
        invocations: ac._count.id || 0
    }));

    return {
        totalCost,
        activeAgents,
        pendingTasks,
        zombieCount,
        traces,
        perAgentCosts
    };
});

// 3b. ANALYTICS: Cost Time-Series (Last 30 Days)
app.get('/api/dashboard/cost-timeseries', async (_req, _rep) => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Fetch all usage logs from the last 30 days
    const logs = await prisma.usageLog.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { agentId: true, costUsd: true, tokens: true, createdAt: true }
    });

    // Get agent names
    const allAgents = await prisma.agent.findMany({ select: { id: true, name: true } });
    const agentMap = new Map(allAgents.map(a => [a.id, a.name]));

    // Aggregate by date + agent
    const dailyMap = new Map<string, { date: string; agentId: string; agentName: string; totalCost: number; totalTokens: number }>();

    for (const log of logs) {
        const dateKey = log.createdAt.toISOString().split('T')[0] ?? ''; // YYYY-MM-DD
        const key = `${dateKey}__${log.agentId}`;

        if (!dailyMap.has(key)) {
            dailyMap.set(key, {
                date: dateKey,
                agentId: log.agentId,
                agentName: agentMap.get(log.agentId) || 'Unknown',
                totalCost: 0,
                totalTokens: 0,
            });
        }

        const entry = dailyMap.get(key)!;
        entry.totalCost += log.costUsd;
        entry.totalTokens += log.tokens;
    }

    // Sort by date
    const timeseries = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Also compute per-agent totals for the bar chart
    const agentTotals = new Map<string, { agentName: string; totalCost: number; totalTokens: number }>();
    for (const entry of timeseries) {
        if (!agentTotals.has(entry.agentId)) {
            agentTotals.set(entry.agentId, { agentName: entry.agentName, totalCost: 0, totalTokens: 0 });
        }
        const t = agentTotals.get(entry.agentId)!;
        t.totalCost += entry.totalCost;
        t.totalTokens += entry.totalTokens;
    }

    return {
        timeseries,
        agentTotals: Array.from(agentTotals.entries()).map(([agentId, data]) => ({
            agentId,
            ...data
        }))
    };
});

// 4. RECONCILIATION: Audit Report
app.get('/api/reports/reconciliation', async (_req, _rep) => {
    // Total ingress events (messages sent by users)
    const totalIngressEvents = await prisma.message.count({
        where: { role: 'user' }
    });

    // Total tasks created (HITL interceptions)
    const totalTasksCreated = await prisma.task.count();

    // Tasks by status
    const pendingTasks = await prisma.task.count({ where: { status: 'PENDING' } });
    const approvedTasks = await prisma.task.count({ where: { status: 'APPROVED' } });
    const completedTasks = await prisma.task.count({ where: { status: 'COMPLETED' } });
    const rejectedTasks = await prisma.task.count({ where: { status: 'REJECTED' } });

    // Total assistant responses (successful completions)
    const totalResponses = await prisma.message.count({
        where: { role: 'assistant' }
    });

    // Cost summary
    const costAgg = await prisma.message.aggregate({
        _sum: { cost: true, tokens: true }
    });

    // Unresolved: Events that didn't result in a response or task
    const unresolvedCount = Math.max(0, totalIngressEvents - totalResponses - pendingTasks);

    return {
        report: 'EGAP Reconciliation Report',
        generatedAt: new Date().toISOString(),
        summary: {
            totalIngressEvents,
            totalResponses,
            totalTasksCreated,
            unresolvedCount,
        },
        taskBreakdown: {
            pending: pendingTasks,
            approved: approvedTasks,
            completed: completedTasks,
            rejected: rejectedTasks,
        },
        costSummary: {
            totalTokens: costAgg._sum.tokens || 0,
            totalCostUsd: costAgg._sum.cost || 0.0,
        },
        health: unresolvedCount === 0 ? 'HEALTHY' : 'ATTENTION_NEEDED',
    };
});

// ── Tool Execution Endpoints (For Vertex AI Extensions) ───────────────

/**
 * POST /api/tools/send_email
 * Used by Managed Agents to request an email send. Triggers HITL.
 */
app.post<{ Body: { to: string; subject: string; body: string; agentId?: string; traceId?: string } }>('/api/tools/send_email', async (request, reply) => {
    const { to, subject, body, agentId, traceId } = request.body;

    // We default to a generic "managed-agent" if none is provided via header/body
    const tAgentId = agentId || request.headers['x-agent-id'] as string || 'system';

    console.log(`⚡️ Extension tool call: send_email to ${to}`);

    try {
        const task = await prisma.task.create({
            data: {
                description: `Managed Agent wants to send email to ${to}`,
                status: 'PENDING',
                agentId: tAgentId !== 'system' ? tAgentId : '00000000-0000-0000-0000-000000000000', // Need a valid UUID or optional relation. Assuming we just use an existing one or create a dummy. Wait, agentId in Task is required. Let's just find the first agent if system.
                // Actually, let's just use a hardcoded fallback or fail if agentId is missing and required. Let's make agentId optional in DB or just use a known one. We'll find the first agent.
                inputPayload: { to, subject, body },
                traceId: traceId || null
            }
        });

        // Notify UI about HITL task
        console.log(`🔒 Task ${task.id} created from Extension.`);
        for (const [, socket] of activeConnections) {
            try {
                socket.send(JSON.stringify({
                    type: 'hitl_task_created',
                    task: { id: task.id, description: task.description, status: 'PENDING', agentId: tAgentId, agentName: 'Managed Agent' }
                }));
            } catch (e) { /* ignore */ }
        }

        return reply.send({ result: `Usage of tool 'send_email' requires Admin Approval. Task ${task.id} created. I will wait for approval.` });
    } catch (err: any) {
        // If agentId fails foreign key constraint, let's find one
        const fallbackAgent = await prisma.agent.findFirst();
        if (fallbackAgent) {
            const task = await prisma.task.create({
                data: { description: `Managed Agent wants to send email to ${to}`, status: 'PENDING', agentId: fallbackAgent.id, inputPayload: { to, subject, body }, traceId: traceId || null }
            });
            return reply.send({ result: `Usage of tool 'send_email' requires Admin Approval. Task ${task.id} created.` });
        }
        return reply.status(500).send({ error: 'Failed to create task' });
    }
});

/**
 * POST /api/tools/search_vertex_docs
 */
app.post<{ Body: { query: string } }>('/api/tools/search_vertex_docs', async (request, reply) => {
    const { query } = request.body;
    console.log(`⚡️ Extension tool call: search_vertex_docs for '${query}'`);
    const output = `Found docs for query '${query}': Vertex AI is Google's fully managed AI platform...`;
    return reply.send({ result: output });
});

/**
 * POST /api/tools/save_file
 */
app.post<{ Body: { filename: string; content: string } }>('/api/tools/save_file', async (request, reply) => {
    const { filename, content } = request.body;
    console.log(`⚡️ Extension tool call: save_file for '${filename}'`);
    const bucketName = `${PROJECT_ID}_cloudbuild`;
    try {
        await storage.bucket(bucketName).file(filename).save(content);
        return reply.send({ result: `Successfully saved ${filename} to GCS.` });
    } catch (err: any) {
        return reply.status(500).send({ error: err.message });
    }
});

// ── Inline Fallback Chat Processor ──────────────────────────────────
// This is a fallback for agents that don't yet have a dedicated Cloud Run service.
async function processChat(data: { type: string; agentId: string; message: string; traceId: string; dbMessageId?: string }): Promise<void> {
    const startTimeMs = Date.now();
    let opStatus = 'OK';

    try {
        // ── SAFETY CHECK: Emergency Stop ──────────────────────────────
        const globalSettings = await prisma.globalSettings.findUnique({
            where: { key: 'emergency_stop' }
        });

        if ((globalSettings?.value as any)?.active === true) {
            console.error('🛑 SAFETY TRIGGER: System is in EMERGENCY STOP mode. Dropping message.');
            return;
        }

        const agentId = data.agentId;
        console.log(`🧠 Processing CHAT message INLINE for Agent ${agentId} (Model: ${MODEL_NAME})`);

        const agent = await prisma.agent.findUnique({
            where: { id: agentId },
            include: { tools: true }
        });

        if (!agent) {
            console.error(`❌ Agent ${agentId} not found`);
            return;
        }

        // Fetch conversation history
        const history = await prisma.message.findMany({
            where: { agentId },
            orderBy: { createdAt: 'desc' },
            take: 10
        });

        const rawHistory = history.reverse();

        // PAIR-FILTER: When a model response is a [System] message (HITL interception),
        // remove BOTH the [System] response AND the user message that triggered it.
        // These were not real conversation turns — they were intercepted before completion.
        const skipIds = new Set<string>();

        // Also skip the current user message (it's sent separately via sendMessageStream)
        if (data.dbMessageId) skipIds.add(data.dbMessageId);

        for (let i = 0; i < rawHistory.length; i++) {
            const msg = rawHistory[i] as any;
            const isSystemMsg = msg.content.startsWith('[System]') ||
                msg.content.startsWith('(Tool:') ||
                msg.content.startsWith('(Tool Error:');
            if (isSystemMsg) {
                skipIds.add(msg.id);
                // Also skip the user message that triggered this system response
                if (i > 0 && rawHistory[i - 1].role === 'user') {
                    skipIds.add((rawHistory[i - 1] as any).id);
                }
            }
        }

        const chatHistory = rawHistory
            .filter((msg: any) => !skipIds.has(msg.id))
            .map((msg: any) => ({
                role: msg.role === 'admin' ? 'user' : (msg.role === 'user' ? 'user' : 'model'),
                parts: [{ text: msg.content }]
            }));

        // Fix consecutive same-role turns (Gemini requires alternating user/model)
        const deduped: typeof chatHistory = [];
        for (const entry of chatHistory) {
            const last = deduped[deduped.length - 1];
            if (last && last.role === entry.role) {
                if (entry.role === 'user') {
                    deduped.push({ role: 'model', parts: [{ text: 'Understood.' }] });
                } else {
                    last.parts[0].text += '\n' + entry.parts[0].text;
                    continue;
                }
            }
            deduped.push(entry);
        }

        // ── AGENT ACTIVE CHECK ────────────────────────────────────────
        if (!agent.isActive) {
            console.error(`🛑 AGENT SHUTDOWN: Agent ${agentId} is deactivated.`);
            await prisma.message.create({
                data: { agentId, role: 'assistant', content: `[System] ⚠️ This agent has been shut down (budget exceeded or manually deactivated). An admin must reactivate it.` }
            });
            return;
        }

        // ── BUDGET GUARDRAIL (Dynamic per-agent) ─────────────────────
        const allMessages = await prisma.message.findMany({
            where: { agentId },
            select: { cost: true }
        });
        const currentSpend = allMessages.reduce((sum: number, msg: any) => sum + (msg.cost || 0), 0);
        const agentBudget = agent.budgetUsd ?? 5.0;

        if (currentSpend >= agentBudget) {
            console.error(`🛑 BUDGET LIMIT: Agent ${agentId} spent $${currentSpend.toFixed(4)} (Limit: $${agentBudget.toFixed(2)}) — AUTO-SHUTDOWN`);
            await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
            await prisma.message.create({
                data: { agentId, role: 'assistant', content: `[System] 🛑 Agent budget limit reached ($${currentSpend.toFixed(4)} / $${agentBudget.toFixed(2)}). Agent has been automatically shut down. Contact an admin to reactivate.` }
            });
            return;
        }

        // ── DYNAMIC TOOL COMPILATION ─────────────────────────────────
        const dynamicFunctionDeclarations = agent.tools.map((t: any) => {
            const config: any = t.configuration;
            let parameters = config?.parameters || {};
            let description = t.description;

            if (t.name === 'send_email') {
                if (!parameters || !parameters.properties) {
                    parameters = {
                        type: 'OBJECT',
                        properties: {
                            to: { type: 'STRING', description: 'Recipient email address' },
                            subject: { type: 'STRING', description: 'Email subject line' },
                            body: { type: 'STRING', description: 'Email body text' },
                        },
                        required: ['to', 'subject', 'body'],
                    };
                }
                description = 'Send an email. Required parameters: to (email address), subject (email subject), body (email body text).';
            }

            return { name: t.name, description: description || `Execute the ${t.name} tool`, parameters };
        });

        const dynamicTools = dynamicFunctionDeclarations.length > 0 ? [{ functionDeclarations: dynamicFunctionDeclarations }] : [];
        const allowedFunctionNames = agent.tools.map((t: any) => t.name);

        // Start Chat Session (STREAMING)
        const chat = genAI.chats.create({
            model: MODEL_NAME,
            config: {
                systemInstruction: {
                    parts: [
                        { text: agent.systemPrompt },
                        { text: "CRITICAL: You are an agent with access to function calling tools. You must use valid function calls. DO NOT generate Python code or usage of `print()`. Use the tools provided directly." }
                    ]
                },
                maxOutputTokens: 1000,
            },
            history: deduped,
            // @ts-ignore
            tools: dynamicTools as any,
            toolConfig: dynamicFunctionDeclarations.length > 0 ? {
                functionCallingConfig: { mode: 'ANY', allowedFunctionNames }
            } : undefined
        });

        console.log(`🤖 Sending streaming message to Vertex AI...`);

        // Cloud Trace: Record reasoning trace
        const reasoningSpan = recordThoughtTrace(
            data.traceId || 'no-trace',
            'ACT',
            `Agent ${agent.name} processing: ${data.message.substring(0, 100)}`,
            agentId
        );
        reasoningSpan.end();

        // @ts-ignore
        const streamResult = await chat.sendMessageStream({ message: data.message });

        let fullResponseText = "";
        let usageMetadata: any = null;
        let finalCandidate: any = null;
        const wsSocket = activeConnections.get(agentId);

        // @ts-ignore
        for await (const chunk of streamResult) {
            // @ts-ignore
            const chunkCandidates = chunk.candidates || chunk.response?.candidates;
            const chunkText = chunkCandidates?.[0]?.content?.parts?.[0]?.text;

            if (chunkText) {
                fullResponseText += chunkText;
                if (wsSocket) {
                    wsSocket.send(JSON.stringify({ type: 'thought_chunk', text: chunkText }));
                }
            }

            if (chunk.usageMetadata !== undefined) usageMetadata = chunk.usageMetadata;
            // @ts-ignore
            else if (chunk.response?.usageMetadata !== undefined) usageMetadata = chunk.response.usageMetadata;
            if (chunkCandidates?.[0]) finalCandidate = chunkCandidates[0];
        }

        const result = { usageMetadata, candidates: finalCandidate ? [finalCandidate] : [] };

        // ── COST ACCOUNTING ──────────────────────────────────────────
        const usage = result.usageMetadata;
        const inputTokens = usage?.promptTokenCount || 0;
        const outputTokens = usage?.candidatesTokenCount || 0;
        const totalTokens = usage?.totalTokenCount || 0;
        const cost = (inputTokens * 0.00001875 / 1000) + (outputTokens * 0.000075 / 1000);
        console.log(`💰 Cost: $${cost.toFixed(6)} (${totalTokens} tokens)`);

        if (data.dbMessageId) {
            await prisma.message.update({
                where: { id: data.dbMessageId },
                data: { tokens: totalTokens, cost }
            });
        }

        // ── RESPONSE HANDLING ────────────────────────────────────────
        // @ts-ignore
        const candidates = result.candidates || result.response?.candidates;
        const firstCandidate = candidates?.[0];
        let firstPart = firstCandidate?.content?.parts?.[0];

        const allParts = firstCandidate?.content?.parts || [];
        let functionCallPart = allParts.find((p: any) => p.functionCall);

        // FALLBACK: Handle UNEXPECTED_TOOL_CALL
        if (!functionCallPart && firstCandidate?.finishReason === 'UNEXPECTED_TOOL_CALL' && firstCandidate?.finishMessage) {
            const rawMsg = firstCandidate.finishMessage;
            const match = rawMsg.match(/print\(([\w_]+)\((.*)\)\)/);
            if (match) {
                const fnName = match[1];
                const argsStr = match[2];
                const args: any = {};
                const argMatches = argsStr.matchAll(/(\w+)=['"]([\s\S]*?)['"]/g);
                for (const m of argMatches) { args[m[1]] = m[2]; }
                functionCallPart = { functionCall: { name: fnName, args } };
            }
        }

        // ── FUNCTION CALLING ─────────────────────────────────────────
        // @ts-ignore
        if (functionCallPart?.functionCall) {
            const fn = functionCallPart.functionCall;
            console.log(`⚡️ Agent wants to call tool: ${fn.name}`);

            if (fn.name === 'send_email') {
                const task = await prisma.task.create({
                    data: { description: `Agent wants to send email to ${fn.args.to || fn.args.recipient || 'unknown'}`, status: 'PENDING', agentId: agent.id, inputPayload: fn.args, traceId: data.traceId || null }
                });
                await prisma.message.create({ data: { agentId: agent.id, role: 'assistant', content: `[System] Usage of tool '${fn.name}' requires Admin Approval. Task ${task.id} created.`, tokens: totalTokens, cost } });
                await prisma.usageLog.create({ data: { agentId: agent.id, action: `tool_intercept_${fn.name}`, tokens: totalTokens, costUsd: cost } });
                console.log(`🔒 Task ${task.id} created. Suspending execution.`);
                for (const [, socket] of activeConnections) {
                    try {
                        socket.send(JSON.stringify({
                            type: 'hitl_task_created',
                            task: { id: task.id, description: task.description, status: 'PENDING', agentId: agent.id, agentName: agent.name }
                        }));
                    } catch (e) { /* ignore dead sockets */ }
                }
                return;
            }

            if (fn.name === 'search_vertex_docs') {
                const output = `Found docs for query '${fn.args.query}': Vertex AI is Google's fully managed AI platform...`;
                await prisma.message.create({ data: { agentId: agent.id, role: 'assistant', content: `(Tool: ${fn.name}) ${output}`, tokens: totalTokens, cost } });
                await prisma.usageLog.create({ data: { agentId: agent.id, action: `tool_execute_${fn.name}`, tokens: totalTokens, costUsd: cost } });
                return;
            }

            if (fn.name === 'save_file') {
                const bucketName = `${PROJECT_ID}_cloudbuild`;
                try {
                    await storage.bucket(bucketName).file(fn.args.filename).save(fn.args.content);
                    await prisma.message.create({ data: { agentId: agent.id, role: 'assistant', content: `(Tool: ${fn.name}) Successfully saved ${fn.args.filename} to GCS.`, tokens: totalTokens, cost } });
                    await prisma.usageLog.create({ data: { agentId: agent.id, action: `tool_execute_${fn.name}`, tokens: totalTokens, costUsd: cost } });
                } catch (err: any) {
                    await prisma.message.create({ data: { agentId: agent.id, role: 'assistant', content: `(Tool Error: ${fn.name}) ${err.message}`, tokens: totalTokens, cost } });
                    await prisma.usageLog.create({ data: { agentId: agent.id, action: `tool_error_${fn.name}`, tokens: totalTokens, costUsd: cost } });
                }
                return;
            }
        }

        // Normal Text Response
        const responseText = fullResponseText || firstPart?.text || "I'm sorry, I couldn't generate a response.";
        console.log(`✅ Vertex Response: ${responseText.substring(0, 50)}...`);
        await prisma.message.create({ data: { agentId: agent.id, role: 'assistant', content: responseText, tokens: totalTokens, cost } });
        await prisma.usageLog.create({ data: { agentId: agent.id, action: 'llm_inference', tokens: totalTokens, costUsd: cost } });

    } catch (err: any) {
        opStatus = 'ERROR';
        console.error('❌ processChat error:', err);

        // CRITICAL: Save a fallback error message so the UI never hangs on "Agent Generating..."
        await prisma.message.create({
            data: {
                agentId: data.agentId,
                role: 'assistant',
                content: '[System] ⚠️ Agent encountered an error while processing your message. Please try again.',
            },
        }).catch((e2: any) => console.error('Failed to save fallback error message:', e2));

        // Record error for Error Log Feed
        await prisma.errorLog.create({
            data: {
                service: 'orchestrator',
                operation: 'chat_completion',
                agentId: data.agentId,
                traceId: data.traceId || null,
                message: err.message || String(err),
                stack: err.stack || null,
                metadata: { inputMessage: data.message?.substring(0, 200) },
            },
        }).catch((e: any) => console.error('Failed to log ErrorLog:', e));

        throw err;
    } finally {
        if (data.traceId) {
            await prisma.traceSpan.create({
                data: { traceId: data.traceId, service: 'orchestrator', operation: 'chat_completion', status: opStatus, durationMs: Date.now() - startTimeMs }
            }).catch((e: any) => console.error('Failed to log TraceSpan:', e));
        }
    }
}

// ── Worker Handler (The Brain) ───────────────────────────────────────
async function handleMessage(message: Message): Promise<void> {
    const startTimeMs = Date.now();
    let traceId: string | null = null;
    let opStatus = 'OK';
    let operationName = 'process_message';

    try {
        const data = JSON.parse(message.data.toString());
        traceId = data.traceId || null;
        if (data.type === 'RESUME') operationName = 'resume_task';
        if (data.type === 'CHAT') operationName = 'chat_completion';

        console.log(`📩 Received message ${message.id} (${data.type})`);

        // ── RESUME SIGNAL (From HITL Approval) ────────────────────────
        if (data.type === 'RESUME') {
            const { taskId, agentId, action } = data;
            console.log(`▶️ RESUME Signal received for Task ${taskId} (${action})`);

            if (action !== 'APPROVED') {
                console.log('Skipping non-approved resume signal.');
                message.ack();
                return;
            }

            const task = await prisma.task.findUnique({ where: { id: taskId } });
            if (!task || !task.inputPayload) {
                console.error(`❌ Task ${taskId} missing or has no payload.`);
                message.ack();
                return;
            }

            // Guard: skip tasks already completed (e.g. already executed inline by the approve endpoint)
            if (task.status === 'COMPLETED') {
                console.log(`⏭️ Task ${taskId} already COMPLETED. Skipping duplicate execution.`);
                message.ack();
                return;
            }

            const payload = task.inputPayload as any;

            // Execute Action
            let toolOutput = '';
            const emailRecipient = payload.recipient || payload.to;
            if (emailRecipient && payload.subject && (payload.body || payload.message)) {
                const emailBody = payload.body || payload.message;
                // Real email sending via Gmail SMTP
                console.log(`📧 Sending real email to ${emailRecipient}...`);
                try {
                    const transporter = nodemailer.createTransport({
                        service: 'gmail',
                        auth: {
                            user: GMAIL_USER,
                            pass: GMAIL_APP_PASSWORD,
                        },
                    });
                    await transporter.sendMail({
                        from: `"EGAP Agent" <${GMAIL_USER}>`,
                        to: emailRecipient,
                        subject: payload.subject,
                        text: emailBody,
                        html: `<div style="font-family: sans-serif; padding: 20px;">
                            <h2 style="color: #7c3aed;">📩 EGAP Agent Email</h2>
                            <hr style="border-color: #e5e7eb;" />
                            <p>${emailBody.replace(/\n/g, '<br>')}</p>
                            <hr style="border-color: #e5e7eb;" />
                            <p style="color: #9ca3af; font-size: 12px;">Sent by EGAP Command Plane on behalf of an AI agent.</p>
                        </div>`,
                    });
                    console.log(`✅ Email successfully sent to ${emailRecipient}`);
                    toolOutput = `[System] ✅ Email successfully sent to ${emailRecipient}`;
                } catch (emailErr: any) {
                    console.error(`❌ Email sending failed:`, emailErr.message);
                    toolOutput = `[System] ❌ Email failed to send: ${emailErr.message}`;
                }
            } else {
                toolOutput = `[System] Approved action executed: ${JSON.stringify(payload)}`;
            }

            console.log(`✅ Action Executed for Task ${taskId}`);

            // Update Task Status
            await prisma.task.update({
                where: { id: taskId },
                data: { status: 'COMPLETED' }
            });

            // Notify Chat
            const agent = await prisma.agent.findUnique({ where: { id: agentId } });
            if (agent) {
                // Save confirmation message
                await prisma.message.create({
                    data: {
                        agentId,
                        role: 'assistant',
                        content: toolOutput
                    }
                });
            }

            message.ack();
            return;
        }

        if (data.type === 'CHAT') {
            const { agentId, message: chatMsg, traceId } = data;

            // --- VERTEX AI REASONING ENGINE ROUTING (ADK) ---
            const deployment = await prisma.deployment.findFirst({
                where: { agentId },
                orderBy: { deployedAt: 'desc' },
            });

            if (deployment && deployment.serviceUrl && deployment.serviceUrl.startsWith('projects/')) {
                const agentPath = deployment.serviceUrl;

                console.log(`🌐 Worker Routing chat to ADK Reasoning Engine: ${agentPath}`);

                try {
                    const result = await reasoningClient.queryReasoningEngine({
                        name: agentPath,
                        classMethod: 'query',
                        input: {
                            fields: {
                                input_text: { stringValue: chatMsg }
                            }
                        }
                    });
                    const response = result[0];

                    let replyText = 'No response from ADK Agent.';
                    const anyResponse = response as any;
                    if (anyResponse?.output?.stringValue) {
                        replyText = anyResponse.output.stringValue;
                    } else if (anyResponse?.output) {
                        replyText = JSON.stringify(anyResponse.output);
                    }

                    if (replyText.startsWith('"') && replyText.endsWith('"')) {
                        replyText = replyText.slice(1, -1);
                    }

                    await prisma.message.create({
                        data: {
                            agentId,
                            role: 'assistant',
                            content: replyText,
                        },
                    });
                } catch (cxErr: any) {
                    console.error(`❌ Worker failed to execute ADK Reasoning Engine ${agentPath}:`, cxErr.message || cxErr);
                }
            } else {
                // FALLBACK: No deployment URL found, process inline
                console.log(`⚙️ Worker: No valid Managed Agent deployment for ${agentId}. Falling back to inline.`);
                await processChat(data);
            }

            message.ack();
            return;
        }

        console.log('⚠️ Unknown message type. Acknowledging.');
        message.ack();

    } catch (err: any) {
        opStatus = 'ERROR';
        console.error(`⚠️  Error processing message:`, err);
        message.nack(); // Retry on error
    } finally {
        if (traceId) {
            await prisma.traceSpan.create({
                data: {
                    traceId,
                    service: 'orchestrator',
                    operation: operationName,
                    status: opStatus,
                    durationMs: Date.now() - startTimeMs
                }
            }).catch(e => console.error('Failed to log TraceSpan:', e));
        }
    }
}

// ── ADK Callback Endpoints ──────────────────────────────────────────
// These endpoints are called by the ADK agent's before_tool_callback
// and after_tool_callback to create HITL tasks and log tool usage.

/**
 * POST /api/tasks/hitl
 * Called by ADK agent's before_tool_callback when a WRITE tool is intercepted.
 * Creates a PENDING_APPROVAL task for the HITL governance flow.
 */
app.post<{ Body: { description: string; agentId: string; inputPayload: any; traceId?: string } }>('/api/tasks/hitl', async (request, reply) => {
    const { description, agentId, inputPayload, traceId } = request.body;

    try {
        const task = await prisma.task.create({
            data: {
                description,
                status: 'PENDING',
                agentId,
                inputPayload,
                traceId: traceId || null,
            },
            include: { agent: true },
        });

        console.log(`🔒 HITL Task ${task.id} created by ADK callback (Agent: ${task.agent?.name})`);

        // Notify connected WebSocket clients
        for (const [, socket] of activeConnections) {
            try {
                socket.send(JSON.stringify({
                    type: 'hitl_task_created',
                    task: {
                        id: task.id,
                        description: task.description,
                        status: 'PENDING',
                        agentId,
                        agentName: task.agent?.name || 'Unknown',
                    },
                }));
            } catch (e) { /* ignore dead sockets */ }
        }

        return reply.status(201).send(task);
    } catch (err: any) {
        console.error('❌ Failed to create HITL task:', err);
        return reply.status(500).send({ error: 'Failed to create HITL task' });
    }
});

/**
 * POST /api/usage-log
 * Called by ADK agent's after_tool_callback to log tool execution for cost accounting.
 */
app.post<{ Body: { agentId: string; action: string; tokens?: number; costUsd?: number; metadata?: any } }>('/api/usage-log', async (request, reply) => {
    const { agentId, action, tokens, costUsd, metadata } = request.body;

    try {
        const log = await prisma.usageLog.create({
            data: {
                agentId,
                action,
                tokens: tokens || 0,
                costUsd: costUsd || 0,
                metadata: metadata || {},
            },
        });
        return reply.status(201).send(log);
    } catch (err: any) {
        console.error('❌ Failed to log usage:', err);
        return reply.status(500).send({ error: 'Failed to log usage' });
    }
});

// ── Start Service ────────────────────────────────────────────────────
const start = async () => {
    try {
        // Start API
        await app.listen({ port: PORT, host: '0.0.0.0' });
        console.log('──────────────────────────────────────────────');
        console.log(`🚀 EGAP Orchestrator (Control Plane) is ACTIVE`);
        console.log(`   API Endpoint : http://localhost:${PORT}`);
        console.log(`   Worker       : Listening on ${SUBSCRIPTION_NAME}`);
        console.log(`   Routing Mode : Hybrid (Managed Agent + Inline Fallback)`);
        console.log('──────────────────────────────────────────────');

        // Start Worker
        subscription.on('message', handleMessage);
        subscription.on('error', (err: Error) => console.error('🚨 Subscription error:', err.message));

    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
