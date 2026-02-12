import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');
  
  await prisma.tool.createMany({
    data: [
      { name: 'search', description: 'Google Search' },
      { name: 'email', description: 'Send Emails' },
      { name: 'github', description: 'GitHub Integration' }
    ],
    skipDuplicates: true,
  });

  console.log('✅ Database seeded!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
