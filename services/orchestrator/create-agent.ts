import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🤖 Creating GitHub Keeper Agent...');
  
  // 1. Find the GitHub tool we just seeded
  const githubTool = await prisma.tool.findFirst({
    where: { name: 'github' }
  });

  if (!githubTool) {
    throw new Error('GitHub tool not found! Did you run seed.ts?');
  }

  // 2. Create the Agent
  const agent = await prisma.agent.create({
    data: {
      name: 'GitHub Keeper',
      role: 'github', // This matches the webhook source
      goal: 'Monitor the code repository for new changes.',
      systemPrompt: 'You are an AI specialized in code review. Analyze commit messages.',
      // Connect the tool
      tools: {
        connect: { id: githubTool.id }
      }
    }
  });

  console.log(`✅ Agent Created: ${agent.name} (ID: ${agent.id})`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
