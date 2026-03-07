import { ZodError, ZodSchema } from 'zod'
import { ApiError } from './errors.js'
import { Request, Response, NextFunction } from 'express'

export function zodValidate (schema: { body?: ZodSchema; query?: ZodSchema; params?: ZodSchema }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.body) (req as any).body = schema.body.parse(req.body)
      if (schema.query) (req as any).query = schema.query.parse(req.query)
      if (schema.params) (req as any).params = schema.params.parse(req.params)
      next()
    } catch (e: any) {
      if (e instanceof ZodError) {
        const msg = e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        next(new ApiError(400, msg))
      } else next(e)
    }
  }
}
