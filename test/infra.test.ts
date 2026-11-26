import { TABLE_DEFINITION, TTL_ATTRIBUTE } from "@blevinstein/chat-state-dynamodb";
import { describe, expect, it } from "vitest";
import { adminClaimParameter } from "../src/lambda/admin-claim-record.js";
import {
  approvedParameter,
  approverParameter,
  blockedParameter,
  mcpApprovalParameter,
  scopedChatParameter,
} from "../src/lambda/connection-paths.js";
import {
  DEFAULT_FAILURE_NOTICE_MINUTES,
  FAILURE_NOTICE_MINUTES_LIMIT,
} from "../src/lambda/dispatch-failure-notice.js";
import {
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_TTL_DAYS,
  HISTORY_MAX_MESSAGES_LIMIT,
  HISTORY_TTL_DAYS_LIMIT,
} from "../src/lambda/history-window.js";
import { STATE_TABLE_PARAMETER } from "../src/lambda/parameters.js";
import { lambdaMayOnParameter, template } from "./helpers/infra-fixtures.js";

const BOT = "garden";
const MCP_APPROVAL = mcpApprovalParameter(BOT, "linear", "0123456789abcdef");

describe("the Lambda role's parameter permissions", () => {
  it.each([
    ["an approved chat", approvedParameter(BOT, "telegram", "chat", "-100500")],
    ["an approved user", approvedParameter(BOT, "slack", "user", "U1")],
    ["a blocked chat", blockedParameter(BOT, "slack", "chat", "C1")],
    ["an approver", approverParameter(BOT, "slack", "U1")],
    ["a chat alias", scopedChatParameter("telegram", "ops")],
    ["an MCP approval", MCP_APPROVAL],
  ])("can write %s", (_what, name) => {
    expect(lambdaMayOnParameter("ssm:PutParameter", name)).toBe(true);
  });

  it.each([
    ["a chat alias", scopedChatParameter("telegram", "ops")],
    ["an MCP approval", MCP_APPROVAL],
    ["an admin claim", adminClaimParameter("telegram")],
  ])("can read %s", (_what, name) => {
    expect(lambdaMayOnParameter("ssm:GetParameter", name)).toBe(true);
  });

  it("can delete approver entries and admin claims, but not access entries", () => {
    const deletable = (name: string) => lambdaMayOnParameter("ssm:DeleteParameter", name);
    expect(deletable(approverParameter(BOT, "slack", "U1"))).toBe(true);
    expect(deletable(adminClaimParameter("telegram"))).toBe(true);
    expect(deletable(approvedParameter(BOT, "slack", "user", "U1"))).toBe(false);
    expect(deletable(MCP_APPROVAL)).toBe(false);
  });
});

describe("the state table", () => {
  const { StateTable } = template.Resources;

  it("has the schema and TTL attribute the state adapter expects", () => {
    const { AttributeDefinitions, KeySchema, BillingMode } = StateTable.Properties;
    expect({ AttributeDefinitions, KeySchema, BillingMode }).toEqual(TABLE_DEFINITION);
    expect(StateTable.Properties.TimeToLiveSpecification).toEqual({
      AttributeName: TTL_ATTRIBUTE,
      Enabled: true,
    });
  });

  it("publishes its name at the SSM parameter the CLI reads", () => {
    expect(template.Resources.StateTableParameter.Properties.Name).toBe(STATE_TABLE_PARAMETER);
  });
});

describe("the receiver's environment", () => {
  const environment = template.Resources.ReceiverFunction.Properties.Environment.Variables;

  it("has template parameters matching the code's history window defaults and bounds", () => {
    expect(template.Parameters.HistoryMaxMessages).toMatchObject({
      Default: DEFAULT_HISTORY_MAX_MESSAGES,
      MinValue: 1,
      MaxValue: HISTORY_MAX_MESSAGES_LIMIT,
    });
    expect(template.Parameters.HistoryTtlDays).toMatchObject({
      Default: DEFAULT_HISTORY_TTL_DAYS,
      MinValue: 1,
      MaxValue: HISTORY_TTL_DAYS_LIMIT,
    });
  });

  it("has a template parameter matching the code's dispatch failure notice default and bounds", () => {
    expect(template.Parameters.DispatchFailureNoticeMinutes).toMatchObject({
      Default: DEFAULT_FAILURE_NOTICE_MINUTES,
      MinValue: 0,
      MaxValue: FAILURE_NOTICE_MINUTES_LIMIT,
    });
  });

  it("passes the settings and the bucket the code reads", () => {
    expect(Object.keys(environment)).toEqual(
      expect.arrayContaining([
        "HISTORY_MAX_MESSAGES",
        "HISTORY_TTL_DAYS",
        "DISPATCH_FAILURE_NOTICE_MINUTES",
        "SESSION_BUCKET_NAME",
      ]),
    );
  });
});
