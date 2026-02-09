import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding database...');

    // Tool 1: search_vertex_docs
    await prisma.tool.upsert({
        where: { name: 'search_vertex_docs' },
        update: {},
        create: {
            name: 'search_vertex_docs',
            description: 'Search the official Vertex AI documentation for technical answers.',
        },
    });

    // Tool 2: send_email
    await prisma.tool.upsert({
        where: { name: 'send_email' },
        update: {},
        create: {
            name: 'send_email',
            description: 'Send an email to a recipient. Requires subject and body.',
        },
    });

    // Tool 3: save_file
    await prisma.tool.upsert({
        where: { name: 'save_file' },
        update: {},
        create: {
            name: 'save_file',
            description: 'Save text content to a file in cloud storage. Requires filename and content.',
        },
    });

    console.log('Database seeded successfully');
}

main()
    .catch((e) => {
        console.error('Error seeding database:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
