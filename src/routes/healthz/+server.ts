import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRawDatabase } from '../../lib/server/db/connection';

export const GET: RequestHandler = () => {
  getRawDatabase().prepare('SELECT 1').get();
  return json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
};
