import { Request, Response, NextFunction } from 'express'

export class ApiError extends Error {
  status: number

  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function errorHandler (err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const status = typeof err === 'object' && err !== null && 'status' in err ? (err as Record<string, unknown>).status as number : 500
  const message = typeof err === 'object' && err !== null && 'message' in err ? (err as Record<string, unknown>).message as string : 'Internal Server Error'
  if (status >= 500) console.error(err)
  res.status(status).json({ error: message })
}
