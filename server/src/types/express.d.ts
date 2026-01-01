import { AuthPayload } from './auth';
import { JwtPayload } from 'jsonwebtoken';

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      jwtPayload?: JwtPayload;
    }
  }
}
