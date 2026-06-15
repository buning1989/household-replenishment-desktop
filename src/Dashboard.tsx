type DashboardProps = {
  total: number
  urgent: number
  warning: number
  sufficient: number
  monthlySpend: number
  monthlyBudget?: number
  monthLabel: string
  onOpenSettings: () => void
}

const currency = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
})

function formatMoney(value: number): string {
  return currency.format(value)
}

export function Dashboard({
  total,
  urgent,
  warning,
  sufficient,
  monthlySpend,
  monthlyBudget,
  monthLabel,
  onOpenSettings
}: DashboardProps) {
  const hasBudget = Number(monthlyBudget || 0) > 0
  const budget = hasBudget ? Number(monthlyBudget) : 0
  const budgetPercent = hasBudget ? Math.round((monthlySpend / budget) * 100) : 0
  const budgetProgress = Math.min(100, Math.max(0, budgetPercent))
  const budgetRemaining = budget - monthlySpend
  const statusSegments = [
    { label: "急需补充", value: urgent, tone: "urgent" },
    { label: "快用完", value: warning, tone: "warning" },
    { label: "充足", value: sufficient, tone: "sufficient" }
  ] as const

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-title">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">{monthLabel}生活概览</p>
          <h2 id="dashboard-title">家里现在怎么样</h2>
        </div>
        <span>数据来自补货清单与金额记录</span>
      </div>

      <div className="dashboard-grid">
        <article className="dashboard-card status-dashboard-card">
          <div className="dashboard-card-heading">
            <div>
              <span>消耗品状态</span>
              <strong>{total}<small> 项正在监测</small></strong>
            </div>
            <span className="dashboard-note">按当前余量</span>
          </div>

          <div
            className="status-distribution"
            role="img"
            aria-label={`共监测 ${total} 项，急需补充 ${urgent} 项，快用完 ${warning} 项，充足 ${sufficient} 项`}
          >
            {total === 0
              ? <span className="status-segment empty" style={{ width: "100%" }} />
              : statusSegments.map((segment) => (
                segment.value > 0 && (
                  <span
                    key={segment.tone}
                    className={`status-segment ${segment.tone}`}
                    style={{ width: `${(segment.value / total) * 100}%` }}
                  />
                )
              ))}
          </div>

          <div className="status-metrics">
            {statusSegments.map((segment) => (
              <div className="status-metric" key={segment.tone}>
                <span className="status-metric-label">
                  <span className={`dashboard-dot ${segment.tone}`} />
                  <span>{segment.label}</span>
                </span>
                <strong>{segment.value}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="dashboard-card budget-dashboard-card">
          <div className="dashboard-card-heading">
            <div>
              <span>成本与预算</span>
              <strong>{formatMoney(monthlySpend)}<small> 本月消费</small></strong>
            </div>
            <span className="dashboard-note">仅统计已记录金额</span>
          </div>

          {hasBudget ? (
            <>
              <div className="budget-summary">
                <span>预算已使用 <strong>{budgetPercent}%</strong></span>
                <span className={budgetRemaining < 0 ? "over-budget" : ""}>
                  {budgetRemaining >= 0 ? `还剩 ${formatMoney(budgetRemaining)}` : `超出 ${formatMoney(Math.abs(budgetRemaining))}`}
                </span>
              </div>
              <div
                className="budget-progress"
                role="progressbar"
                aria-label="本月生活预算使用进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={budgetProgress}
              >
                <span className={budgetPercent > 100 ? "over-budget" : budgetPercent >= 80 ? "near-budget" : ""} style={{ width: `${budgetProgress}%` }} />
              </div>
              <div className="budget-footnote">
                <span>本月预算 {formatMoney(budget)}</span>
                <button type="button" onClick={onOpenSettings}>调整预算</button>
              </div>
            </>
          ) : (
            <div className="budget-empty">
              <div><strong>还没有设置月预算</strong><span>设置后即可查看消耗占比与剩余额度。</span></div>
              <button type="button" onClick={onOpenSettings}>设置预算</button>
            </div>
          )}
        </article>
      </div>
    </section>
  )
}
