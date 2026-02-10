export class ApiError extends Error {
  status: number

  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function errorHandler (err: any, _req: any, res: any, _next: any) {
  const status = err.status || 500
  const message = err.message || 'Internal Server Error'
  if (status >= 500) console.error(err)
  res.status(status).json({ error: message })
}
