import { useWalletProfileLookup } from '~/config/walletProfileLookup'
import { useT } from '~/i18n/I18nProvider'
import { useSignInModalStore } from '~/store/signInModalStore'
import { Link } from '~/utils/localizedRouter'

interface Props {
  className: string
  createLabel: string
  onCreate?: () => void
}

export default function ProfileLookupAction({ className, createLabel, onCreate }: Props) {
  const { status, retry } = useWalletProfileLookup()
  const showSignIn = useSignInModalStore(state => state.show)
  const t = useT()

  if (status === 'no-address') {
    return (
      <button type="button" className={className} onClick={() => showSignIn()}>
        {t('common.sign_in')}
      </button>
    )
  }

  if (status === 'empty') {
    return <Link to="/usernames/new" className={className} onClick={onCreate}>{createLabel}</Link>
  }

  if (status === 'unavailable') {
    return (
      <button type="button" className={className} onClick={retry}>
        {t('profile_lookup.retry')}
      </button>
    )
  }

  return <span role="status" className="text-sm opacity-80">{t('profile_lookup.checking')}</span>
}
