// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

import { ML_DSA_65_SIGNATURE_BYTES, mlDsaVerify } from '@nyx/shared';

export interface MlDsaVerifyParams {
  signature: Uint8Array;
  message: Uint8Array;
  publicKey: Uint8Array;
  domain: string;
}

export function verifyMlDsaSignature({ signature, message, publicKey, domain }: MlDsaVerifyParams): boolean {
  if (signature.length !== ML_DSA_65_SIGNATURE_BYTES) {
    return false;
  }
  try {
    return mlDsaVerify(signature, message, publicKey, domain);
  } catch {
    return false;
  }
}
