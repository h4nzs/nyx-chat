import { PrismaClient } from '@prisma/client';
import pgPkg from 'pg';
import type { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const { Pool: PgPool } = pgPkg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not defined in the environment variables.');
}

// Setup the PostgreSQL connection pool
const pool = new PgPool({ connectionString });

// Instantiate the Prisma adapter
// @ts-expect-error: Bypassing structural typing mismatch between project's @types/pg (8.18.x) and Prisma's internal @types/pg (8.11.x)
const adapter = new PrismaPg(pool);

// Pass the adapter to the PrismaClient
export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;
