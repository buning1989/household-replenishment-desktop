import { useEffect } from "react"
import catIcon from "./cat-icon.png"

export function LandingPage() {
  useEffect(() => {
    const elements = document.querySelectorAll(".fade-in")
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible")
          }
        })
      },
      { threshold: 0.12 }
    )
    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="landing">
      {/* Section 1: Hero */}
      <section className="landing-section hero">
        <div className="fade-in">
          <div className="hero-content">
            <h1 className="landing-h1">
              <img className="hero-icon" src={catIcon} alt="403 管家" />
              403 管家
            </h1>
            <p className="hero-subtitle">一个面向家庭日常消耗品的智能补货管家。</p>

            <div className="hero-tags">
              <span className="hero-tag">家庭消耗品</span>
              <span className="hero-tag">智能补货</span>
              <span className="hero-tag">语音输入</span>
              <span className="hero-tag">自动补货 Agent</span>
            </div>
            <div className="hero-actions">
              <a href="#solution" className="btn-primary">了解工作方式</a>
              <a href="#roadmap" className="btn-secondary">查看长期方向</a>
            </div>
          </div>
        </div>

        <div className="fade-in">
          <div className="hero-panel">
            <div className="hero-panel-header">
              <span className="hero-panel-dot"></span>
              <span className="hero-panel-dot"></span>
              <span className="hero-panel-dot"></span>
              <span className="hero-panel-title">403 管家</span>
            </div>
            <div className="hero-panel-body">
              <div className="panel-group">
                <div className="panel-group-label">今天该买</div>
                <div className="panel-item panel-item--urgent">
                  <span className="panel-item-name">
                    <span className="panel-item-dot"></span>
                    猫粮
                  </span>
                  <span className="panel-item-status">预计 2 天后用完</span>
                </div>
                <div className="panel-item panel-item--urgent">
                  <span className="panel-item-name">
                    <span className="panel-item-dot"></span>
                    垃圾袋
                  </span>
                  <span className="panel-item-status">建议今天补货</span>
                </div>
              </div>

              <div className="panel-group">
                <div className="panel-group-label">近期关注</div>
                <div className="panel-item panel-item--watch">
                  <span className="panel-item-name">
                    <span className="panel-item-dot"></span>
                    洗衣液
                  </span>
                  <span className="panel-item-status">预计 5 天后用完</span>
                </div>
                <div className="panel-item panel-item--watch">
                  <span className="panel-item-name">
                    <span className="panel-item-dot"></span>
                    抽纸
                  </span>
                  <span className="panel-item-status">预计 6 天后用完</span>
                </div>
              </div>

              <div className="panel-group">
                <div className="panel-group-label">暂时安全</div>
                <div className="panel-item panel-item--safe">
                  <span className="panel-item-name">
                    <span className="panel-item-dot"></span>
                    牙膏
                  </span>
                  <span className="panel-item-status">预计 18 天</span>
                </div>
                <div className="panel-item panel-item--safe">
                  <span className="panel-item-name">
                    <span className="panel-item-dot"></span>
                    猫砂
                  </span>
                  <span className="panel-item-status">预计 21 天</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Problem */}
      <section className="landing-section--full section-problem">
        <div className="landing-inner">
          <div className="fade-in">
            <div className="problem-header">
              <h2 className="landing-h2">家庭消耗品，不该一直靠记忆管理</h2>
            </div>
          </div>

          <div className="fade-in">
            <div className="problem-cards">
              <div className="problem-card">
                <div className="problem-card-number">01</div>
                <h3 className="problem-card-title">用完才发现</h3>
                <p className="problem-card-text">
                  纸巾、牙膏、洗衣液平时没人想，一断货就影响生活。
                </p>
              </div>
              <div className="problem-card">
                <div className="problem-card-number">02</div>
                <h3 className="problem-card-title">靠人记不住</h3>
                <p className="problem-card-text">
                  购物记录只知道买过什么，备忘录又需要人主动维护。
                </p>
              </div>
              <div className="problem-card">
                <div className="problem-card-number">03</div>
                <h3 className="problem-card-title">家庭协作混乱</h3>
                <p className="problem-card-text">
                  "你买了吗？""我以为你买了。"很多小摩擦来自信息不同步。
                </p>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* Section 3: Solution */}
      <section className="landing-section" id="solution">
        <div className="fade-in">
          <div className="solution-header">
            <h2 className="landing-h2">先知道什么时候该买，再谈自动帮你买</h2>
          </div>
        </div>

        <div className="fade-in">
          <div className="solution-steps">
            <div className="solution-step">
              <div className="solution-step-number">1</div>
              <h3 className="solution-step-title">轻量录入</h3>
              <p className="solution-step-text">添加常用消耗品，不强制精确清点库存。</p>
            </div>
            <div className="solution-step">
              <div className="solution-step-number">2</div>
              <h3 className="solution-step-title">消耗判断</h3>
              <p className="solution-step-text">根据当前状态和历史记录，判断预计可用时间。</p>
            </div>
            <div className="solution-step">
              <div className="solution-step-number">3</div>
              <h3 className="solution-step-title">补货提醒</h3>
              <p className="solution-step-text">在快用完之前提醒，并记录下单和到货信息。</p>
            </div>
          </div>
        </div>

      </section>

      {/* Section 4: Pipeline */}
      <section className="landing-section--full section-pipeline">
        <div className="landing-inner">
          <div className="fade-in">
            <div className="pipeline-header">
              <h2 className="landing-h2">一条完整的家庭补货链路</h2>
            </div>
          </div>

          <div className="fade-in">
            <div className="pipeline-timeline">
              <div className="pipeline-node">
                <div className="pipeline-node-dot">
                  <div className="pipeline-node-dot-inner"></div>
                </div>
                <div className="pipeline-node-label">添加物品</div>
              </div>
              <div className="pipeline-node">
                <div className="pipeline-node-dot">
                  <div className="pipeline-node-dot-inner"></div>
                </div>
                <div className="pipeline-node-label">设置状态</div>
              </div>
              <div className="pipeline-node">
                <div className="pipeline-node-dot">
                  <div className="pipeline-node-dot-inner"></div>
                </div>
                <div className="pipeline-node-label">生成提醒</div>
              </div>
              <div className="pipeline-node">
                <div className="pipeline-node-dot">
                  <div className="pipeline-node-dot-inner"></div>
                </div>
                <div className="pipeline-node-label">记录下单</div>
              </div>
              <div className="pipeline-node">
                <div className="pipeline-node-dot">
                  <div className="pipeline-node-dot-inner"></div>
                </div>
                <div className="pipeline-node-label">确认到货</div>
              </div>
              <div className="pipeline-node">
                <div className="pipeline-node-dot">
                  <div className="pipeline-node-dot-inner"></div>
                </div>
                <div className="pipeline-node-label">修正周期</div>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* Section 5: Voice */}
      <section className="landing-section">
        <div className="fade-in">
          <div className="voice-header">
            <h2 className="landing-h2">不用打开 App，也能告诉管家</h2>
          </div>
        </div>

        <div className="fade-in">
          <div className="voice-chat">
            <div className="voice-bubble voice-bubble--user">
              <div className="voice-bubble-role">用户</div>
              403，家里还有猫粮吗？
            </div>
            <div className="voice-bubble voice-bubble--assistant">
              <div className="voice-bubble-role">管家</div>
              猫粮预计还能用 5 天，建议这两天补货。
            </div>

            <div className="voice-divider"></div>

            <div className="voice-bubble voice-bubble--user">
              <div className="voice-bubble-role">用户</div>
              我刚买了两袋猫砂，明天到。
            </div>
            <div className="voice-bubble voice-bubble--assistant">
              <div className="voice-bubble-role">管家</div>
              已记录，明天提醒你确认到货。
            </div>
          </div>
        </div>
      </section>

      {/* Section 6: Roadmap */}
      <section className="landing-section--full section-roadmap" id="roadmap">
        <div className="landing-inner">
          <div className="fade-in">
            <div className="roadmap-header">
              <h2 className="landing-h2">从提醒你买，到帮你管好</h2>
            </div>
          </div>

          <div className="fade-in">
            <div className="roadmap-levels">
              <div className="roadmap-level">
                <div className="roadmap-level-stage">阶段一</div>
                <h3 className="roadmap-level-title">提醒</h3>
                <p className="roadmap-level-text">快用完时告诉你。</p>
              </div>
              <div className="roadmap-level">
                <div className="roadmap-level-stage">阶段二</div>
                <h3 className="roadmap-level-title">推荐</h3>
                <p className="roadmap-level-text">根据预算、品牌和到货时间给出建议。</p>
              </div>
              <div className="roadmap-level">
                <div className="roadmap-level-stage">阶段三</div>
                <h3 className="roadmap-level-title">代办</h3>
                <p className="roadmap-level-text">在用户授权规则内自动下单。</p>
              </div>
            </div>
          </div>

          <div className="fade-in">
            <div className="roadmap-boundary">
              <div className="roadmap-boundary-title">自动管理，不等于失去控制</div>
              <div className="roadmap-boundary-list">
                <span className="roadmap-boundary-tag">每月预算</span>
                <span className="roadmap-boundary-tag">品牌偏好</span>
                <span className="roadmap-boundary-tag">单次价格上限</span>
                <span className="roadmap-boundary-tag">异常价格需确认</span>
                <span className="roadmap-boundary-tag">替代商品需确认</span>
                <span className="roadmap-boundary-tag">完整购买记录</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 7: Footer */}
      <section className="landing-section section-footer">
        <div className="fade-in">
          <h2 className="landing-h2">403 管家，专门记住家里的小事</h2>
          <a href="#" className="btn-primary">了解 403 管家</a>
        </div>
      </section>
    </div>
  )
}
