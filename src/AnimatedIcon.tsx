import { useState } from "react"
import { motion, useReducedMotion } from "motion/react"

// Paths and motion ideas adapted from Its Hover icons (Apache-2.0).
// https://github.com/itshover/itshover/tree/master/icons
export type IconName = "plus" | "settings" | "cart" | "check" | "clock" | "close" | "edit" | "bell" | "arrow" | "more" | "trash"

type AnimatedIconProps = {
  name: IconName
  size?: number
}

const springy = { duration: 0.45, ease: "easeInOut" as const }

export function AnimatedIcon({ name, size = 18 }: AnimatedIconProps) {
  const [hovered, setHovered] = useState(false)
  const reduceMotion = useReducedMotion()
  const hoverProps = {
    onHoverStart: () => {
      if (!reduceMotion) setHovered(true)
    },
    onHoverEnd: () => setHovered(false)
  }
  const commonProps = {
    className: "icon",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  }

  if (name === "settings") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 32 32" style={{ overflow: "visible" }}>
        <motion.g
          animate={hovered ? { rotate: 360, scale: [1, 1.03, 1] } : { rotate: 0, scale: 1 }}
          transition={{ duration: hovered ? 0.9 : 0.2, ease: "easeInOut" }}
          style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}
        >
          <circle cx="16" cy="16" r="5" />
          <path d="m30 17.5v-3l-3.388-1.355a11 11 0 0 0-1.089-2.633l1.436-3.351-2.121-2.121-3.351 1.436a11 11 0 0 0-2.633-1.089L17.5 3h-3l-1.355 3.388a11 11 0 0 0-2.633 1.089L7.161 6.04 5.04 8.161l1.436 3.351a11 11 0 0 0-1.089 2.633L2 15.5v3l3.388 1.355a11 11 0 0 0 1.089 2.633L5.04 25.839l2.121 2.121 3.351-1.436a11 11 0 0 0 2.633 1.089L14.5 31h3l1.355-3.388a11 11 0 0 0 2.633-1.089l3.351 1.436 2.121-2.121-1.436-3.351a11 11 0 0 0 1.089-2.633Z" />
        </motion.g>
      </motion.svg>
    )
  }

  if (name === "cart") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 48 48" strokeWidth="3" style={{ overflow: "visible" }}>
        <motion.g animate={hovered ? { x: [0, 5, 0] } : { x: 0 }} transition={{ duration: 0.6, ease: "easeInOut" }}>
          <path d="M8.5 10H41l-3.431 11.437A5 5 0 0 1 32.78 25H10.5" />
          <path d="M41 32H9.462c-2.285 0-3.372-2.812-1.683-4.349L10.692 25 7.811 5.141A2.5 2.5 0 0 0 5.337 3H3" />
          <motion.path d="M30 16v3M24 16v3M18 16v3" animate={hovered ? { y: [0, -2, 0] } : { y: 0 }} transition={springy} />
          <motion.circle cx="11" cy="41" r="4" animate={hovered ? { rotate: [0, 180, 0] } : { rotate: 0 }} style={{ transformOrigin: "11px 41px" }} transition={springy} />
          <motion.circle cx="37" cy="41" r="4" animate={hovered ? { rotate: [0, 180, 0] } : { rotate: 0 }} style={{ transformOrigin: "37px 41px" }} transition={springy} />
        </motion.g>
      </motion.svg>
    )
  }

  if (name === "check") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 24 24">
        <motion.path
          d="M5 12l5 5L20 7"
          initial={false}
          animate={hovered ? { pathLength: [0, 1], scale: [0.94, 1] } : { pathLength: 1, scale: 1 }}
          transition={{ duration: hovered ? 0.4 : 0.2, ease: "easeInOut" }}
          style={{ transformOrigin: "50% 50%" }}
        />
      </motion.svg>
    )
  }

  if (name === "clock") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 24 24">
        <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" />
        <motion.path
          d="M12 7v5l3 3"
          animate={hovered ? { rotate: 360 } : { rotate: 0 }}
          transition={{ duration: hovered ? 0.85 : 0.25, ease: "easeInOut" }}
          style={{ transformOrigin: "12px 12px" }}
        />
      </motion.svg>
    )
  }

  if (name === "close") {
    return (
      <motion.svg {...commonProps} viewBox="0 0 24 24">
        <path d="M18 6 6 18" />
        <path d="M6 6l12 12" />
      </motion.svg>
    )
  }

  if (name === "edit") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 32 32" style={{ overflow: "visible" }}>
        <motion.g
          animate={hovered ? { x: [0, 1, -1, 1, 0], y: [0, -2, -4, -6, 0], rotate: [0, -6, -4, -6, 0] } : { x: 0, y: 0, rotate: 0 }}
          transition={{ duration: hovered ? 0.75 : 0.2, ease: "easeInOut" }}
          style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}
        >
          <path d="m10.5 27.5-8 2 2-8L22.257 3.743a4.243 4.243 0 0 1 6 6Z" />
        </motion.g>
      </motion.svg>
    )
  }

  if (name === "bell") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <motion.path
          d="M14.235 19c.865 0 1.322 1.024.745 1.668A3.992 3.992 0 0 1 12 22a3.992 3.992 0 0 1-2.98-1.332c-.552-.616-.158-1.579.634-1.661l.11-.006h4.471Z"
          animate={hovered ? { rotate: [0, 20, -18, 12, -6, 0] } : { rotate: 0 }}
          transition={{ duration: 0.6, delay: hovered ? 0.05 : 0 }}
          style={{ transformOrigin: "50% 0%" }}
        />
        <motion.path
          d="M12 2a3 3 0 0 1 2.875 2.141l.046.171.008.043a8.013 8.013 0 0 1 4.024 6.069l.028.287.019.289v2.931l.021.136a3 3 0 0 0 1.143 1.847l.167.117.162.099c.86.487.56 1.766-.377 1.864L20 18H4c-1.028 0-1.387-1.364-.493-1.87a3 3 0 0 0 1.472-2.063L5 13.924l.001-2.97A8 8 0 0 1 8.822 4.5l.248-.146.01-.043a3.003 3.003 0 0 1 2.562-2.29l.182-.017Z"
          animate={hovered ? { rotate: [0, -8, 6, -4, 2, 0] } : { rotate: 0 }}
          transition={{ duration: 0.6, ease: "easeInOut" }}
          style={{ transformOrigin: "50% 10%" }}
        />
      </motion.svg>
    )
  }

  if (name === "arrow") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 24 24">
        <motion.g animate={hovered ? { x: [0, 3, 0] } : { x: 0 }} transition={{ duration: 0.5, ease: "easeInOut" }}>
          <path d="M5 12h14M15 16l4-4M15 8l4 4" />
        </motion.g>
      </motion.svg>
    )
  }

  if (name === "more") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <motion.circle cx="5" cy="12" r="1.25" animate={hovered ? { x: [-2, 0], scale: [1, 1.2, 1] } : { x: 0, scale: 1 }} transition={{ duration: 0.3 }} />
        <motion.circle cx="12" cy="12" r="1.25" animate={hovered ? { scale: [1, 1.3, 1] } : { scale: 1 }} transition={{ duration: 0.3, delay: hovered ? 0.1 : 0 }} />
        <motion.circle cx="19" cy="12" r="1.25" animate={hovered ? { x: [2, 0], scale: [1, 1.2, 1] } : { x: 0, scale: 1 }} transition={{ duration: 0.3, delay: hovered ? 0.2 : 0 }} />
      </motion.svg>
    )
  }

  if (name === "trash") {
    return (
      <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 24 24">
        <motion.path
          d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14"
          animate={hovered ? { y: [0, -2, 0], rotate: [0, -5, 5, 0] } : { y: 0, rotate: 0 }}
          transition={{ duration: hovered ? 0.5 : 0.2, ease: "easeInOut" }}
          style={{ transformOrigin: "50% 50%" }}
        />
      </motion.svg>
    )
  }

  return (
    <motion.svg {...commonProps} {...hoverProps} viewBox="0 0 24 24">
      <motion.path
        d="M12 5v14M5 12h14"
        animate={hovered ? { rotate: 90, scale: 1.08 } : { rotate: 0, scale: 1 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
        style={{ transformOrigin: "12px 12px" }}
      />
    </motion.svg>
  )
}
