/**
 * Recovery.tsx
 *
 * The full-page "/recovery" entry for the backup-file sign-in flow. The actual
 * flow lives in <RecoveryFlow> (shared with the modal variant, RecoveryModal);
 * this page just wraps it and maps success/back to navigation:
 *   - setup-passkey → /settings/account (the Identity add-device ceremony)
 *   - skip          → /home
 *   - back          → /welcome
 *
 * The recovered secp256k1 key is only ever READ (RecoveryProvider holds it in
 * React state, never persisted).
 */

import { useNavigate } from 'react-router-dom'
import RecoveryFlow from '~/components/identity/RecoveryFlow'

export default function Recovery() {
  const navigate = useNavigate()

  return (
    <RecoveryFlow
      variant="page"
      onSignedIn={(intent) => navigate(intent === 'setup-passkey' ? '/settings/account' : '/home')}
      onBack={() => navigate('/welcome')}
    />
  )
}
