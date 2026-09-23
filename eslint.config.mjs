import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'


// Inherited Pantheon dashboard files that predate React 19's compiler rules.
// They work at runtime; the rules below flag patterns the React Compiler can't
// optimise (setState in effects, Date.now()/Math.random() in render, reading
// refs in render). They are downgraded to WARNINGS (still reported) for these
// files only — never for new code. Remove a file from this list once fixed.
// Tracked in docs/ARCHITECTURE.md → "Known debt".
const LEGACY_REACT_COMPILER_DEBT = [
  'app/share/\\[id\\]/page.tsx',
  'components/ActiveAgent.tsx',
  'components/AgentControlPanel.tsx',
  'components/AgentDrilldown.tsx',
  'components/AlertRules.tsx',
  'components/BootSplash.tsx',
  'components/Collapsible.tsx',
  'components/CommandPalette.tsx',
  'components/DashboardShell.tsx',
  'components/GitHistory.tsx',
  'components/HouseCup.tsx',
  'components/JarvisGreeting.tsx',
  'components/LastDayDigest.tsx',
  'components/LoadingSpinner.tsx',
  'components/MarketIntel.tsx',
  'components/MarketplaceListings.tsx',
  'components/PanelShell.tsx',
  'components/PanicButton.tsx',
  'components/ReadableModeToggle.tsx',
  'components/RecentTasksStrip.tsx',
  'components/RevenueAutomation.tsx',
  'components/RevenueTracker.tsx',
  'components/SubscribersPanel.tsx',
  'components/TaskTraceDrawer.tsx',
  'components/TodosTable.tsx',
  'components/VictoryFlash.tsx',
  'components/VoiceNarrator.tsx',
  'components/WeekHighlights.tsx',
  'lib/useFreshness.ts',
  'lib/usePinned.ts',
  'lib/useTimeWindow.tsx',
]

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: LEGACY_REACT_COMPILER_DEBT,
    rules: {
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'dist/**',
    'backups/**',
    'public/**',
    'next-env.d.ts',
    // Legacy ops agent runtime (plain Node scripts, disabled by default).
    // Guarded by scripts/lib-agent-permissions + its tests instead.
    'scripts/**',
  ]),
])
