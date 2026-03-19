import { AuthPayload } from './auth'
import { JwtPayload } from 'jsonwebtoken'

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      jwtPayload?: JwtPayload;
      file?: {
        key?: string;
        path?: string;
        mimetype?: string;
        originalname?: string;
        size?: number;
      };
    }
  }
}
