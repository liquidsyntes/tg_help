/**
 * MockNotificationService
 * Captures domain notifications dispatched to editors and authors.
 * Authoritative Sources: tasks.md §24; AGENTS.md §27; PROJECT.md F-39, F-40.
 */

export interface DomainNotification {
  recipientId: string;
  recipientRole: 'EDITOR' | 'AUTHOR' | 'ADMIN';
  eventType:
    | 'submitted_for_review'
    | 'approved'
    | 'revision_requested'
    | 'rejected'
    | 'scheduled'
    | 'published'
    | 'publication_failed';
  postId: string;
  title: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

export class MockNotificationService {
  private notifications: DomainNotification[] = [];

  async sendNotification(notification: Omit<DomainNotification, 'timestamp'>): Promise<void> {
    this.notifications.push({
      ...notification,
      timestamp: new Date(),
    });
  }

  getNotifications(recipientId?: string): DomainNotification[] {
    if (recipientId) {
      return this.notifications.filter((n) => n.recipientId === recipientId);
    }
    return [...this.notifications];
  }

  getNotificationsByPostId(postId: string): DomainNotification[] {
    return this.notifications.filter((n) => n.postId === postId);
  }

  getLastNotification(): DomainNotification | undefined {
    return this.notifications[this.notifications.length - 1];
  }

  clear(): void {
    this.notifications = [];
  }
}
