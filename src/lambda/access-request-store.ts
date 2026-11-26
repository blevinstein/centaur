import { randomInt } from "node:crypto";
import type { StateAdapter } from "chat";
import { ACCESS_KINDS, type AccessKind } from "./access-entries.js";

export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUESTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
const PLACEHOLDER_TTL_MS = 5 * 60 * 1000;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LENGTH = 6;
const ID_ATTEMPTS = 5;

export type Verdict = "approve" | "deny";

/** A sent message: reactions carry a message id that is only unique within its channel. */
export interface MessageRef {
  channelId: string;
  messageId: string;
}

/**
 * `mcp` requests approval of an MCP server definition, `approver` asks to join the approver set
 * (`subjectId` is the requester's user ID); the others grant a chat or a user access.
 */
export type RequestKind = AccessKind | "mcp" | "approver";

/** Denying a chat or user request blocks the subject; the other kinds only record the denial. */
export const blocksOnDeny = (kind: RequestKind) =>
  (ACCESS_KINDS as readonly string[]).includes(kind);

export interface AccessRequest {
  id: string;
  kind: RequestKind;
  /** For `mcp`, `<name>:<fingerprint>` of the server definition. */
  subjectId: string;
  subjectName: string;
  alias?: string;
  threadId: string;
  /** `mcp` only: the message that triggered the request, which a suspended turn resumes from. */
  messageId?: string;
  /** `mcp` only: a one-line description of the server, never trusted for the decision. */
  summary?: string;
  /** `mcp` only: the turn is waiting, so the decision re-dispatches the thread. */
  suspended?: boolean;
  createdAt: string;
}

export interface AccessRequestLimits {
  ttlMs: number;
  perHour: number;
}

const requestKey = (id: string) => `access-request:${id}`;
const claimKey = (id: string) => `access-request-claim:${id}`;
const subjectKey = (kind: RequestKind, subjectId: string) => `access-subject:${kind}:${subjectId}`;
const noticeKey = (kind: RequestKind, subjectId: string) => `access-notice:${kind}:${subjectId}`;
const messageKey = ({ channelId, messageId }: MessageRef) =>
  `access-request-message:${channelId}:${messageId}`;
const denialKey = (kind: RequestKind, subjectId: string) => `denied:${kind}:${subjectId}`;
const RATE_KEY = "access-request-rate";

const randomId = () =>
  Array.from({ length: ID_LENGTH }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

export const normalizeId = (value: string) => value.trim().toLowerCase();

export function createAccessRequestStore(
  state: StateAdapter,
  { ttlMs, perHour }: AccessRequestLimits = { ttlMs: REQUEST_TTL_MS, perHour: REQUESTS_PER_HOUR },
) {
  const isDecided = async (id: string) => (await state.get(claimKey(id))) != null;

  return {
    ttlMs,

    async overLimit() {
      const since = Date.now() - HOUR_MS;
      const recent = (await state.getList<number>(RATE_KEY)).filter((at) => at > since);
      return recent.length >= perHour;
    },

    async recordRequest() {
      await state.appendToList(RATE_KEY, Date.now(), { maxLength: perHour, ttlMs: HOUR_MS });
    },

    /**
     * Reserves the subject's single pending slot; false when a request is already pending. The
     * reservation is short-lived until `linkSubject` extends it, so a request cut off mid-creation
     * frees the subject soon.
     */
    claimSubject: (kind: RequestKind, subjectId: string) =>
      state.setIfNotExists(subjectKey(kind, subjectId), true, Math.min(ttlMs, PLACEHOLDER_TTL_MS)),

    /** Points the subject's pending slot at its request so the request can be found by subject. */
    linkSubject: (request: AccessRequest) =>
      state.set(subjectKey(request.kind, request.subjectId), request.id, ttlMs),

    /**
     * True when the subject's slot points at a request that no longer exists or was already decided.
     * A slot still holding the placeholder belongs to a request being created, so it is live.
     */
    async isSubjectSlotStale(kind: RequestKind, subjectId: string) {
      const id = await state.get<string | true>(subjectKey(kind, subjectId));
      if (typeof id !== "string") return false;
      return (await state.get(requestKey(id))) == null || (await isDecided(id));
    },

    /** Merges `fields` into the pending `mcp` request of the subject; false when none is pending. */
    async updatePending(subjectId: string, fields: Partial<AccessRequest>) {
      const id = await state.get<string>(subjectKey("mcp", subjectId));
      const request =
        typeof id === "string" ? await state.get<AccessRequest>(requestKey(id)) : null;
      if (!request || (await isDecided(request.id))) return false;
      const remaining = ttlMs - (Date.now() - Date.parse(request.createdAt));
      if (remaining <= 0) return false;
      await state.set(requestKey(request.id), { ...request, ...fields }, remaining);
      return true;
    },

    async releaseSubject(kind: RequestKind, subjectId: string) {
      await state.delete(subjectKey(kind, subjectId));
      await state.delete(noticeKey(kind, subjectId));
    },

    /** True only the first time it is called for the subject's pending request. */
    claimPendingNotice: (kind: RequestKind, subjectId: string) =>
      state.setIfNotExists(noticeKey(kind, subjectId), true, ttlMs),

    async create(fields: Omit<AccessRequest, "id" | "createdAt">): Promise<AccessRequest> {
      for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
        const request = { ...fields, id: randomId(), createdAt: new Date().toISOString() };
        if (await state.setIfNotExists(requestKey(request.id), request, ttlMs)) return request;
      }
      throw new Error("could not allocate a unique access request id");
    },

    async remove(request: AccessRequest) {
      await state.delete(requestKey(request.id));
    },

    read: (id: string) => state.get<AccessRequest>(requestKey(normalizeId(id))),

    linkMessage: (message: MessageRef, request: AccessRequest) =>
      state.set(messageKey(message), request.id, ttlMs),

    requestIdForMessage: (message: MessageRef) => state.get<string>(messageKey(message)),

    /** A denied subject stays denied until the record expires; the record names who denied it. */
    recordDenial: (kind: RequestKind, subjectId: string, approver: string) =>
      state.set(denialKey(kind, subjectId), { at: new Date().toISOString(), approver }, ttlMs),

    isDenied: async (kind: RequestKind, subjectId: string) =>
      (await state.get(denialKey(kind, subjectId))) != null,

    isDecided,

    claimDecision: (id: string, verdict: Verdict) =>
      state.setIfNotExists(claimKey(id), verdict, ttlMs),

    releaseDecision: (id: string) => state.delete(claimKey(id)),
  };
}

export type AccessRequestStore = ReturnType<typeof createAccessRequestStore>;
