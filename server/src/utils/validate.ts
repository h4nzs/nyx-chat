import { ZodError, ZodSchema } from 'zod'
import { ApiError } from './errors.js'
import { Request, Response, NextFunction } from 'express'
import type { ParsedQs } from 'qs'
import type { ParamsDictionary } from 'express-serve-static-core'

export function zodValidate (schema: { body?: ZodSchema; query?: ZodSchema; params?: ZodSchema }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.body) req.body = schema.body.parse(req.body)
      if (schema.query) req.query = schema.query.parse(req.query) as unknown as ParsedQs
      if (schema.params) req.params = schema.params.parse(req.params) as unknown as ParamsDictionary
      next()
    } catch (e: unknown) {
      if (e instanceof ZodError) {
        const msg = e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        next(new ApiError(400, msg))
      } else next(e)
    }
  }
}
