import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

const RESERVED_PREFIXES = ['/api', '/artifacts', '/frames', '/_next'];

/**
 * The production web export emits a single `/` shell. Client routes such as
 * `/projects/:id` and `/projects/:id/files/index.html` must receive that
 * shell on refresh. API, artifact, frame, and Next asset requests keep
 * their own handlers. `express.static` runs first, so a real exported file
 * never reaches this check.
 */
export function shouldServeSpaShell(pathname: string): boolean {
  if (pathname === '/') return false;
  const normalized = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
  return !RESERVED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function spaShellMiddleware(staticDir: string) {
  const indexPath = path.join(staticDir, 'index.html');
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !shouldServeSpaShell(req.path)) {
      next();
      return;
    }
    if (!fs.existsSync(indexPath)) {
      next();
      return;
    }
    res.sendFile(indexPath);
  };
}
