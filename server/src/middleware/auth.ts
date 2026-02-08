import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { Socket } from "socket.io";
import { env } from "../config.js";
import { AuthPayload } from "../types/auth.js";

// === Middleware untuk REST API ===
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Prioritaskan pembacaan token dari cookie
  const token = req.cookies?.at || // access token dari cookie
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : null);

  if (!token) {
    console.log('[Auth Middleware] No token found in request');
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret) as AuthPayload;
    // console.log('[Auth Middleware] Pengguna terotentikasi:', payload); 
    req.user = payload;
    next();
  } catch (err) {
    console.error("Authentication error:", err);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// === Helper untuk verifikasi token ===
export function verifySocketAuth(token?: string): AuthPayload | null {
  if (!token) return null;
  try {
    return jwt.verify(token, env.jwtSecret) as AuthPayload;
  } catch {
    return null;
  }
}

// === Middleware khusus Socket.IO ===
export function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
) {
  try {
    let token: string | undefined = undefined;
    
    if (socket.handshake.headers?.cookie) {
      const cookies = Object.fromEntries(
        socket.handshake.headers.cookie.split(";").map((c) => {
          const [k, v] = c.trim().split("=");
          return [k, decodeURIComponent(v)];
        })
      );
      token = cookies["at"] || undefined;
    }

    const user = verifySocketAuth(token);
    if (user) {
      (socket as any).user = user;
    }
    
    next();
  } catch (err) {
    console.error("Socket authentication error:", err);
    next(new Error("Internal server error during auth"));
  }
}
