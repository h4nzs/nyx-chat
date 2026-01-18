import { createRequire } from 'module';

// Import type saja agar TypeScript tidak error, tapi tidak dieksekusi saat runtime
import type { PrismaClient as PrismaClientType } from '@prisma/client';

const require = createRequire(import.meta.url);

// Gunakan require untuk mengambil PrismaClient (Bypass ESM restriction)
const { PrismaClient } = require('@prisma/client');

// Deklarasi Global Type
declare global {
  var prisma: PrismaClientType | undefined;
}

const prisma = global.prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export { prisma };