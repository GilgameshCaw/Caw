import { useTheme } from '~/hooks/useTheme'
import LandingHeader from '~/components/landing/LandingHeader'
import LandingFooter from '~/components/landing/LandingFooter'
import ManifestoContent from '~/components/ManifestoContent'

// The CAW Manifesto — a bare route at /manifesto (NOT /help/manifesto, which is
// the in-app Help tab). This is the standalone, landing-style presentation:
// shared LandingHeader/Footer around the reusable <ManifestoContent> body (the
// same body the /help/manifesto tab embeds below its tab bar).
const ManifestoPage: React.FC = () => {
  const { isDark } = useTheme()

  return (
    <div className={`relative min-h-screen flex flex-col ${isDark ? 'bg-black text-white' : 'bg-white text-black'}`}>
      {/* Shared landing header — same logo lockup + resource links + language
          picker as the welcome page (CaptiveSplash). The host div is `relative`
          so the header's absolutely-positioned clusters anchor to it. */}
      <LandingHeader />
      <ManifestoContent />
      <LandingFooter />
    </div>
  )
}

export default ManifestoPage
