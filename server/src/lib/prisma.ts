import { PrismaClient } from '@prisma/client'

// Re-export all types from the Prisma client
export * from '@prisma/client';

// Add prisma to the NodeJS Global type
declare global {
  var prisma: PrismaClient | undefined
}

const prisma = global.prisma || new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma
}

export { prisma }