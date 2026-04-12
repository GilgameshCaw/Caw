import React, { useState, useEffect } from 'react'
import { HiCamera, HiLink, HiLocationMarker } from 'react-icons/hi'
import { useAccount, useSwitchChain, useChainId } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { apiFetch, getAuthHeaders } from '~/api/client'
import { useSignAndSubmitAction } from '~/api/actions'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { chains } from '~/config/chains'
import InsufficientStakeModal from '~/components/modals/InsufficientStakeModal'

export type ProfileEditFormData = {
  displayName?: string | null
  bio?: string | null
  location?: string | null
  website?: string | null
  avatarUrl?: string | null
  coverPhotoUrl?: string | null
}

interface ActiveTokenShape {
  tokenId: number
  username?: string
  address?: string
  owner?: string
  stakedAmount?: bigint
}

interface ProfileEditFormProps {
  activeToken: ActiveTokenShape | null | undefined
  profileData?: ProfileEditFormData | null
  isDark: boolean
  onSaved?: (updated: any) => void
  saveLabel?: string
  onSkip?: () => void
  skipLabel?: string
  /** When set, wraps the input fields in a scrollable container with this max height (tailwind class, e.g. "max-h-[50vh]"). Footer stays pinned. */
  scrollFieldsMaxHeight?: string
  /** When true, uses tighter vertical spacing between field label and input (space-y-1 instead of space-y-2). */
  compactFields?: boolean
  /** Hide the "Click to upload" caption under the avatar. */
  hideAvatarCaption?: boolean
  /** Render the skip action as a subtle gray link on its own line below the buttons instead of a pill next to Save. */
  skipAsLink?: boolean
}

const ProfileEditForm: React.FC<ProfileEditFormProps> = ({
  activeToken,
  profileData,
  isDark,
  onSaved,
  saveLabel = 'Save Changes',
  onSkip,
  skipLabel,
  scrollFieldsMaxHeight,
  compactFields,
  hideAvatarCaption,
  skipAsLink,
}) => {
  const containerSpacing = compactFields ? 'space-y-2' : 'space-y-6'
  const { address, isConnected } = useAccount()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const currentChainId = useChainId()
  const { openConnectModal } = useConnectModal()
  const signAndSubmit = useSignAndSubmitAction()
  const setAvatar = useTokenDataStore(s => s.setAvatar)

  const isOnCorrectChain = currentChainId === chains.l2.chainId
  const providerDomain = typeof window !== 'undefined' ? window.location.hostname : ''

  const [formData, setFormData] = useState({
    displayName: profileData?.displayName || '',
    description: profileData?.bio || '',
    location: profileData?.location || '',
    website: profileData?.website || '',
  })

  useEffect(() => {
    setFormData({
      displayName: profileData?.displayName || '',
      description: profileData?.bio || '',
      location: profileData?.location || '',
      website: profileData?.website || '',
    })
  }, [profileData])

  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined)
  const [coverPreview, setCoverPreview] = useState<string | undefined>(undefined)
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined)
  const [isUploading, setIsUploading] = useState(false)
  const [updateCost, setUpdateCost] = useState(0)
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingOffChain, setIsSavingOffChain] = useState(false)
  const [saveOnChain, setSaveOnChain] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [showCostExplanation, setShowCostExplanation] = useState(false)
  const [showInsufficientStake, setShowInsufficientStake] = useState(false)

  const triggerFileInput = (type: 'avatar' | 'cover') => {
    setTimeout(() => {
      const inputId = type === 'avatar' ? 'profile-form-avatar-upload' : 'profile-form-cover-upload'
      const input = document.getElementById(inputId) as HTMLInputElement | null
      input?.click()
    }, 10)
  }

  const processImageFile = async (type: 'avatar' | 'cover', file: File) => {
    if (!file.type.startsWith('image/')) {
      setProfileError('Please select a valid image file')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setProfileError('Image size must be less than 5MB')
      return
    }
    setProfileError(null)
    setIsUploading(true)
    try {
      const uploadFormData = new FormData()
      uploadFormData.append('media', file)
      uploadFormData.append('tokenId', String(activeToken?.tokenId || 0))

      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: uploadFormData,
      })
      if (!response.ok) throw new Error('Upload failed')
      const data = await response.json()
      if (!data.urls || !data.urls[0]) throw new Error('No URL returned from upload')
      const imageUrl = data.urls[0]

      if (type === 'avatar') {
        const reader = new FileReader()
        reader.onload = (e) => setAvatarPreview(e.target?.result as string)
        reader.readAsDataURL(file)
        setAvatarUrl(imageUrl)
      } else {
        const reader = new FileReader()
        reader.onload = (e) => setCoverPreview(e.target?.result as string)
        reader.readAsDataURL(file)
        setCoverUrl(imageUrl)
      }
    } catch (err) {
      console.error('Failed to upload image:', err)
      setProfileError('Failed to upload image. Please try again.')
    } finally {
      setIsUploading(false)
    }
  }

  const handleImageSelect = async (type: 'avatar' | 'cover', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    await processImageFile(type, file)
  }

  const handleImageDrop = async (type: 'avatar' | 'cover', event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    await processImageFile(type, file)
  }

  // Calculate cost and character budget
  const MAX_ACTION_TEXT = 420

  // Build the action text and compute how many chars the bio can still use.
  // We construct the JSON with and without the bio to find the overhead.
  const changedData: any = {}
  if (formData.displayName !== (profileData?.displayName || '')) changedData.n = formData.displayName
  if (formData.description !== (profileData?.bio || '')) changedData.d = formData.description
  if (formData.location !== (profileData?.location || '')) changedData.l = formData.location
  if (formData.website !== (profileData?.website || '')) changedData.w = formData.website
  if (avatarUrl) changedData.a = avatarUrl
  if (coverUrl) changedData.c = coverUrl

  const hasChanges = Object.keys(changedData).length > 0
  const actionText = hasChanges ? `p:${JSON.stringify(changedData)}` : ''
  const actionTextLength = actionText.length
  const overLimit = actionTextLength > MAX_ACTION_TEXT

  // Compute remaining chars available for bio: build JSON without bio,
  // then subtract that from the limit.
  const withoutBio = { ...changedData }
  delete withoutBio.d
  const overheadWithoutBio = Object.keys(withoutBio).length > 0
    ? `p:${JSON.stringify(withoutBio)}`.length
    // If bio is the only change, overhead is just `p:{"d":""}` = 10 chars
    : 10
  // When other fields exist, adding bio means ,"d":"..." = 6 extra chars of JSON overhead
  const bioJsonOverhead = Object.keys(withoutBio).length > 0 ? 6 : 0
  const bioCharsRemaining = MAX_ACTION_TEXT - overheadWithoutBio - bioJsonOverhead

  useEffect(() => {
    if (!hasChanges) {
      setUpdateCost(0)
      return
    }
    const cost = 100 + Math.ceil(actionTextLength * 10)
    setUpdateCost(cost)
  }, [hasChanges, actionTextLength])

  const handleOffChainUpdate = async () => {
    if (!activeToken) {
      setProfileError('Please select a token')
      return
    }
    const changes: Record<string, string> = {}
    if (formData.displayName !== (profileData?.displayName || '')) changes.displayName = formData.displayName
    if (formData.description !== (profileData?.bio || '')) changes.bio = formData.description
    if (formData.location !== (profileData?.location || '')) changes.location = formData.location
    if (formData.website !== (profileData?.website || '')) changes.website = formData.website
    if (avatarUrl) changes.avatarUrl = avatarUrl
    if (coverUrl) changes.coverPhotoUrl = coverUrl

    if (Object.keys(changes).length === 0) {
      setProfileError('No changes to save')
      return
    }

    setProfileError(null)
    setIsSavingOffChain(true)
    try {
      const res = await apiFetch<{ user: any }>(
        `/api/users/${activeToken.tokenId}/profile`,
        { method: 'PATCH', body: JSON.stringify(changes) }
      )
      if (res.user?.avatarUrl !== undefined && activeToken.tokenId) {
        setAvatar(activeToken.tokenId, res.user.avatarUrl || null)
      }
      setAvatarPreview(undefined)
      setCoverPreview(undefined)
      setAvatarUrl(undefined)
      setCoverUrl(undefined)
      onSaved?.(res.user)
    } catch (err: any) {
      console.error('Failed to save off-chain profile:', err)
      setProfileError(err?.message?.split('\n')[0]?.slice(0, 120) || 'Failed to save profile')
    } finally {
      setIsSavingOffChain(false)
    }
  }

  const handleOnChainUpdate = async () => {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    if (!isOnCorrectChain) {
      try {
        await switchChain({ chainId: chains.l2.chainId })
      } catch (err) {
        console.error('Failed to switch chain:', err)
      }
      return
    }
    if (!activeToken) {
      setProfileError('Please select a token')
      return
    }

    setProfileError(null)
    setIsSaving(true)

    let profileUpdateData: any = {}
    try {
      if (formData.displayName !== (profileData?.displayName || '')) profileUpdateData.n = formData.displayName
      if (formData.description !== (profileData?.bio || '')) profileUpdateData.d = formData.description
      if (formData.location !== (profileData?.location || '')) profileUpdateData.l = formData.location
      if (formData.website !== (profileData?.website || '')) profileUpdateData.w = formData.website
      if (avatarUrl) profileUpdateData.a = avatarUrl
      if (coverUrl) profileUpdateData.c = coverUrl

      if (Object.keys(profileUpdateData).length === 0) {
        setProfileError('No changes to save')
        setIsSaving(false)
        return
      }

      const actionText = `p:${JSON.stringify(profileUpdateData)}`
      const { getValidatorTip } = await import('~/api/actions')
      const totalCost = BigInt(updateCost) + getValidatorTip()

      // Don't pre-check stakedAmount here — signAndSubmit accounts for
      // pending deposits and in-flight spends, and will show the
      // InsufficientStakeModal itself if the effective budget is too low.
      await signAndSubmit({
        actionType: 'other',
        senderId: activeToken.tokenId,
        text: actionText,
        amounts: [totalCost],
      })

      // Optimistically update the avatar in the global store so it shows
      // immediately across the app (profile page, nav, etc.) without
      // waiting for the on-chain action to confirm.
      if (avatarUrl && activeToken.tokenId) {
        setAvatar(activeToken.tokenId, avatarUrl)
      }

      // Also persist changes off-chain so the server returns them immediately
      // on subsequent fetches (don't wait for on-chain confirmation).
      const offChainChanges: Record<string, string> = {}
      if (formData.displayName !== (profileData?.displayName || '')) offChainChanges.displayName = formData.displayName
      if (formData.description !== (profileData?.bio || '')) offChainChanges.bio = formData.description
      if (formData.location !== (profileData?.location || '')) offChainChanges.location = formData.location
      if (formData.website !== (profileData?.website || '')) offChainChanges.website = formData.website
      if (avatarUrl) offChainChanges.avatarUrl = avatarUrl
      if (coverUrl) offChainChanges.coverPhotoUrl = coverUrl
      if (Object.keys(offChainChanges).length > 0) {
        apiFetch(`/api/users/${activeToken.tokenId}/profile`, {
          method: 'PATCH',
          body: JSON.stringify(offChainChanges),
        }).catch(err => console.warn('Off-chain profile sync failed (non-fatal):', err))
      }
      setAvatarPreview(undefined)
      setCoverPreview(undefined)
      setAvatarUrl(undefined)
      setCoverUrl(undefined)
      onSaved?.({
        profileUpdatePending: true,
        ...(formData.displayName !== (profileData?.displayName || '') && { displayName: formData.displayName }),
        ...(formData.description !== (profileData?.bio || '') && { bio: formData.description }),
        ...(formData.location !== (profileData?.location || '') && { location: formData.location }),
        ...(formData.website !== (profileData?.website || '') && { website: formData.website }),
        ...(avatarUrl && { avatarUrl }),
        ...(coverUrl && { coverPhotoUrl: coverUrl }),
      })
    } catch (err: any) {
      console.error('Failed to update profile:', err)
      let errorMessage = 'Failed to update profile'
      if (err?.message) {
        if (err.message.includes('User rejected') || err.message.includes('user rejected')) {
          errorMessage = 'Transaction rejected'
        } else if (err.message.includes('chainId should be same')) {
          errorMessage = 'Please switch to the correct network'
        } else {
          errorMessage = err.message.split('\n')[0].slice(0, 100)
        }
      }
      setProfileError(errorMessage)
    } finally {
      setIsSaving(false)
    }
  }

  const wrongWallet = !!(isConnected && activeToken && address?.toLowerCase() !== activeToken.address?.toLowerCase())
  const saveDisabled =
    isSaving || isSavingOffChain || isUploading || updateCost === 0 ||
    (saveOnChain && (isSwitchingChain || wrongWallet || overLimit))

  return (
    <div className="flex flex-col">
      <div className={`${containerSpacing} ${scrollFieldsMaxHeight ? `min-[800px]:overflow-y-auto min-[800px]:max-h-[50vh] min-[800px]:pr-2` : ''}`}>
      {/* Hidden file inputs */}
      <input
        id="profile-form-avatar-upload"
        type="file"
        accept="image/*"
        onChange={(e) => handleImageSelect('avatar', e)}
        className="hidden"
      />
      <input
        id="profile-form-cover-upload"
        type="file"
        accept="image/*"
        onChange={(e) => handleImageSelect('cover', e)}
        className="hidden"
      />

      {/* Images Section */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between">
          <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Profile Picture</label>
          <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Cover Photo</label>
        </div>

        <div className="flex items-center space-x-6">
          {/* Avatar */}
          <div className="flex flex-col items-center ml-[7px]">
            <button
              type="button"
              className={`w-20 h-20 rounded-full border-2 border-dashed transition-all duration-300 hover:border-yellow-500 hover:bg-yellow-500/10 cursor-pointer ${
                isDark ? 'border-gray-600 bg-gray-800/50' : 'border-gray-300 bg-gray-50'
              }`}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); triggerFileInput('avatar') }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.classList.add('border-yellow-500', 'bg-yellow-500/10')
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.classList.remove('border-yellow-500', 'bg-yellow-500/10')
              }}
              onDrop={(e) => {
                e.currentTarget.classList.remove('border-yellow-500', 'bg-yellow-500/10')
                handleImageDrop('avatar', e)
              }}
            >
              <div className="relative w-full h-full flex items-center justify-center overflow-hidden rounded-full">
                {avatarPreview ? (
                  <img src={avatarPreview} alt="Avatar preview" className="w-full h-full object-cover" />
                ) : (
                  <>
                    {profileData?.avatarUrl && (
                      <>
                        <img src={profileData.avatarUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/50" />
                      </>
                    )}
                    <HiCamera className={`relative w-6 h-6 ${
                      profileData?.avatarUrl ? 'text-white' : (isDark ? 'text-gray-400' : 'text-gray-500')
                    }`} />
                  </>
                )}
              </div>
            </button>
            {!hideAvatarCaption && (
              <p className={`text-xs mt-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Click to upload</p>
            )}
          </div>

          {/* Cover */}
          <div className="flex-1">
            <button
              type="button"
              className={`relative h-20 w-full rounded-lg border-2 border-dashed transition-all duration-300 hover:border-yellow-500 hover:bg-yellow-500/10 cursor-pointer ${
                isDark ? 'border-gray-600 bg-gray-800/50' : 'border-gray-300 bg-gray-50'
              }`}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); triggerFileInput('cover') }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.classList.add('border-yellow-500', 'bg-yellow-500/10')
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.currentTarget.classList.remove('border-yellow-500', 'bg-yellow-500/10')
              }}
              onDrop={(e) => {
                e.currentTarget.classList.remove('border-yellow-500', 'bg-yellow-500/10')
                handleImageDrop('cover', e)
              }}
            >
              <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-lg">
                {coverPreview ? (
                  <img src={coverPreview} alt="Cover preview" className="w-full h-full object-cover" />
                ) : (
                  <>
                    {profileData?.coverPhotoUrl && (
                      <>
                        <img src={profileData.coverPhotoUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/50" />
                      </>
                    )}
                    <div className="relative text-center">
                      <HiCamera className={`w-6 h-6 mx-auto mb-1 ${
                        profileData?.coverPhotoUrl ? 'text-white' : (isDark ? 'text-gray-400' : 'text-gray-500')
                      }`} />
                      <p className={`text-xs ${
                        profileData?.coverPhotoUrl ? 'text-white/90' : (isDark ? 'text-gray-400' : 'text-gray-500')
                      }`}>
                        Click to upload
                      </p>
                    </div>
                  </>
                )}
              </div>
            </button>
          </div>
        </div>

        {(avatarPreview || coverPreview) && (
          <div className="flex space-x-4 mt-2">
            {avatarPreview && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAvatarPreview(undefined); setAvatarUrl(undefined) }}
                className={`px-3 py-1 text-xs rounded-full ${
                  isDark ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30' : 'bg-red-100 text-red-600 hover:bg-red-200'
                }`}
              >
                Clear Avatar
              </button>
            )}
            {coverPreview && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setCoverPreview(undefined); setCoverUrl(undefined) }}
                className={`px-3 py-1 text-xs rounded-full ${
                  isDark ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30' : 'bg-red-100 text-red-600 hover:bg-red-200'
                }`}
              >
                Clear Cover
              </button>
            )}
          </div>
        )}
      </div>

      {/* Display Name */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Display Name</label>
        <input
          type="text"
          value={formData.displayName}
          onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
          placeholder="Enter your display name"
          maxLength={50}
          className={`w-full px-4 py-3 rounded-full border focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
            isDark ? 'bg-black border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-300 text-black placeholder-gray-500'
          }`}
        />
      </div>

      {/* Description */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Description</label>
          {saveOnChain && (
            <span className={`text-xs ${
              formData.description.length > bioCharsRemaining
                ? 'text-red-500 font-medium'
                : formData.description.length > bioCharsRemaining * 0.9
                  ? 'text-yellow-500'
                  : isDark ? 'text-gray-500' : 'text-gray-400'
            }`}>
              {bioCharsRemaining - formData.description.length} chars remaining
            </span>
          )}
        </div>
        <textarea
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Tell us about yourself"
          rows={4}
          className={`w-full px-4 py-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-gray-500/30 resize-none ${
            isDark ? 'bg-black border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-300 text-black placeholder-gray-500'
          } ${overLimit && saveOnChain ? 'border-red-500' : ''}`}
        />
      </div>

      {/* Website */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Website</label>
        <div className="relative">
          <HiLink className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
          <input
            type="url"
            value={formData.website}
            onChange={(e) => setFormData({ ...formData, website: e.target.value })}
            placeholder="https://yourwebsite.com"
            className={`w-full pl-10 pr-4 py-3 rounded-full border focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
              isDark ? 'bg-black border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-300 text-black placeholder-gray-500'
            }`}
          />
        </div>
      </div>

      {/* Location */}
      <div className="space-y-2">
        <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Location</label>
        <div className="relative">
          <HiLocationMarker className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
          <input
            type="text"
            value={formData.location}
            onChange={(e) => setFormData({ ...formData, location: e.target.value })}
            placeholder="Enter your location"
            className={`w-full pl-10 pr-4 py-3 rounded-full border focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
              isDark ? 'bg-black border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-300 text-black placeholder-gray-500'
            }`}
          />
        </div>
      </div>
      </div>

      {/* Footer: toggle + save */}
      <div className="pt-4 mt-4 border-t border-white/10">
        <div className="flex items-center justify-between gap-4">
          {/* On-chain toggle */}
          <label className={`cursor-pointer select-none ${compactFields ? 'flex flex-row items-center gap-2' : 'flex flex-col items-center'}`}>
            <span className={`${compactFields ? '' : 'mb-1'} text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>On-chain</span>
            <input
              type="checkbox"
              checked={saveOnChain}
              onChange={() => setSaveOnChain(v => !v)}
              className="sr-only"
            />
            <div className={`relative w-11 h-[22px] flex items-center rounded-full border ${isDark ? 'border-gray-500' : 'border-gray-400'}`}>
              <div className={`absolute inset-0 rounded-full transition-colors duration-200 ${saveOnChain ? 'bg-yellow-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
              <div className={`absolute w-[18px] h-[18px] bg-white rounded-full shadow-md transform transition-all duration-200 ${saveOnChain ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
            </div>
          </label>

          <div className="inline-flex flex-col items-end">
            <div className="flex space-x-3">
              {onSkip && !skipAsLink && (
                <button
                  onClick={onSkip}
                  className={`px-6 py-2 rounded-full font-medium cursor-pointer ${
                    isDark ? 'border border-gray-600 text-gray-300 hover:bg-gray-800' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {skipLabel || 'Skip'}
                </button>
              )}
              <button
                onClick={saveOnChain ? handleOnChainUpdate : handleOffChainUpdate}
                disabled={saveDisabled}
                className={`px-6 py-2 rounded-full font-medium ${
                  saveDisabled ? 'bg-gray-500 cursor-not-allowed' : 'bg-yellow-500 hover:bg-yellow-600 cursor-pointer'
                } text-black`}
              >
                {isSaving || isSavingOffChain ? (
                  <span>Saving...</span>
                ) : saveOnChain && isSwitchingChain ? (
                  <span>Switching...</span>
                ) : saveOnChain && !isConnected ? (
                  <span>Connect Wallet</span>
                ) : saveOnChain && !isOnCorrectChain ? (
                  <span>Switch to Base Sepolia</span>
                ) : saveOnChain && wrongWallet ? (
                  <span>Wrong Address</span>
                ) : (
                  <span>
                    {saveLabel} {saveOnChain && updateCost > 0 && `(${updateCost.toLocaleString()} CAW)`}
                  </span>
                )}
              </button>
            </div>
            <div className="mt-2 self-end mr-[11px]">
              {!compactFields && (saveOnChain ? (
                <button
                  onClick={() => setShowCostExplanation(true)}
                  className={`text-xs cursor-pointer ${
                    isDark ? 'text-yellow-500/70 hover:text-yellow-500' : 'text-yellow-700/70 hover:text-yellow-700'
                  }`}
                >
                  On chain profile updates cost CAW. Why?
                </button>
              ) : (
                <div className={`text-xs text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  <div>Off chain profile updates are free,</div>
                  <div>but they are only visible through this provider</div>
                  <div>({providerDomain})</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        {compactFields && (
          saveOnChain ? (
            <div className="text-center">
              <button
                onClick={() => setShowCostExplanation(true)}
                className={`text-xs cursor-pointer ${
                  isDark ? 'text-yellow-500/70 hover:text-yellow-500' : 'text-yellow-700/70 hover:text-yellow-700'
                }`}
              >
                On chain profile updates cost CAW. Why?
              </button>
            </div>
          ) : (
            <div className={`text-xs text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Off chain profile updates are only visible through this provider
            </div>
          )
        )}
        {saveOnChain && overLimit && (
          <div className={`mt-3 p-2 rounded-lg text-sm ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'}`}>
            Profile update exceeds 420 character limit ({actionTextLength}/420). Shorten your bio or submit fewer fields.
          </div>
        )}
        {profileError && (
          <div className={`mt-3 p-2 rounded-lg text-sm ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'}`}>
            {profileError}
          </div>
        )}
        {onSkip && skipAsLink && (
          <button
            onClick={onSkip}
            className="block w-full mt-3 py-2 text-sm text-white/40 hover:text-white/60 transition-colors cursor-pointer text-center"
          >
            {skipLabel || 'Skip'}
          </button>
        )}
      </div>

      {/* Cost Explanation Modal */}
      {showCostExplanation && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4"
          onClick={() => setShowCostExplanation(false)}
        >
          <div
            className={`w-full max-w-md rounded-2xl p-6 ${isDark ? 'bg-gray-900 border border-yellow-500/30' : 'bg-white border border-gray-200'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>Why does this cost CAW?</h3>
            <div className={`space-y-3 mb-6 text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <p>Your profile changes are stored permanently on the blockchain, making them censorship-resistant and truly owned by you.</p>
              <p className={`p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                The CAW cost is used to cover the gas fees for permanent storage on the blockchain.
              </p>
            </div>
            <button
              onClick={() => setShowCostExplanation(false)}
              className="w-full px-4 py-2 rounded-full font-medium bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      <InsufficientStakeModal
        isOpen={showInsufficientStake}
        onClose={() => setShowInsufficientStake(false)}
        currentAmount={activeToken?.stakedAmount}
        requiredAmount={BigInt(updateCost) * 10n ** 18n}
        actionType="profile"
      />
    </div>
  )
}

export default ProfileEditForm
