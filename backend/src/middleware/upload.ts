import fs from 'fs';
import path from 'path';
import multer from 'multer';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeBase = path
      .basename(file.originalname)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(-120);
    cb(null, `${process.hrtime.bigint().toString(36)}-${safeBase}`);
  },
});

/** Single-file upload under field name "file". */
export const uploadSingle = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
}).single('file');

/** Best-effort removal of a stored file (used on rollbacks/deletes). */
export function removeStoredFile(storagePath: string): void {
  fs.promises
    .unlink(path.join(UPLOAD_DIR, path.basename(storagePath)))
    .catch(() => undefined);
}

export function absoluteStoragePath(storagePath: string): string {
  return path.join(UPLOAD_DIR, path.basename(storagePath));
}
