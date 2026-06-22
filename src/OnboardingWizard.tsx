import { useEffect, useMemo, useState } from "react"
import catIcon from "./assets/cat-icon.png"
import { createColdStartItems, INVENTORY_STATUS_OPTIONS, summarizeColdStart } from "./model/coldStart"
import { createDefaultHouseholdProfile, PROFILE_OPTIONS } from "./model/householdProfile"
import { buildTemplateRecommendations, createDefaultDecisions, type TemplateRecommendation } from "./model/onboarding"
import type {
  HouseholdProfile,
  InventoryStatus,
  OnboardingState,
  OnboardingStep,
  TemplateDecision
} from "./types"

export type OnboardingCompletion = {
  profile: HouseholdProfile
  skippedProfile: boolean
  selections: Array<TemplateRecommendation & { inventoryStatus: InventoryStatus }>
  decisions: Record<string, TemplateDecision>
}

type OnboardingWizardProps = {
  initialProfile: HouseholdProfile | null
  onboarding: OnboardingState
  isRerun?: boolean
  existingTemplateIds?: string[]
  onProgress: (profile: HouseholdProfile, patch: Partial<OnboardingState>) => void
  onSkip: () => void
  onComplete: (result: OnboardingCompletion) => void
}

const STEP_LABELS = ["了解", "家庭画像", "推荐清单", "库存状态", "完成"]

function decisionsFromState(onboarding: OnboardingState, profile: HouseholdProfile) {
  const defaults = createDefaultDecisions(buildTemplateRecommendations(profile))
  onboarding.managedTemplateIds?.forEach((id) => { defaults[id] = "manage" })
  onboarding.notUsedTemplateIds?.forEach((id) => { defaults[id] = "notUsed" })
  onboarding.deferredTemplateIds?.forEach((id) => { defaults[id] = "defer" })
  return defaults
}

export function OnboardingWizard({ initialProfile, onboarding, isRerun = false, existingTemplateIds = [], onProgress, onSkip, onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<OnboardingStep>(onboarding.currentStep)
  const [profile, setProfile] = useState<HouseholdProfile>(() => initialProfile ?? createDefaultHouseholdProfile())
  const [skippedProfile, setSkippedProfile] = useState(onboarding.skippedProfile)
  const recommendations = useMemo(() => buildTemplateRecommendations(profile), [profile])
  const [decisions, setDecisions] = useState<Record<string, TemplateDecision>>(() => decisionsFromState(onboarding, profile))
  const [inventoryStatuses, setInventoryStatuses] = useState<Record<string, InventoryStatus>>(() => onboarding.inventoryStatuses ?? {})
  const [previewNow] = useState(() => Date.now())
  const existingTemplateSet = useMemo(() => new Set(existingTemplateIds), [existingTemplateIds])

  useEffect(() => {
    setDecisions((current) => {
      const defaults = createDefaultDecisions(recommendations)
      Object.keys(defaults).forEach((id) => {
        if (current[id]) defaults[id] = current[id]
      })
      return defaults
    })
  }, [recommendations])

  const managedRecommendations = recommendations.filter(({ template }) => decisions[template.id] === "manage")
  const selectedForCreation = managedRecommendations.map((recommendation) => ({
    ...recommendation,
    inventoryStatus: inventoryStatuses[recommendation.template.id] ?? "unknown" as InventoryStatus
  }))
  const previewItems = useMemo(() => createColdStartItems(
    profile,
    selectedForCreation.map(({ template, inventoryStatus }) => ({ template, inventoryStatus })),
    previewNow
  ), [profile, previewNow, selectedForCreation.map(({ template, inventoryStatus }) => `${template.id}:${inventoryStatus}`).join("|")])
  const summary = useMemo(() => summarizeColdStart(previewItems, previewNow), [previewItems, previewNow])

  function persist(nextStep: OnboardingStep, nextSkippedProfile = skippedProfile, nextInventoryStatuses = inventoryStatuses) {
    const now = Date.now()
    const managedTemplateIds = recommendations.filter(({ template }) => decisions[template.id] === "manage").map(({ template }) => template.id)
    const notUsedTemplateIds = recommendations.filter(({ template }) => decisions[template.id] === "notUsed").map(({ template }) => template.id)
    const deferredTemplateIds = recommendations.filter(({ template }) => decisions[template.id] === "defer").map(({ template }) => template.id)
    setStep(nextStep)
    onProgress({ ...profile, updatedAt: now }, {
      currentStep: nextStep,
      skippedProfile: nextSkippedProfile,
      managedTemplateIds,
      notUsedTemplateIds,
      deferredTemplateIds,
      inventoryStatuses: nextInventoryStatuses
    })
  }

  function updateProfile<Key extends keyof HouseholdProfile>(key: Key, value: HouseholdProfile[Key]) {
    const next = { ...profile, [key]: value, updatedAt: Date.now() }
    setProfile(next)
    setSkippedProfile(false)
    onProgress(next, { currentStep: 2, skippedProfile: false })
  }

  function skipProfile() {
    const defaults = createDefaultHouseholdProfile(profile.createdAt)
    const defaultRecommendations = buildTemplateRecommendations(defaults)
    const defaultDecisions = createDefaultDecisions(defaultRecommendations)
    setProfile(defaults)
    setSkippedProfile(true)
    setDecisions(defaultDecisions)
    setInventoryStatuses({})
    const now = Date.now()
    onProgress({ ...defaults, updatedAt: now }, {
      currentStep: 3,
      skippedProfile: true,
      managedTemplateIds: defaultRecommendations.filter(({ template }) => defaultDecisions[template.id] === "manage").map(({ template }) => template.id),
      notUsedTemplateIds: [],
      deferredTemplateIds: defaultRecommendations.filter(({ template }) => defaultDecisions[template.id] === "defer").map(({ template }) => template.id),
      inventoryStatuses: {}
    })
    setStep(3)
  }

  function updateInventoryStatus(templateId: string, status: InventoryStatus) {
    const next = { ...inventoryStatuses, [templateId]: status }
    setInventoryStatuses(next)
    onProgress(profile, { currentStep: 4, inventoryStatuses: next })
  }

  return (
    <div className="onboarding-shell">
      <header className="onboarding-titlebar">
        <div className="onboarding-brand"><img src={catIcon} alt="" /><span>403家庭管家</span></div>
        <button className="onboarding-skip-link" onClick={onSkip}>{isRerun ? "退出向导" : "跳过，我想自己添加"}</button>
      </header>

      <nav className="onboarding-progress" aria-label="初始化进度">
        {STEP_LABELS.map((label, index) => {
          const value = index + 1
          return <div key={label} className={`onboarding-progress-step ${value === step ? "is-current" : ""} ${value < step ? "is-done" : ""}`}><span>{value < step ? "✓" : value}</span><small>{label}</small></div>
        })}
      </nav>

      <main className={`onboarding-stage step-${step}`}>
        {step === 1 && (
          <section className="onboarding-welcome">
            <div className="onboarding-welcome-copy">
              <span className="onboarding-kicker">大约 1 分钟</span>
              <h1>不用盘点库存，<br />先让家里的补货提醒跑起来。</h1>
              <p>告诉我一点家里的情况，我会准备一份常用消耗品清单。你只需要判断“大概还多不多”，不用一个个算。</p>
              <div className="onboarding-principles">
                <span><b>01</b>自动推荐常用品</span>
                <span><b>02</b>先给出保守提醒</span>
                <span><b>03</b>补货越多，预测越准</span>
              </div>
              <button className="onboarding-primary" onClick={() => persist(2)}>开始设置 <span>→</span></button>
            </div>
            <div className="onboarding-welcome-visual" aria-hidden="true">
              <div className="onboarding-orbit orbit-one"><span>洗衣液</span></div>
              <div className="onboarding-orbit orbit-two"><span>卷纸</span></div>
              <div className="onboarding-orbit orbit-three"><span>垃圾袋</span></div>
              <div className="onboarding-cat-card"><img src={catIcon} alt="" /><strong>交给我吧</strong><small>先做一版，后面慢慢校准</small></div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="onboarding-panel profile-step">
            <div className="onboarding-section-heading"><div><span className="onboarding-kicker">家庭画像</span><h1>你家大概是什么节奏？</h1></div><p>这些只用来修正初始周期，不是精确建模。</p></div>
            <div className="profile-question-grid">
              <ProfileQuestion title="常住人数" options={PROFILE_OPTIONS.residentCount} value={profile.residentCount} onChange={(value) => updateProfile("residentCount", value)} />
              <ProfileQuestion title="家里有小孩吗" options={PROFILE_OPTIONS.children} value={profile.children} onChange={(value) => updateProfile("children", value)} />
              <ProfileQuestion title="家里有宠物吗" options={PROFILE_OPTIONS.pets} value={profile.pets} onChange={(value) => updateProfile("pets", value)} />
              <ProfileQuestion title="做饭频率" options={PROFILE_OPTIONS.cookingFrequency} value={profile.cookingFrequency} onChange={(value) => updateProfile("cookingFrequency", value)} />
              <ProfileQuestion title="洗衣频率" options={PROFILE_OPTIONS.laundryFrequency} value={profile.laundryFrequency} onChange={(value) => updateProfile("laundryFrequency", value)} />
              <ProfileQuestion title="居住情况" options={PROFILE_OPTIONS.homeSize} value={profile.homeSize} onChange={(value) => updateProfile("homeSize", value)} />
            </div>
            <WizardFooter onBack={() => persist(1)} secondaryLabel="跳过问卷，使用常见设置" onSecondary={skipProfile} primaryLabel="生成推荐清单" onPrimary={() => persist(3)} />
          </section>
        )}

        {step === 3 && (
          <section className="onboarding-panel recommendation-step">
            <div className="onboarding-section-heading"><div><span className="onboarding-kicker">推荐清单</span><h1>哪些东西，想让管家帮你看着？</h1></div><p>已按家庭情况筛选。你随时可以在主界面增删。</p></div>
            {isRerun && (
              <div className="onboarding-rerun-notice">
                重新设置只会补充新增物品，不会删除你已经管理的物品和历史记录。如需停止管理某项，请到主界面执行带确认的删除操作。
              </div>
            )}
            <div className="recommendation-groups">
              {[...new Set(recommendations.map(({ template }) => template.category))].map((category) => (
                <section key={category} className="recommendation-group">
                  <div className="recommendation-group-title"><h2>{category}</h2><span>{recommendations.filter(({ template }) => template.category === category).length} 项</span></div>
                  <div className="recommendation-list">
                    {recommendations.filter(({ template }) => template.category === category).map(({ template, reason }) => {
                      const alreadyManaged = isRerun && existingTemplateSet.has(template.id)
                      return (
                        <div key={template.id} className={`recommendation-row decision-${decisions[template.id]} ${alreadyManaged ? "is-existing" : ""}`}>
                          <div><strong>{template.name}</strong><small>{reason} · 约 {template.minCycleDays}-{template.maxCycleDays} 天</small></div>
                          <div className="decision-control" aria-label={`${template.name}管理方式`}>
                            {alreadyManaged ? (
                              <span className="recommendation-existing-badge">已在管理</span>
                            ) : (
                              ([["manage", "管理"], ["defer", "暂不管理"], ["notUsed", "我家不用"]] as Array<[TemplateDecision, string]>).map(([value, label]) => (
                                <button key={value} className={decisions[template.id] === value ? "is-selected" : ""} onClick={() => setDecisions((current) => ({ ...current, [template.id]: value }))}>{label}</button>
                              ))
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
            <WizardFooter onBack={() => persist(2)} note={`将初始化 ${managedRecommendations.length} 件消耗品`} primaryLabel="下一步：看看库存" onPrimary={() => persist(4)} primaryDisabled={managedRecommendations.length === 0} />
          </section>
        )}

        {step === 4 && (
          <section className="onboarding-panel inventory-step">
            <div className="onboarding-section-heading"><div><span className="onboarding-kicker">库存状态</span><h1>不用数，凭印象选就行。</h1></div><p>默认是“不确定”。不确定的项目会用更柔和的方式提醒。</p></div>
            <div className="inventory-list">
              {managedRecommendations.map(({ template }) => (
                <div key={template.id} className="inventory-row">
                  <div><span className="inventory-category">{template.category}</span><strong>{template.name}</strong><small>默认周期约 {template.defaultCycleDays} 天</small></div>
                  <div className="inventory-options">
                    {INVENTORY_STATUS_OPTIONS.map((option) => {
                      const selected = (inventoryStatuses[template.id] ?? "unknown") === option.value
                      return <button key={option.value} className={selected ? "is-selected" : ""} onClick={() => updateInventoryStatus(template.id, option.value)}>{option.label}</button>
                    })}
                  </div>
                </div>
              ))}
            </div>
            <WizardFooter onBack={() => persist(3)} secondaryLabel="全部按不确定处理" onSecondary={() => { setInventoryStatuses({}); persist(5, skippedProfile, {}) }} primaryLabel="生成第一版提醒" onPrimary={() => persist(5)} />
          </section>
        )}

        {step === 5 && (
          <section className="onboarding-complete">
            <div className="onboarding-complete-mark"><span>✓</span></div>
            <span className="onboarding-kicker">第一版模型已准备好</span>
            <h1>先用起来，精准的事交给时间。</h1>
            <p>前几次提醒会用来校准，之后会根据真实补货行为越来越准。</p>
            <div className="onboarding-summary">
              <div><strong>{summary.created}</strong><span>已选管理物品</span></div>
              <div><strong>{summary.within7Days}</strong><span>7 天内可能关注</span></div>
              <div><strong>{summary.within30Days}</strong><span>30 天内可能关注</span></div>
            </div>
            <div className="onboarding-complete-actions">
              <button className="onboarding-back" onClick={() => persist(4)}>返回调整</button>
              <button className="onboarding-primary" onClick={() => onComplete({ profile, skippedProfile, selections: selectedForCreation, decisions })}>进入家庭管家 <span>→</span></button>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function ProfileQuestion<Value extends string | number>({ title, options, value, onChange }: {
  title: string
  options: Array<{ value: Value; label: string }>
  value: Value
  onChange: (value: Value) => void
}) {
  return (
    <fieldset className="profile-question">
      <legend>{title}</legend>
      <div>{options.map((option) => <button type="button" key={String(option.value)} className={value === option.value ? "is-selected" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
    </fieldset>
  )
}

function WizardFooter({ onBack, note, secondaryLabel, onSecondary, primaryLabel, onPrimary, primaryDisabled }: {
  onBack: () => void
  note?: string
  secondaryLabel?: string
  onSecondary?: () => void
  primaryLabel: string
  onPrimary: () => void
  primaryDisabled?: boolean
}) {
  return (
    <footer className="onboarding-footer">
      <button className="onboarding-back" onClick={onBack}>← 返回</button>
      <div>{note && <span className="onboarding-footer-note">{note}</span>}{secondaryLabel && onSecondary && <button className="onboarding-secondary" onClick={onSecondary}>{secondaryLabel}</button>}<button className="onboarding-primary" disabled={primaryDisabled} onClick={onPrimary}>{primaryLabel} <span>→</span></button></div>
    </footer>
  )
}
