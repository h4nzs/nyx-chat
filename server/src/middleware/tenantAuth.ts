import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { Tenant } from '@prisma/client';
import { sealedLookupCandidates } from '../utils/atRestSecrets.js';

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

export const requireTenantAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['x-nyx-engine-key'];
    
    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid API Key' });
    }

    // [docs/28 Tier 0 — D4] `Tenant.apiKey` disimpan dalam bentuk sealed.
    // Kandidat lookup = [sealed, apa adanya] → baris legacy (plaintext) tetap
    // bisa autentikasi sampai di-upgrade.
    const candidates = await sealedLookupCandidates(apiKey);
    const tenant = await prisma.tenant.findFirst({
      where: { apiKey: { in: candidates } }
    });

    if (!tenant || !tenant.isActive) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or inactive Tenant API Key' });
    }

    req.tenant = tenant;
    next();
  } catch (error) {
    console.error('Tenant Auth Error:', error);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
};
