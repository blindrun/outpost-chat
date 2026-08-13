// What to do about the encrypted bodies in the open conversation.
//
// Split out of App.tsx because the bug this exists to prevent was never in the
// decryption itself — it was in *when* the decision got made. Two separate
// pieces of state have to agree first (which channel is open, and which channel
// the key state was resolved for), and getting that wrong is invisible to a
// typechecker and awkward to reach through the UI. Here it is a pure function
// with a test.

/** An encrypted body still awaiting a result, and the id to file it under. */
export interface PendingDecrypt {
  id: string;
  payload: string;
}

/** Only the fields this decision reads. Message (api.ts) satisfies it. */
export interface DecryptableMessage {
  id: string;
  encryptedPayload?: string | null;
  replyTo?: { id: string; encryptedPayload?: string | null } | null;
}

export type DecryptPlan =
  /**
   * The key state describes some other channel, so we don't yet know whether
   * this one is readable. Do nothing: "no key" and "haven't looked" are the
   * same shape, and acting on the wrong one caches a permanent failure.
   */
  | { kind: "wait" }
  /** Nothing encrypted is outstanding. */
  | { kind: "idle" }
  /**
   * Settled: this device holds no identity at all, so nothing here can derive
   * a key for any conversation. Record that rather than leaving the bodies to
   * render as though a result were still coming.
   */
  | { kind: "unreadable"; pending: PendingDecrypt[] }
  /** We hold a key resolved for this channel. Decrypt with it. */
  | { kind: "decrypt"; pending: PendingDecrypt[] };

export interface DecryptPlanInput {
  /** The channel currently on screen. */
  selectedChannelId: string | null;
  /** The channel the current key state was resolved against. */
  forChannelId: string | null;
  /** A conversation key resolved for `forChannelId`, if this device has one. */
  hasKey: boolean;
  /**
   * Why there is no key, from resolveDmCrypto (crypto/dm.ts).
   *
   * Only `"self"` is a settled answer: it means this device holds no identity,
   * which is read straight off local storage and won't change on its own.
   * `"peer"` means the peer's public key was absent — but the member list is
   * fetched asynchronously and starts empty, so that is equally the shape of
   * "we haven't loaded them yet". Recording a permanent failure on it would
   * brand a conversation unreadable purely for being opened early.
   */
  reason?: "self" | "peer";
  /** Messages loaded for the selected channel. */
  messages: DecryptableMessage[];
  /** Results so far. `null` is a recorded permanent failure, not a miss. */
  decrypted: Record<string, string | null>;
}

/**
 * Reply targets are included because a quote renders the original's body, and
 * a quoted encrypted message is just as unreadable as the message itself.
 */
export function pendingDecrypts(
  messages: DecryptableMessage[],
  decrypted: Record<string, string | null>,
): PendingDecrypt[] {
  return messages.flatMap((m) => {
    const items: PendingDecrypt[] = [];
    if (m.encryptedPayload && decrypted[m.id] === undefined) {
      items.push({ id: m.id, payload: m.encryptedPayload });
    }
    if (m.replyTo?.encryptedPayload && decrypted[m.replyTo.id] === undefined) {
      items.push({ id: m.replyTo.id, payload: m.replyTo.encryptedPayload });
    }
    return items;
  });
}

export function planDecrypt(input: DecryptPlanInput): DecryptPlan {
  const { selectedChannelId, forChannelId, hasKey, reason, messages, decrypted } = input;
  if (!selectedChannelId || forChannelId !== selectedChannelId) return { kind: "wait" };

  const pending = pendingDecrypts(messages, decrypted);
  if (pending.length === 0) return { kind: "idle" };

  if (hasKey) return { kind: "decrypt", pending };
  // Anything short of "this device has no identity" stays pending rather than
  // being written off — see `reason` above. Waiting shows a spinner, which is
  // wrong but recoverable; recording a failure is permanent until reload.
  return reason === "self" ? { kind: "unreadable", pending } : { kind: "wait" };
}
