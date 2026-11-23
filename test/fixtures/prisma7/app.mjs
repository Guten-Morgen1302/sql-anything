// Prisma 7 app (driver adapter over pg). The N+1 is the loop in /users.
import http from 'node:http';
import { PrismaClient } from './generated/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
await prisma.post.deleteMany();
await prisma.user.deleteMany();
for (let i = 1; i <= 8; i++) await prisma.user.create({ data: { name: 'u' + i, posts: { create: [{ title: 'a' + i }, { title: 'b' + i }] } } });

http
  .createServer(async (req, res) => {
    const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    const out = [];
    for (const u of users) out.push({ id: u.id, posts: (await prisma.post.findMany({ where: { authorId: u.id } })).length }); // N+1
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  })
  .listen(Number(process.env.PORT), '127.0.0.1');
