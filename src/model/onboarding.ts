import type { ConsumableTemplate, HouseholdProfile, OnboardingState, TemplateDecision } from "../types"
import { CONSUMABLE_TEMPLATES } from "./consumableTemplates"

export type TemplateRecommendation = {
  template: ConsumableTemplate
  reason: string
  defaultDecision: TemplateDecision
}

export function createInitialOnboardingState(now = Date.now()): OnboardingState {
  return {
    completed: false,
    rerun: false,
    currentStep: 1,
    skippedProfile: false,
    skipped: false,
    managedTemplateIds: [],
    notUsedTemplateIds: [],
    deferredTemplateIds: [],
    createdTemplateIds: [],
    inventoryStatuses: {},
    startedAt: now
  }
}

function triggerMatches(template: ConsumableTemplate, profile: HouseholdProfile): boolean {
  if (!template.trigger) return false
  if (template.trigger.kind === "pet") return template.trigger.values.includes(profile.pets)
  if (template.trigger.kind === "child") return template.trigger.values.includes(profile.children)
  return template.trigger.values.includes(profile.cookingFrequency)
}

function recommendationReason(template: ConsumableTemplate, profile: HouseholdProfile): string {
  if (template.activation === "default") return "多数家庭都会持续消耗"
  if (template.trigger?.kind === "pet") {
    if (profile.pets === "catAndDog") return "你选择了家里有猫和狗"
    return `你选择了家里有${profile.pets === "cat" ? "猫" : "狗"}`
  }
  if (template.trigger?.kind === "child") return "婴幼儿家庭可能需要"
  if (template.trigger?.kind === "cooking") return "你选择了经常在家做饭"
  return "可按你家的习惯选择"
}

export function buildTemplateRecommendations(profile: HouseholdProfile): TemplateRecommendation[] {
  return CONSUMABLE_TEMPLATES
    .filter((template) => template.activation !== "conditional" || triggerMatches(template, profile))
    .map((template) => ({
      template,
      reason: recommendationReason(template, profile),
      defaultDecision: template.activation === "recommended" ? "defer" : "manage"
    }))
}

export function createDefaultDecisions(recommendations: TemplateRecommendation[]): Record<string, TemplateDecision> {
  return Object.fromEntries(recommendations.map(({ template, defaultDecision }) => [template.id, defaultDecision]))
}
