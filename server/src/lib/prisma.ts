import pkg from '@prisma/client';
import pgPkg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const { PrismaClient } = pkg;
const { Pool } = pgPkg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not defined in the environment variables.');
}

// Setup the PostgreSQL connection pool
const pool = new Pool({ connectionString });

// Instantiate the Prisma adapter
const adapter = new PrismaPg(pool as any);

// Pass the adapter to the PrismaClient
export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;
