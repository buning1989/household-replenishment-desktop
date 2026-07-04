export type AgentLocalIntent = "confirmDraft" | "cancelDraft" | "pendingStatus" | "reviseDraft" | "writeDraft" | "query"

function compact(value: string): string {
  return value.trim().replace(/[\s，。！？、,.!?]/g, "")
}

export function classifyAgentIntent(text: string, hasPendingDraft: boolean): AgentLocalIntent {
  const normalized = compact(text)
  if (hasPendingDraft && /^(确认|确认创建|确认记录|确认补货|确认补货单|可以创建|可以记录|可以|没问题|就这样|对的|好的|好)$/.test(normalized)) {
    return "confirmDraft"
  }
  if (hasPendingDraft && /^(取消|不要了|不用了|先不|暂不|放弃)$/.test(normalized)) return "cancelDraft"
  if (hasPendingDraft && /^(创建了么|创建了吗|创建了没|记录了吗|记录了么|补货单创建了吗|创建补货单了么|改了么|改了吗|成功了吗|创建成功了吗|已经创建了吗|有创建吗|有没有创建)$/.test(normalized)) {
    return "pendingStatus"
  }
  if (hasPendingDraft && /(周期|补货周期|平台|商家|京东|淘宝|天猫|拼多多|数量|价格|金额|花了|块|元|包|瓶|袋|盒|支|卷)/.test(normalized)) {
    return "reviseDraft"
  }
  if (/买了|下单|购入|补货单|补货记录|添加|新建|创建|录入|登记|帮我加|加一个|加个/.test(normalized)) {
    return "writeDraft"
  }
  return "query"
}

export function shouldSkipQuickAnswerForAgent(text: string): boolean {
  return classifyAgentIntent(text, false) === "writeDraft"
}
