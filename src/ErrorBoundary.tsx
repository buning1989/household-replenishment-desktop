import { Component, type ErrorInfo, type ReactNode } from "react"

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// 顶层 Error Boundary：捕获子树在 render / lifecycle 阶段抛出的异常，
// 避免整页白屏。fallback UI 提供重新加载与复制错误信息两个动作。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不吞 console.error，便于开发期定位
    console.error("[ErrorBoundary] caught render error", error, info)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleCopy = async (): Promise<void> => {
    const { error } = this.state
    if (!error) return
    const text = `${error.name}: ${error.message}\n${error.stack ?? ""}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        console.warn("[ErrorBoundary] clipboard API unavailable")
      }
    } catch (copyError) {
      // clipboard 不可用时不再次崩
      console.warn("[ErrorBoundary] failed to copy error info", copyError)
    }
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const summary = error.message || error.name || "未知错误"

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
          color: "#1f1f1f",
          background: "#f3f1ec"
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            padding: 24,
            background: "#ffffff",
            borderRadius: 12,
            boxShadow: "0 4px 16px rgba(0,0,0,0.08)"
          }}
        >
          <h1 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600 }}>
            应用出错了
          </h1>
          <p style={{ margin: "0 0 16px", fontSize: 14, color: "#6b6b6b" }}>
            页面渲染时遇到问题。可以尝试重新加载，或复制错误信息反馈给开发者。
          </p>
          <pre
            style={{
              margin: "0 0 16px",
              padding: 12,
              background: "#f5f5f5",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 200,
              overflow: "auto"
            }}
          >
            {summary}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontSize: 14,
                color: "#ffffff",
                background: "#111",
                border: "none",
                borderRadius: 6,
                cursor: "pointer"
              }}
            >
              重新加载应用
            </button>
            <button
              type="button"
              onClick={() => {
                void this.handleCopy()
              }}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontSize: 14,
                color: "#111",
                background: "#ffffff",
                border: "1px solid #d0d0d0",
                borderRadius: 6,
                cursor: "pointer"
              }}
            >
              复制错误信息
            </button>
          </div>
        </div>
      </div>
    )
  }
}
