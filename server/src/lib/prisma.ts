import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not defined in the environment variables.');
}

// Setup the PostgreSQL connection pool
const pool = new Pool({ connectionString });

// Instantiate the Prisma adapter
const adapter = new PrismaPg(pool);

// Pass the adapter to the PrismaClient
export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;
