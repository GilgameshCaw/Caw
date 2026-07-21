/**
 * RecoveryModal.tsx
 *
 * The backup-file sign-in flow (<RecoveryFlow>) rendered as an overlay instead
 * of the full /recovery page — for in-app entry points (Account Settings, the
 * sign-in chooser) where a full navigation is jarring.
 *
 * Success behavior differs from the page: instead of navigating away, the modal
 * signs the user in, closes, and — when the user picked "set up a passkey" —
 * routes to the Identity add-passkey ceremony (/settings/account?addPasskey=1,
 * which IdentitySection auto-opens). "Skip" just closes the modal so the user
 * stays where they were.
 */

import ModalWrapper from '~/components/modals/ModalWrapper'
import RecoveryFlow from '~/components/identity/RecoveryFlow'
import { useNavigate } from '~/utils/localizedRouter'

export interface RecoveryModalProps {
  open: boolean
  onClose: () => void
}

export default function RecoveryModal({ open, onClose }: RecoveryModalProps) {
  const navigate = useNavigate()

  return (
    <ModalWrapper
      isOpen={open}
      onClose={onClose}
      // RecoveryFlow's card supplies its own bg/border/padding, so neutralize
      // ModalWrapper's default card to avoid a double-card look.
      className="!bg-transparent !border-0"
      backdropClass="bg-black/70"
    >
      <RecoveryFlow
        variant="modal"
        onSignedIn={(intent) => {
          onClose()
          if (intent === 'setup-passkey') {
            // IdentitySection reads ?addPasskey=1 and auto-opens the add-passkey
            // dialog — so this drops the just-recovered user straight into
            // getting a passkey on this device.
            navigate('/settings/account?addPasskey=1')
          }
          // 'skip' → just close; the user stays on the page they opened it from.
        }}
        onBack={onClose}
      />
    </ModalWrapper>
  )
}
