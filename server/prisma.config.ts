/// <reference types="node" />
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  datasource: {
    // Kalau ada DIRECT_URL di .env, CLI bakal pakai ini buat nge-push schema.
    // Kalau nggak ada, dia baru nengok ke DATABASE_URL.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL,
  },
});