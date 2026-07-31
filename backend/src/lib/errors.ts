import { NextFunction, Request, Response } from 'express';
import multer from 'multer';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export const asyncHandler =
  (fn: AsyncRoute) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // body-parser rejects malformed and oversized payloads before any route runs. Both are
  // the caller's fault, so neither may surface as a 500 — that would report a server
  // fault for a bad request and bury it in the error log.
  const bodyParserType = (err as { type?: string } | null)?.type;
  if (bodyParserType === 'entity.too.large') {
    res.status(413).json({
      error: 'Request body is too large — split the import into smaller batches',
    });
    return;
  }
  if (bodyParserType === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }
  if (bodyParserType === 'charset.unsupported' || bodyParserType === 'encoding.unsupported') {
    res.status(415).json({ error: 'Unsupported request encoding' });
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File exceeds the 50 MB upload limit' });
      return;
    }
    res.status(400).json({ error: `Upload rejected: ${err.message}` });
    return;
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === 'P2002') {
    res.status(409).json({ error: 'Duplicate value for a unique field' });
    return;
  }
  if (code === 'P2025') {
    res.status(404).json({ error: 'Record not found' });
    return;
  }
  if (code === 'P2020') {
    res.status(400).json({ error: 'A numeric value is out of range' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

/** Parse an :id route param, throwing 400 on garbage. */
export function idParam(value: string, label = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(400, `Invalid ${label}`);
  return n;
}
