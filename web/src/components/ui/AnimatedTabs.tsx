import { motion } from 'framer-motion'

type Tab = {
  id: string
  label: string
}

interface AnimatedTabsProps {
  tabs: Tab[]
  activeTab: string
  onTabChange: (id: string) => void
}

export const AnimatedTabs = ({
  tabs,
  activeTab,
  onTabChange
}: AnimatedTabsProps) => {
  return (
    <div className="flex space-x-2 bg-bg-main p-1 rounded-full shadow-neumorphic-concave">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`w-full py-2 px-4 rounded-full text-sm font-semibold transition-colors relative focus:outline-none ${
            activeTab === tab.id ? '' : 'hover:text-text-primary'
          }`}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          {activeTab === tab.id && (
            <motion.div
              layoutId="active-tab-indicator"
              className="absolute inset-0 bg-accent rounded-full shadow-neumorphic-convex"
              transition={{ type: 'tween', ease: 'easeInOut', duration: 0.4 }}
            />
          )}
          <span
            className={`relative z-10 transition-colors ${activeTab === tab.id ? 'text-white' : 'text-text-secondary'}`}
          >
            {tab.label}
          </span>
        </button>
      ))}
    </div>
  )
}
