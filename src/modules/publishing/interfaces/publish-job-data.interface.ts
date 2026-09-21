/**
 * Publication Job Payload Definition for BullMQ
 * Authoritative reference: AGENTS.md § 20, § 21, § 22; tasks.md § 20, § 21
 */

export interface PublishJobData {
  /** Database PublicationJob UUID */
  publicationJobId?: string;
  /** Target Post primary key */
  postId: string;
  /** Expected post version at enqueue time */
  postVersion: number;
  /** Target channel identifier */
  channelId: string;
  /** Actor user ID who initiated publication */
  actorId: string;
  /** Flag if publication was triggered via scheduling */
  isScheduled?: boolean;
  /** Enqueue ISO timestamp */
  enqueuedAt?: string;
}
