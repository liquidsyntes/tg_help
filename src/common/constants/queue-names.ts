/**
 * BullMQ Queue and Job names.
 * Authoritative reference: AGENTS.md § 20, § 21, § 22
 */
export const QUEUES = {
  PUBLICATION: 'publication',
} as const;

export const PUBLICATION_QUEUE_NAME = 'publication';

export const JOB_NAMES = {
  PUBLISH_POST: 'publish-post',
} as const;
