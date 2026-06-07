import { Link } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { RESOURCE_LINKS } from './LandingHeader'

// Shared landing-page footer — resource links + tagline. Same markup the
// CaptiveSplash welcome page used inline; extracted so ManifestoPage and
// WhitepaperPage render the identical footer. `className` lets the host
// add layout-specific classes (e.g. CaptiveSplash needs `snap-start`).
export default function LandingFooter({ className = '' }: { className?: string }) {
  const { isDark } = useTheme()
  const t = useT()

  return (
    <footer
      className={`border-t py-8 px-6 relative z-10 backdrop-blur-[2px] ${
        isDark ? 'border-white/10 bg-black/10' : 'border-gray-200 bg-white/10'
      } ${className}`}
    >
      <div className="max-w-2xl mx-auto">
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
          {RESOURCE_LINKS.map(l => (
            <Link
              key={l.to}
              to={l.to}
              className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {l.tKey ? t(l.tKey) : l.label}
            </Link>
          ))}
        </div>
        <p className={`text-center text-xs mt-4 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
          {t('captive_splash.footer.tagline')}
        </p>
      </div>
    </footer>
  )
}
