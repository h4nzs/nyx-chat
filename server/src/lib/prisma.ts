import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import fs from 'fs'; // 1. Impor fs
import path from 'path';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not defined in the environment variables.');
}

const caPath = path.resolve(process.cwd(), 'ca.pem');

// 1. Buat connection pool standar PostgreSQL
const pool = new Pool({ 
  connectionString,
  ssl: {
    rejectUnauthorized: true, // <--- INI OBATNYA!
    ca: fs.readFileSync(caPath).toString()
  }
});

// 2. Bungkus pool tersebut dengan Prisma Adapter
const adapter = new PrismaPg(pool);

// 3. Masukkan adapter ke dalam konstruktor Prisma
export const prisma = new PrismaClient({
  adapter, // <--- INI KUNCI UTAMANYA!
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;