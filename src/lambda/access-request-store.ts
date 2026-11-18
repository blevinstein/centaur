import { randomInt } from "node:crypto";
import type { StateAdapter } from "chat";
import type { AccessKind } from "./access-entries.js";

export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUESTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LENGTH = 6;
const ID_ATTEMPTS = 5;

export type Verdict = "approve" | "deny";

export interface AccessRequest {
  id: string;
  kind: AccessKind;
  subjectId: string;
  subjectName: string;
  threadId: string;
  createdAt: string;
}

export interface AccessRequestLimits {
  ttlMs: number;
  perHour: number;
}

const requestKey = (id: string) => `access-request:${id}`;
const claimKey = (id: string) => `access-request-claim:${id}`;
const subjectKey = (kind: AccessKind, subjectId: string) => `access-subject:${kind}:${subjectId}`;
const noticeKey = (kind: AccessKind, subjectId: string) => `access-notice:${kind}:${subjectId}`;
const messageKey = (messageId: string) => `access-request-message:${messageId}`;
const RATE_KEY = "access-request-rate";

const randomId = () =>
  Array.from({ length: ID_LENGTH }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

export const normalizeId = (value: string) => value.trim().toLowerCase();

export function createAccessRequestStore(
  state: StateAdapter,
  { ttlMs, perHour }: AccessRequestLimits = { ttlMs: REQUEST_TTL_MS, perHour: REQUESTS_PER_HOUR },
) {
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

    /** Reserves the subject's single pending slot; false when a request is already pending. */
    claimSubject: (kind: AccessKind, subjectId: string) =>
      state.setIfNotExists(subjectKey(kind, subjectId), true, ttlMs),

    async releaseSubject(kind: AccessKind, subjectId: string) {
      await state.delete(subjectKey(kind, subjectId));
      await state.delete(noticeKey(kind, subjectId));
    },

    /** True only the first time it is called for the subject's pending request. */
    claimPendingNotice: (kind: AccessKind, subjectId: string) =>
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

    linkMessage: (messageId: string, request: AccessRequest) =>
      state.set(messageKey(messageId), request.id, ttlMs),

    requestIdForMessage: (messageId: string) => state.get<string>(messageKey(messageId)),

    claimDecision: (id: string, verdict: Verdict) =>
      state.setIfNotExists(claimKey(id), verdict, ttlMs),

    releaseDecision: (id: string) => state.delete(claimKey(id)),
  };
}

export type AccessRequestStore = ReturnType<typeof createAccessRequestStore>;
