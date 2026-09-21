/**
 * Typesafe Callback Data Codec
 * Enforces Telegram's strict 64-byte limit on callback_data.
 * Authoritative reference: AGENTS.md § 18, § 51, § 52; tasks.md § 13
 */

export enum PostCallbackAction {
  // Author controls
  SUBMIT_FOR_REVIEW = 'p:sub',
  DELETE_DRAFT_PROMPT = 'p:del',
  DELETE_DRAFT_CONFIRM = 'p:del_ok',
  EDIT_POST = 'p:edt',
  MANAGE_MEDIA = 'p:med',
  VIEW_POST = 'p:view',

  // Reviewer actions
  APPROVE = 'r:app',
  REQUEST_REVISION = 'r:rev',
  REJECT_PROMPT = 'r:rej',
  REJECT_CONFIRM = 'r:rej_ok',

  // Publication & scheduling
  PUBLISH_NOW = 'pub:now',
  SCHEDULE_PROMPT = 'pub:sch',
  CANCEL_SCHEDULE_PROMPT = 'pub:sch_c',
  CANCEL_SCHEDULE_CONFIRM = 'pub:sch_ok',
  RETRY_PUBLISH = 'pub:ret',

  // Scheduling Presets
  PRESET_1H = 'sch_p:1h',
  PRESET_3H = 'sch_p:3h',
  PRESET_TOMORROW_10 = 'sch_p:t10',
  PRESET_TOMORROW_18 = 'sch_p:t18',
}

export interface PostCallbackPayload {
  action: PostCallbackAction;
  postId: string;
  expectedVersion: number;
}

export class CallbackCodec {
  /**
   * Serializes action, postId, and expectedVersion into a compact callback data string.
   * Throws an error if the byte length exceeds 64 bytes.
   */
  static encode(action: PostCallbackAction, postId: string, expectedVersion: number): string {
    const serialized = `${action}:${postId}:${expectedVersion}`;
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > 64) {
      throw new Error(`Callback data exceeds 64-byte limit (${byteLength} bytes): "${serialized}"`);
    }
    return serialized;
  }

  /**
   * Serializes a read-only post view action without version tracking.
   */
  static encodeView(postId: string): string {
    const serialized = `${PostCallbackAction.VIEW_POST}:${postId}`;
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > 64) {
      throw new Error(`Callback data exceeds 64-byte limit (${byteLength} bytes): "${serialized}"`);
    }
    return serialized;
  }

  /**
   * Deserializes callback data string.
   * Returns null if string does not match expected format or action is unknown.
   */
  static decode(data: string): PostCallbackPayload | null {
    if (!data || typeof data !== 'string') return null;

    const parts = data.split(':');
    if (parts.length < 3) return null;

    const versionStr = parts.pop();
    const postId = parts.pop();
    const actionStr = parts.join(':');

    if (!postId || !versionStr) return null;

    const version = parseInt(versionStr, 10);
    if (Number.isNaN(version) || version < 1) return null;

    const validActions = Object.values(PostCallbackAction) as string[];
    if (!validActions.includes(actionStr)) return null;

    return {
      action: actionStr as PostCallbackAction,
      postId,
      expectedVersion: version,
    };
  }
}
