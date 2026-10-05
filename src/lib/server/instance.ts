import { randomUUID } from 'node:crypto';

const serverInstanceId = process.env.SERVER_INSTANCE_ID ?? randomUUID();

export function getServerInstanceId(): string {
  return serverInstanceId;
}
