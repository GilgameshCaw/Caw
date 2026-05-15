import { getUserAvatar, getDefaultAvatarForUser } from "~/utils/defaultAvatar"
import Avatar from "~/components/Avatar"
// src/pages/ProfilePage.tsx
import React, { useState, useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Link } from '~/utils/localizedRouter'
import { Tabs, TabItem } from '~/components/Tabs'
import Feed             from '~/components/Feed'
import { useTheme } from '~/hooks/useTheme'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { formatWalletError } from '~/utils/errorMessage'
import { useActiveToken } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { HiPencil, HiX, HiCamera, HiGlobe, HiLink, HiLocationMarker, HiOutlineMail, HiDotsHorizontal, HiOutlineCurrencyDollar, HiOutlineLockClosed, HiArrowLeft } from 'react-icons/hi'
import CopyAddressButton from '~/components/CopyAddressButton'
import XBadge from '~/components/XBadge'
import { apiFetch, retryOnIndexing } from '~/api/client'
import { useDmIdentity } from '~/hooks/useDmIdentity'
import { useDmClient } from '~/hooks/useDm'
import { useAccount, useSwitchChain, useChainId, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { chains } from '~/config/chains'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMinterAbi } from '~/../../../abi/generated'
import { useSignAndSubmitAction } from '~/api/actions'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useNavigate } from '~/utils/localizedRouter'
import { useTokenDataStore } from '~/store/tokenDataStore'
import InsufficientStakeModal from '~/components/modals/InsufficientStakeModal'
import AvatarCropperModal from '~/components/modals/AvatarCropperModal'
import { useFollowButton } from '~/hooks/useFollowButton'
import { useT } from '~/i18n/I18nProvider'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import TipModal from '~/components/modals/TipModal'
import { ShareProfileCardModal } from '~/components/modals/ShareProfileCardModal'
import { useTransferModalStore } from '~/store/transferModalStore'
import { useMarketplaceStore, MarketplaceListing, MarketplaceOffer } from '~/store/marketplaceStore'
import { CAW_NAME_MARKETPLACE_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import Tooltip from '~/components/Tooltip'
import { useSignInModalStore } from '~/store/signInModalStore'
import ProfileEditForm from '~/components/ProfileEditForm'
import ImageLightbox from '~/components/ImageLightbox'

type ProfileTab = 'posts' | 'likes' | 'replies' | 'media'

const TAB_TO_FILTER: Record<ProfileTab, 'profile' | 'profile-likes' | 'profile-replies' | 'profile-media'> = {
  'posts': 'profile',
  'likes': 'profile-likes',
  'replies': 'profile-replies',
  'media': 'profile-media'
}

const VALID_TABS: ProfileTab[] = ['posts', 'likes', 'replies', 'media']

type ProfileData = {
  id: number
  address: string
  tokenId: number
  username: string
  image?: string
  bio?: string
  displayName?: string
  location?: string
  website?: string
  avatarUrl?: string
  coverPhotoUrl?: string
  profileUpdatePending?: boolean
  profileSource?: 'onchain' | 'offchain'
  cawCount: number
  followerCount: number
  followingCount: number
  likeCount: number
  likedCount?: number
  replyCount: number
  mediaCount: number
  isFollowing?: boolean
  followPending?: boolean
  followPendingAction?: 'FOLLOW' | 'UNFOLLOW' | null
  hasTipped?: boolean
  tipPending?: boolean
  xHandle?: string | null
  xFollowerBucket?: number | null
  xLinkedAt?: string | null
  createdAt: string
  updatedAt: string
}

// CAW usernames are constrained to [a-z0-9] on-chain. URLs are
// case-insensitive (A-Z works), but anything outside that charset means
// the URL is malformed — strip the bad chars and redirect to the cleaned
// path so users don't see a "Claim @<garbage>" CTA. If cleanup leaves
// nothing, render the not-found path without the claim CTA.
const sanitizeUsername = (raw: string): string => raw.replace(/[^a-zA-Z0-9]/g, '')

export const Profile: React.FC = () => {
  const t = useT()
  const { username: rawUsername } = useParams<{ username: string }>()
  // After sanitization, "" means the URL contained no valid chars at all.
  const cleanedUsername = rawUsername ? sanitizeUsername(rawUsername) : undefined
  const usernameWasMangled = !!rawUsername && cleanedUsername !== rawUsername
  const usernameIsEmpty = rawUsername !== undefined && cleanedUsername === ''
  // Use the cleaned form everywhere downstream — avoids API calls and
  // on-chain reads with garbage characters.
  const username = cleanedUsername || undefined
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as ProfileTab | null
  const [activeTab, setActiveTab] = useState<ProfileTab>(
    tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'posts'
  )

  // Scroll to top when navigating to a different profile
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [username])

  // Sync URL when tab changes
  useEffect(() => {
    const currentTab = searchParams.get('tab')
    if (currentTab !== activeTab) {
      if (activeTab === 'posts') {
        searchParams.delete('tab')
      } else {
        searchParams.set('tab', activeTab)
      }
      setSearchParams(searchParams, { replace: true })
    }
  }, [activeTab])
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [profileData, setProfileData] = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dbNotFound, setDbNotFound] = useState(false)
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const showSignIn = useSignInModalStore(s => s.show)
  const isCaptive = !activeToken?.username
  const { openModal } = useModalStore()
  const { isConnected, address } = useAccount()
  const currentChainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const signAndSubmit = useSignAndSubmitAction()
  const { openConnectModal } = useConnectModal()
  const navigate = useNavigate()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const [isSaving, setIsSaving] = useState(false)
  const [updateCost, setUpdateCost] = useState(0)

  // If the URL contained chars outside [a-zA-Z0-9], redirect to the
  // sanitized form so we don't pollute the API/contract with garbage and
  // so the user can't bookmark/share the broken URL. Empty cleanup (e.g.
  // /users/!@#) falls through to the not-found render below.
  useEffect(() => {
    if (!usernameWasMangled || !cleanedUsername) return
    navigate(`/users/${cleanedUsername}`, { replace: true })
  }, [usernameWasMangled, cleanedUsername, navigate])

  const isOnCorrectChain = currentChainId === chains.l2.chainId

  // DM identity check for prompts
  const { hasIdentity: ownDmEnabled } = useDmIdentity(activeToken?.tokenId)
  const { hasIdentity: peerDmEnabled } = useDmIdentity(profileData?.tokenId)
  const { initializeClient, isLoading: dmEnabling } = useDmClient(activeToken?.tokenId, activeToken?.username)
  // Route through a ref so the ensureWallet-deferred action hits the freshest
  // closure (one where walletClient is populated). See Messages.tsx for
  // the same pattern.
  const initializeClientRef = useRef(initializeClient)
  useEffect(() => { initializeClientRef.current = initializeClient }, [initializeClient])
  const ensureWallet = useEnsureWallet()
  const [dmEnableError, setDmEnableError] = useState<string | null>(null)

  const handleEnableDms = async () => {
    setDmEnableError(null)
    await ensureWallet(null, async () => {
      try {
        await initializeClientRef.current()
        // Identity will be detected by useDmIdentity on next poll; navigate to messages
        navigate('/messages')
      } catch (err) {
        setDmEnableError(formatWalletError(err))
      }
    })
  }

  // Follow button logic with hook
  const {
    isFollowing,
    isPending: followPending,
    isSigning: followSigning,
    wrongWallet: followWrongWallet,
    handleFollowClick,
    buttonText: followButtonText,
    hoverText: followHoverText
  } = useFollowButton({
    targetUserId: profileData?.tokenId || 0,
    initialIsFollowing: profileData?.isFollowing || false,
    initialIsPending: profileData?.followPending || false,
    initialPendingAction: profileData?.followPendingAction ?? null,
    onFollowStateChange: (newState) => {
      setProfileData(prev => prev ? { ...prev, isFollowing: newState } : null)
    }
  })

  const [followButtonHovered, setFollowButtonHovered] = useState(false)

  // Options menu state (mute/block for other profiles, manage for own profile)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [showOwnProfileMenu, setShowOwnProfileMenu] = useState(false)
  const [showShareProfileCard, setShowShareProfileCard] = useState(false)
  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [showCoverModal, setShowCoverModal] = useState(false)
  // Falls back to the default gradient cover when the stored URL 404s
  // or otherwise fails to load. Reset whenever the URL itself changes
  // so a re-uploaded cover gets a fresh chance to load.
  const [coverImgFailed, setCoverImgFailed] = useState(false)
  useEffect(() => { setCoverImgFailed(false) }, [profileData?.coverPhotoUrl])
  const [isMuted, setIsMuted] = useState(false)
  const [showBlockConfirmModal, setShowBlockConfirmModal] = useState(false)
  const [showCostExplanation, setShowCostExplanation] = useState(false)
  const [showInsufficientStake, setShowInsufficientStake] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [localProfileUpdatePending, setLocalProfileUpdatePending] = useState(false)
  const [showTipModal, setShowTipModal] = useState(false)
  const [tipPending, setTipPending] = useState(false)
  const [hasTipped, setHasTipped] = useState(false)
  const [activeListing, setActiveListing] = useState<MarketplaceListing | null>(null)
  const [myOffers, setMyOffers] = useState<MarketplaceOffer[]>([])

  // Cancel offer hooks
  const { writeContract: writeCancelOffer, data: cancelOfferHash, isPending: isCancellingOffer, error: cancelOfferError, reset: resetCancelOffer } = useWriteContract()
  const { isLoading: isCancelConfirming, isSuccess: isCancelSuccess } = useWaitForTransactionReceipt({ hash: cancelOfferHash })
  const [cancellingOfferId, setCancellingOfferId] = useState<number | null>(null)

  // Fetch active marketplace listing for this profile
  useEffect(() => {
    if (!profileData?.tokenId) { setActiveListing(null); return }
    apiFetch<MarketplaceListing | null>(`/api/marketplace/listings/token/${profileData.tokenId}`)
      .then(data => setActiveListing(data))
      .catch(() => setActiveListing(null))
  }, [profileData?.tokenId])

  // Fetch my active offers on this profile
  useEffect(() => {
    if (!profileData?.tokenId || !address) { setMyOffers([]); return }
    apiFetch<{ offers: MarketplaceOffer[]; total: number }>(`/api/marketplace/offers/token/${profileData.tokenId}`)
      .then(data => {
        const mine = data.offers.filter(o => o.offerer.toLowerCase() === address.toLowerCase())
        setMyOffers(mine)
      })
      .catch(() => setMyOffers([]))
  }, [profileData?.tokenId, address])

  // Handle cancel offer success
  useEffect(() => {
    if (!isCancelSuccess || cancellingOfferId === null) return
    // Optimistically update API
    const offer = myOffers.find(o => o.offerId === cancellingOfferId)
    if (offer) {
      apiFetch(`/api/marketplace/offers/${offer.offerId}/cancelled`, {
        method: 'POST',
        body: JSON.stringify({ txHash: cancelOfferHash }),
      }).catch(() => {})
    }
    setMyOffers(prev => prev.filter(o => o.offerId !== cancellingOfferId))
    setCancellingOfferId(null)
    resetCancelOffer()
  }, [isCancelSuccess])

  // Server-backed blocking
  const { blockUser, unblockUser, isBlocked: checkIsBlocked } = useBlockedUsersStore()
  const isBlocked = profileData?.tokenId ? checkIsBlocked(profileData.tokenId) : false

  // Use username from params or fallback to activeToken's username.
  // Fallback only applies when the URL had no username segment at all —
  // an explicit but invalid URL (e.g. /users/!@#) should not silently
  // redirect the viewer to their own profile.
  const displayUsername = username || (rawUsername === undefined ? (activeToken?.username || 'user') : 'user')

  // Fetch profile data
  useEffect(() => {
    const fetchProfile = async () => {
      if (!displayUsername || displayUsername === 'user') {
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      setDbNotFound(false)

      try {
        const data = await apiFetch<ProfileData>(`/api/users/${displayUsername}`)
        setProfileData(data)
        setHasTipped(data.hasTipped || false)
        setTipPending(data.tipPending || false)
      } catch (err: any) {
        if (err.message?.includes('404')) {
          setDbNotFound(true)
          return
        }
        console.error('Failed to fetch profile:', err)
        setError(t('profile.error.failed_to_load'))
      } finally {
        setLoading(false)
      }
    }

    fetchProfile()
  }, [displayUsername, activeToken?.tokenId])

  // If the DB doesn't have the user, check on-chain availability directly
  // via the L1 minter contract (O(1) reverse lookup). Doing this on the
  // frontend keeps the server fast for unrelated requests.
  const { data: onChainTokenIdRaw, isLoading: checkingOnChain } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'idByUsername',
    args: [displayUsername || ''],
    query: { enabled: dbNotFound && !!displayUsername && displayUsername !== 'user' },
  })
  const onChainTokenId = onChainTokenIdRaw ? Number(onChainTokenIdRaw) : 0
  const availableOnChain = dbNotFound && !checkingOnChain && onChainTokenId === 0

  // If the name exists on-chain but not in the DB, ask the server to ensure
  // the user record (which pulls their info from chain and upserts them),
  // then re-fetch so the page renders normally. No-op if the ensure call fails.
  const ensureTriggered = useRef<number | null>(null)
  useEffect(() => {
    if (!dbNotFound || checkingOnChain || onChainTokenId === 0) return
    if (ensureTriggered.current === onChainTokenId) return // don't spam
    ensureTriggered.current = onChainTokenId

    ;(async () => {
      try {
        // /ensure now returns 202 until the indexer writes the row (Tier 1
        // RPC-out-of-API refactor). retryOnIndexing waits for the indexer
        // before we attempt to re-fetch the profile.
        await retryOnIndexing(() => apiFetch('/api/users/ensure', {
          method: 'POST',
          body: JSON.stringify({ tokenId: onChainTokenId }),
        }))
        // Re-fetch the user — if sync succeeded, dbNotFound flips back to false
        try {
          const data = await apiFetch<ProfileData>(`/api/users/${displayUsername}`)
          setProfileData(data)
          setDbNotFound(false)
          setHasTipped(data.hasTipped || false)
          setTipPending(data.tipPending || false)
        } catch { /* user not found yet */ }
      } catch (err) {
        console.warn('[Profile] ensure failed:', err)
      }
    })()
  }, [dbNotFound, checkingOnChain, onChainTokenId, displayUsername])

  // Poll for tip confirmation
  useEffect(() => {
    if (!tipPending || !displayUsername || displayUsername === 'user') return

    const interval = setInterval(async () => {
      try {
        const data = await apiFetch<ProfileData>(`/api/users/${displayUsername}`)
        setProfileData(data)
        setHasTipped(data.hasTipped || false)
        setTipPending(data.tipPending || false)
      } catch {
        // Ignore fetch errors during polling
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [tipPending, displayUsername])

  // Poll for profile update completion when localProfileUpdatePending is true
  const setAvatar = useTokenDataStore(s => s.setAvatar)
  const optimisticAvatar = useTokenDataStore(s => profileData?.tokenId ? s.avatarsByTokenId[profileData.tokenId] : undefined)
  useEffect(() => {
    if (!localProfileUpdatePending || !displayUsername || displayUsername === 'user') return

    const interval = setInterval(async () => {
      try {
        const data = await apiFetch<ProfileData>(`/api/users/${displayUsername}`)
        setProfileData(data)
        if (!data.profileUpdatePending) {
          setLocalProfileUpdatePending(false)
          // Update avatar in global store so ProfileChooser reflects the change immediately
          if (data.tokenId) {
            setAvatar(data.tokenId, data.avatarUrl || null)
          }
        }
      } catch {
        // Ignore fetch errors during polling
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [localProfileUpdatePending, displayUsername])

  // Form state - Initialize with current profile data
  const [formData, setFormData] = useState({
    displayName: profileData?.displayName || '',
    description: profileData?.bio || '',
    location: profileData?.location || '',
    website: profileData?.website || ''
  })

  // Update form data when profile data changes
  useEffect(() => {
    if (profileData) {
      setFormData({
        displayName: profileData.displayName || '',
        description: profileData.bio || '',
        location: profileData.location || '',
        website: profileData.website || ''
      })
    }
  }, [profileData])

  // Fetch mute status when viewing another user's profile (muting still uses API)
  useEffect(() => {
    const fetchMuteStatus = async () => {
      if (!activeToken?.tokenId || !profileData?.tokenId || activeToken.tokenId === profileData.tokenId) {
        return
      }

      try {
        const muteRes = await apiFetch<{ isMuted: boolean }>(`/api/notifications/is-account-muted/${profileData.tokenId}`)
        setIsMuted(muteRes.isMuted)
      } catch (err) {
        console.error('Failed to fetch mute status:', err)
      }
    }

    fetchMuteStatus()
  }, [activeToken?.tokenId, profileData?.tokenId])

  // Handle mute/unmute (still uses API - requires auth)
  const handleToggleMute = async () => {
    if (!activeToken?.tokenId || !profileData?.tokenId) return

    try {
      if (isMuted) {
        await apiFetch(`/api/notifications/mute-account/${profileData.tokenId}`, { method: 'DELETE' })
        setIsMuted(false)
      } else {
        await apiFetch(`/api/notifications/mute-account/${profileData.tokenId}`, { method: 'POST' })
        setIsMuted(true)
      }
    } catch (err) {
      console.error('Failed to toggle mute:', err)
    } finally {
      setShowOptionsMenu(false)
    }
  }

  // Handle block/unblock (server-backed)
  const effectiveTokenId = activeTokenId || activeToken?.tokenId

  const handleToggleBlock = () => {
    if (!profileData?.tokenId || !effectiveTokenId) return

    if (isBlocked) {
      unblockUser(effectiveTokenId, profileData.tokenId)
      setShowOptionsMenu(false)
    } else {
      setShowOptionsMenu(false)
      setShowBlockConfirmModal(true)
    }
  }

  const handleConfirmBlock = () => {
    if (!profileData?.tokenId || !profileData?.username || !effectiveTokenId) return

    blockUser(effectiveTokenId, profileData.tokenId, profileData.username)
    setShowBlockConfirmModal(false)
  }

  // Close options menu and modals on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showBlockConfirmModal) {
          setShowBlockConfirmModal(false)
        } else if (showOptionsMenu) {
          setShowOptionsMenu(false)
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showOptionsMenu, showBlockConfirmModal])

  // Image handling state
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined)
  const [coverPreview, setCoverPreview] = useState<string | undefined>(undefined)
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined)
  const [isUploading, setIsUploading] = useState(false)
  const [cropperFile, setCropperFile] = useState<File | null>(null)

  // Image handling functions
  const uploadCroppedAvatar = async (file: File) => {
    setProfileError(null)
    setIsUploading(true)
    try {
      const { uploadAvatar } = await import('~/api/upload')
      const imageUrl = await uploadAvatar(file, activeToken?.tokenId || 0)
      if (!imageUrl) throw new Error('No URL returned from upload')
      const reader = new FileReader()
      reader.onload = (e) => setAvatarPreview(e.target?.result as string)
      reader.readAsDataURL(file)
      setAvatarUrl(imageUrl)
      calculateUpdateCost()
    } catch (err) {
      console.error('Failed to upload image:', err)
      setProfileError(t('profile.error.upload_image'))
    } finally {
      setIsUploading(false)
    }
  }

  const handleImageSelect = async (type: 'avatar' | 'cover', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setProfileError(t('profile.error.invalid_image'))
      return
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setProfileError(t('profile.error.image_too_big'))
      return
    }

    setProfileError(null)

    // Avatars: open cropper, upload after the user picks the crop window.
    if (type === 'avatar') {
      setCropperFile(file)
      return
    }

    setIsUploading(true)
    try {
      const { uploadMedia } = await import('~/api/upload')
      const imageUrl = (await uploadMedia([file], activeToken?.tokenId || 0, 'cover'))[0]
      if (!imageUrl) throw new Error('No URL returned from upload')
      const reader = new FileReader()
      reader.onload = (e) => setCoverPreview(e.target?.result as string)
      reader.readAsDataURL(file)
      setCoverUrl(imageUrl)
      calculateUpdateCost()
    } catch (err) {
      console.error('Failed to upload image:', err)
      setProfileError(t('profile.error.upload_image'))
    } finally {
      setIsUploading(false)
    }
  }

  // Calculate cost for profile update based on data size
  const calculateUpdateCost = () => {
    // Only count fields that have changed - use compact keys
    const changedData: any = {}

    // Check if displayName changed (allow empty values)
    if (formData.displayName !== (profileData?.displayName || '')) {
      changedData.n = formData.displayName // n = name/displayName
    }
    // Check if description changed (allow empty values)
    if (formData.description !== (profileData?.bio || '')) {
      changedData.d = formData.description // d = description/bio
    }
    // Check if location changed (allow empty values)
    if (formData.location !== (profileData?.location || '')) {
      changedData.l = formData.location // l = location
    }
    // Check if website changed (allow empty values)
    if (formData.website !== (profileData?.website || '')) {
      changedData.w = formData.website // w = website
    }
    if (avatarUrl) {
      changedData.a = avatarUrl // a = avatar
    }
    if (coverUrl) {
      changedData.c = coverUrl // c = cover
    }

    // If no changes, cost is 0
    if (Object.keys(changedData).length === 0) {
      setUpdateCost(0)
      return
    }

    // Calculate cost based on actual data being submitted with compact format
    const actionText = `p:${JSON.stringify(changedData)}`
    const dataSize = actionText.length

    // Base cost: 100 CAW + 10 CAW per character (accounts for gas costs)
    const cost = 100 + Math.ceil(dataSize * 10)

    setUpdateCost(cost)
  }

  // Update cost when form data changes
  useEffect(() => {
    calculateUpdateCost()
  }, [formData, avatarUrl, coverUrl, profileData])

  const [isSavingOffChain, setIsSavingOffChain] = useState(false)
  const [saveOnChain, setSaveOnChain] = useState(false)
  const providerDomain = typeof window !== 'undefined' ? window.location.hostname : ''

  // Handle off-chain profile update — saves to DB only, scoped to this provider
  const handleOffChainUpdate = async () => {
    if (!activeToken) {
      setProfileError(t('profile.error.select_token'))
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
      setProfileError(t('profile.error.no_changes'))
      return
    }

    setProfileError(null)
    setIsSavingOffChain(true)
    try {
      const res = await apiFetch<{ user: ProfileData }>(
        `/api/users/${activeToken.tokenId}/profile`,
        { method: 'PATCH', body: JSON.stringify(changes) }
      )

      setProfileData(prev => prev ? {
        ...prev,
        ...res.user,
        profileSource: 'offchain',
      } : prev)

      // Update avatar in global store so ProfileChooser reflects immediately
      if (res.user?.avatarUrl !== undefined && activeToken?.tokenId) {
        setAvatar(activeToken.tokenId, res.user.avatarUrl || null)
      }

      setIsEditModalOpen(false)
      setAvatarPreview(undefined)
      setCoverPreview(undefined)
      setAvatarUrl(undefined)
      setCoverUrl(undefined)
    } catch (err: any) {
      console.error('Failed to save off-chain profile:', err)
      setProfileError(err?.message?.split('\n')[0]?.slice(0, 120) || 'Failed to save profile')
    } finally {
      setIsSavingOffChain(false)
    }
  }

  // Handle profile update submission
  const handleProfileUpdate = async () => {
    // If wallet not connected, open connect modal
    if (!isConnected) {
      openConnectModal?.()
      return
    }

    // Check if on correct chain, if not switch
    if (!isOnCorrectChain) {
      try {
        await switchChain({ chainId: chains.l2.chainId })
      } catch (err) {
        console.error('Failed to switch chain:', err)
      }
      return
    }

    // Check if user has an active token
    if (!activeToken) {
      setProfileError(t('profile.error.select_token'))
      return
    }

    setProfileError(null)
    setIsSaving(true)

    // Declare variables in outer scope so they're accessible in catch block
    let profileUpdateData: any = {}
    let actionText = ''

    try {
      // Only include fields that have changed - use compact keys to save gas
      // Check if displayName changed (allow empty values)
      if (formData.displayName !== (profileData?.displayName || '')) {
        profileUpdateData.n = formData.displayName // n = name/displayName
      }
      // Check if description changed (allow empty values)
      if (formData.description !== (profileData?.bio || '')) {
        profileUpdateData.d = formData.description // d = description/bio
      }
      // Check if location changed (allow empty values)
      if (formData.location !== (profileData?.location || '')) {
        profileUpdateData.l = formData.location // l = location
      }
      // Check if website changed (allow empty values)
      if (formData.website !== (profileData?.website || '')) {
        profileUpdateData.w = formData.website // w = website
      }
      if (avatarUrl) {
        profileUpdateData.a = avatarUrl // a = avatar
      }
      if (coverUrl) {
        profileUpdateData.c = coverUrl // c = cover
      }

      // If no changes, don't submit
      if (Object.keys(profileUpdateData).length === 0) {
        setProfileError(t('profile.error.no_changes'))
        setIsSaving(false)
        return
      }

      // Create the action text with compact profile update prefix
      actionText = `p:${JSON.stringify(profileUpdateData)}`

      // Calculate total cost: data-dependent cost + validator tip
      // Both are in whole CAW tokens (contract multiplies by 10^18)
      const { getValidatorTip } = await import('~/api/actions')
      const totalCost = BigInt(updateCost) + getValidatorTip()

      // Check if user has enough CAW staked to cover the cost
      const totalCostWei = totalCost * 10n**18n
      if (!activeToken.stakedAmount || activeToken.stakedAmount < totalCostWei) {
        setShowInsufficientStake(true)
        setIsSaving(false)
        return
      }

      // Submit as other action with total cost (includes validator tip + data cost)
      await signAndSubmit({
        actionType: 'other',
        senderId: activeToken.tokenId,
        text: actionText,
        amounts: [totalCost]
      })

      // Set local pending state immediately
      setLocalProfileUpdatePending(true)

      // Optimistically update profile data so changes show immediately
      setProfileData(prev => prev ? {
        ...prev,
        profileUpdatePending: true,
        ...(formData.displayName !== (prev.displayName || '') && { displayName: formData.displayName }),
        ...(formData.description !== (prev.bio || '') && { bio: formData.description }),
        ...(formData.location !== (prev.location || '') && { location: formData.location }),
        ...(formData.website !== (prev.website || '') && { website: formData.website }),
        ...(avatarUrl && { avatarUrl }),
        ...(coverUrl && { coverPhotoUrl: coverUrl }),
      } : prev)

      // Close modal and refresh profile data
      setIsEditModalOpen(false)

      // Clear temporary state
      setAvatarPreview(undefined)
      setCoverPreview(undefined)
      setAvatarUrl(undefined)
      setCoverUrl(undefined)
    } catch (err: any) {
      console.error('Failed to update profile:', err)
      console.error('Error details:', {
        message: err?.message,
        stack: err?.stack,
        response: err?.response,
        data: profileUpdateData,
        actionText,
        activeToken,
        updateCost
      })
      // Extract a clean error message
      let errorMessage = t('profile.error.update_failed')
      if (err?.message) {
        if (err.message.includes('User rejected') || err.message.includes('user rejected')) {
          errorMessage = t('profile.error.tx_rejected')
        } else if (err.message.includes('chainId should be same')) {
          errorMessage = t('profile.error.wrong_network')
        } else {
          // Take first line and trim
          errorMessage = err.message.split('\n')[0].slice(0, 100)
        }
      }
      setProfileError(errorMessage)
    } finally {
      setIsSaving(false)
    }
  }

  const triggerFileInput = (type: 'avatar' | 'cover') => {
    // Add a small delay to ensure the modal doesn't close
    setTimeout(() => {
      const inputId = type === 'avatar' ? 'avatar-upload' : 'cover-upload'
      const input = document.getElementById(inputId) as HTMLInputElement
      if (input) {
        input.click()
      }
    }, 10)
  }

  // Check if this is our own profile or someone else's
  const isOwnProfile = !username || username === activeToken?.username

  // Format join date
  const formatJoinDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }

  // Format stats
  const formatStat = (count: number) => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
    return count.toString()
  }

  // define our four tabs with counts. count is shown only on sm+ — on
  // mobile the bare label has to fit even for long translations
  // ("Publicaciones", "Respuestas").
  const tabCount = (n: number | undefined) => n ? formatStat(n) : undefined
  const profileTabs: TabItem<ProfileTab>[] = [
    { id: 'posts',   label: t('profile.tab.posts'),   count: tabCount(profileData?.cawCount)   },
    { id: 'replies', label: t('profile.tab.replies'), count: tabCount(profileData?.replyCount) },
    { id: 'media',   label: t('profile.tab.media'),   count: tabCount(profileData?.mediaCount) },
    { id: 'likes',   label: t('profile.tab.likes'),   count: tabCount(profileData?.likedCount) },
  ]

  // Profile not in our DB — check on-chain availability for better UX.
  // Also handle the edge case where the URL contained only non-alphanumeric
  // chars and sanitization left us with nothing to look up.
  if (dbNotFound || usernameIsEmpty) {
    return (
        <div className="max-w-2xl mx-auto px-6 py-16 text-center">
          <div className={`mb-6 w-24 h-24 mx-auto rounded-full flex items-center justify-center ${
            isDark ? 'bg-gray-800' : 'bg-gray-200'
          }`}>
            <svg className={`w-12 h-12 ${isDark ? 'text-gray-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
            This profile doesn't exist
          </h2>
          {usernameIsEmpty ? (
            <p className={`mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              That URL doesn't look like a valid username. Usernames are letters and numbers only.
            </p>
          ) : checkingOnChain ? (
            <p className={`mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Checking availability...
            </p>
          ) : availableOnChain ? (
            <>
              <p className={`mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                @{displayUsername} hasn't been claimed yet. You could be the first to register it.
              </p>
              <Link
                to={`/usernames/new?username=${encodeURIComponent(displayUsername)}`}
                className="inline-block px-6 py-2 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
              >
                Claim @{displayUsername}
              </Link>
            </>
          ) : (
            <p className={`mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Syncing @{displayUsername} from on-chain data...
            </p>
          )}
        </div>
    )
  }

  // If this user is blocked, show blocked state (even if they're selected as active account)
  if (isBlocked && profileData) {
    return (
        <div className="max-w-2xl mx-auto px-6 py-16 text-center">
          <div className={`mb-6 w-24 h-24 mx-auto rounded-full flex items-center justify-center ${
            isDark ? 'bg-gray-800' : 'bg-gray-200'
          }`}>
            <svg className={`w-12 h-12 ${isDark ? 'text-gray-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
            You blocked @{profileData.username}
          </h2>
          <p className={`mb-6 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            You won't see their posts in your feed while they're blocked.
          </p>
          <button
            onClick={handleToggleBlock}
            className={`px-6 py-2 rounded-full font-medium transition-all duration-200 ${
              isDark
                ? 'bg-white text-black hover:bg-gray-200'
                : 'bg-black text-white hover:bg-gray-800'
            }`}
          >
            Unblock
          </button>
        </div>
    )
  }

  return (
    <>
      {/* Cover Photo - Full Width */}
      <div className="relative transition-all duration-300">
        <div className="h-48 w-full relative overflow-hidden">
          {profileData?.coverPhotoUrl && !coverImgFailed ? (
            <img
              src={profileData.coverPhotoUrl}
              alt="Cover photo"
              className="w-full h-full object-cover cursor-pointer"
              onClick={() => setShowCoverModal(true)}
              onError={() => setCoverImgFailed(true)}
            />
          ) : (
            <div
              className={`w-full h-full ${isDark ? 'bg-gradient-to-b from-black via-gray-900 to-black' : ''}`}
              style={isDark ? undefined : { background: 'linear-gradient(to bottom, white, #282828, white)' }}
            />
          )}
          <button
            type="button"
            aria-label="Back"
            onClick={() => {
              if (window.history.state && window.history.state.idx > 0) {
                navigate(-1)
              } else {
                navigate('/home')
              }
            }}
            className="absolute top-3 left-3 z-[80] w-9 h-9 rounded-full flex items-center justify-center bg-black/40 hover:bg-black/60 text-white backdrop-blur-sm transition-colors cursor-pointer"
          >
            <HiArrowLeft className="w-5 h-5" />
          </button>
        </div>

        {/* Profile Picture - Positioned within max-w-2xl bounds */}
        <div className="max-w-2xl mx-auto relative">
          <div className="absolute -top-20 left-6">
            <button
              type="button"
              aria-label="View profile photo"
              onClick={() => setShowAvatarModal(true)}
              className={`w-40 h-40 rounded-full border-4 overflow-hidden transition-all duration-300 cursor-pointer ${
              isDark ? 'border-black bg-black' : 'border-white bg-gray-200'
            }`}>
              {profileData && (
                <Avatar
                  src={optimisticAvatar || getUserAvatar(profileData)}
                  fallbackSrc={getDefaultAvatarForUser(profileData)}
                  alt={`${profileData.username || displayUsername} avatar`}
                  className="w-full h-full rounded-full"
                />
              )}
            </button>
          </div>
        </div>
      </div>

        <div className={`max-w-2xl mx-auto min-h-screen overflow-x-hidden transition-all duration-300 ${
          isDark ? 'bg-black text-white' : 'bg-white text-black'
        }`}>

        {/* Profile Info - Layout de 2 columnas */}
        <div className={`pt-24 pb-6 px-6 transition-all duration-300 ${
          isDark ? 'bg-black text-white' : 'bg-white text-black'
        }`}>
          {/* Layout principal: 2 columnas */}
          <div className="flex justify-between items-start gap-4">
            {/* Columna izquierda: Username, Joined, Stats */}
            <div className="flex-1 min-w-0">
              {/* Display Name, Username, and Joined */}
              <div className="mb-4 min-w-0 pl-4 sm:pl-0">
                <h1 className={`text-2xl font-bold transition-all duration-300 flex items-center gap-1.5 ${
                  isDark ? 'text-white' : 'text-black'
                } truncate`}>
                  {profileData?.displayName || profileData?.username || displayUsername}
                  <XBadge xHandle={profileData?.xHandle} xFollowerBucket={profileData?.xFollowerBucket} size="md" />
                </h1>
                <p className={`text-base mt-0.5 transition-all duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                } truncate`}>
                  @{profileData?.username || displayUsername}
                </p>
                {profileData?.address && (
                  <div className="flex items-center gap-2 mt-1">
                    <Link
                      to={`/address/${profileData.address.toLowerCase()}`}
                      className={`text-xs font-mono transition-all duration-200 ${
                        isDark
                          ? 'text-gray-500 hover:text-gray-300'
                          : 'text-gray-400 hover:text-gray-600'
                      }`}
                    >
                      {profileData.address.slice(0, 5)}...{profileData.address.slice(-4)}
                    </Link>
                    <CopyAddressButton address={profileData.address} iconOnly />
                  </div>
                )}
                <p className={`text-sm mt-1 transition-all duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  {profileData?.createdAt ? t('profile.joined', { date: formatJoinDate(profileData.createdAt) }) : t('profile.joined_recently')}
                </p>

                {/* For Sale banner */}
                {activeListing && (
                  <button
                    onClick={() => {
                      if (activeListing.listingType === 'ENGLISH_AUCTION') {
                        useMarketplaceStore.getState().openBidModal(activeListing)
                      } else {
                        useMarketplaceStore.getState().openBuyModal(activeListing)
                      }
                    }}
                    className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                      isDark
                        ? 'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25'
                        : 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
                    }`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
                    </svg>
                    For Sale
                  </button>
                )}

                {/* Active offer banner — shown when the viewer has an offer on this profile */}
                {myOffers.map(offer => {
                  const isCancelling = cancellingOfferId === offer.offerId && (isCancellingOffer || isCancelConfirming)
                  return (
                    <div
                      key={offer.offerId}
                      className={`mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${
                        isDark
                          ? 'bg-blue-500/15 text-blue-400'
                          : 'bg-blue-50 text-blue-700'
                      }`}
                    >
                      <span>Your offer: {offer.paymentToken === 'ETH' || offer.paymentToken === 'WETH'
                        ? `${parseFloat((Number(BigInt(offer.amount)) / 1e18).toFixed(6))} ${offer.paymentToken}`
                        : `${offer.amount} ${offer.paymentToken}`
                      }</span>
                      <button
                        onClick={() => {
                          ensureWallet({ chainId: chains.l1.chainId }, async () => {
                            if (cancelOfferError) resetCancelOffer()
                            setCancellingOfferId(offer.offerId)
                            writeCancelOffer({
                              address: CAW_NAME_MARKETPLACE_ADDRESS,
                              abi: cawProfileMarketplaceAbi,
                              functionName: 'cancelOffer',
                              args: [BigInt(offer.offerId)],
                              chainId: chains.l1.chainId,
                            })
                          })
                        }}
                        disabled={isCancelling}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition cursor-pointer disabled:opacity-50 ${
                          isDark
                            ? 'bg-white/10 hover:bg-white/20 text-white'
                            : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                        }`}
                      >
                        {isCancelling ? t('common.cancelling') : t('common.cancel')}
                      </button>
                    </div>
                  )
                })}
              </div>

              {/* Stats - Alineadas horizontalmente */}
              {/* Mobile alignment: keep in sync with the name block (pl-4). */}
              <div className="flex gap-5 sm:gap-8 mb-6 pl-4 sm:pl-0">
                <div className="text-center">
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {formatStat(profileData?.cawCount || 0)}
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    {t('profile.stats.posts')}
                  </div>
                </div>
                <button
                  onClick={() => openModal('followingList', { username: profileData?.username || displayUsername })}
                  className="cursor-pointer hover:opacity-80 transition-opacity text-center"
                >
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {formatStat(profileData?.followingCount || 0)}
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    {t('profile.stats.following')}
                  </div>
                </button>
                <button
                  onClick={() => openModal('followersList', { username: profileData?.username || displayUsername })}
                  className="cursor-pointer hover:opacity-80 transition-opacity text-center"
                >
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {formatStat(profileData?.followerCount || 0)}
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    {t('profile.stats.followers')}
                  </div>
                </button>
              </div>

              {/* Bio - Arriba de location y website, puede estirarse hacia la derecha */}
              <div className="mb-4 pr-6">
                {profileData?.profileUpdatePending && (
                  <div className={`text-base italic mb-2 transition-all duration-300 ${
                    isDark ? 'text-yellow-400' : 'text-yellow-600'
                  }`}>
                    Profile info updating...
                  </div>
                )}
                {profileData?.bio && (
                  <p className={`text-base leading-relaxed transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {profileData.bio.split('\n').map((line, i) => (
                      <React.Fragment key={i}>
                        {line}
                        {i < profileData.bio!.split('\n').length - 1 && <br />}
                      </React.Fragment>
                    ))}
                  </p>
                )}
              </div>

              {/* Location and Website - En el mismo renglón */}
              <div className="flex items-center space-x-6">
                {profileData?.location && (
                  <div className="flex items-center space-x-2">
                    <HiLocationMarker className={`w-4 h-4 transition-colors duration-300 ${
                      isDark ? 'text-gray-400' : 'text-gray-500'
                    }`} />
                    <span className={`text-base transition-colors duration-300 ${
                      isDark ? 'text-gray-300' : 'text-gray-600'
                    }`}>
                      {profileData.location}
                    </span>
                  </div>
                )}

                {profileData?.website && (
                  <div className="flex items-center space-x-2">
                    <HiGlobe className={`w-4 h-4 transition-colors duration-300 ${
                      isDark ? 'text-gray-400' : 'text-gray-500'
                    }`} />
                    <a
                      href={profileData.website.startsWith('http') ? profileData.website : `https://${profileData.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`text-base transition-colors duration-300 hover:underline ${
                        isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-500'
                      }`}
                    >
                      {profileData.website.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                )}
              </div>
            </div>

            {/* Columna derecha: Solo Edit Button */}
            <div className="ml-4 flex flex-col items-end flex-shrink-0">
              {/* Edit Button */}
              <div>
                {isOwnProfile ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setIsEditModalOpen(true)}
                      disabled={profileData?.profileUpdatePending || localProfileUpdatePending}
                      className={`px-4 py-2 rounded-full font-semibold border transition-all duration-200 ${
                        profileData?.profileUpdatePending || localProfileUpdatePending
                          ? 'opacity-60 cursor-not-allowed'
                          : 'cursor-pointer'
                      } ${
                        isDark
                          ? 'border-white/60 text-white hover:bg-white hover:text-black'
                          : 'border-black/60 text-black hover:bg-black hover:text-white'
                      }`}
                    >
                      {(profileData?.profileUpdatePending || localProfileUpdatePending) ? (
                        <>
                          <svg className="w-4 h-4 inline sm:mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span className="hidden sm:inline">{t('profile.updating')}</span>
                        </>
                      ) : (
                        <>
                          <HiPencil className="w-4 h-4 inline sm:mr-2" />
                          <span className="hidden sm:inline">{t('profile.edit')}</span>
                        </>
                      )}
                    </button>
                    {/* Three-dot menu for List for Sale / Transfer */}
                    <div className="relative">
                      <button
                        onClick={() => setShowOwnProfileMenu(!showOwnProfileMenu)}
                        className={`p-2 rounded-full border transition-all duration-200 cursor-pointer ${
                          isDark
                            ? 'border-white/60 text-white hover:bg-white/10'
                            : 'border-black/60 text-black hover:bg-black/10'
                        }`}
                      >
                        <HiDotsHorizontal className="w-5 h-5" />
                      </button>
                      {showOwnProfileMenu && (
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => setShowOwnProfileMenu(false)}
                          />
                          <div className={`absolute right-0 top-full mt-2 w-48 rounded-lg shadow-lg z-50 overflow-hidden ${
                            isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
                          }`}>
                            <button
                              onClick={() => {
                                setShowOwnProfileMenu(false)
                                setShowShareProfileCard(true)
                              }}
                              className={`w-full px-4 py-3 text-left text-sm transition-colors cursor-pointer ${
                                isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-gray-900'
                              }`}
                            >
                              {t('profile.menu.share')}
                            </button>
                            <button
                              onClick={() => {
                                setShowOwnProfileMenu(false)
                                if (profileData?.tokenId !== undefined && profileData?.username) {
                                  useMarketplaceStore.getState().openCreateListing(profileData.tokenId, profileData.username)
                                }
                              }}
                              className={`w-full px-4 py-3 text-left text-sm transition-colors cursor-pointer ${
                                isDark ? 'hover:bg-white/10 text-yellow-500' : 'hover:bg-gray-100 text-yellow-600'
                              }`}
                            >
                              {t('profile.menu.list_for_sale')}
                            </button>
                            <button
                              onClick={() => {
                                setShowOwnProfileMenu(false)
                                if (profileData?.tokenId !== undefined && profileData?.username) {
                                  useMarketplaceStore.getState().openViewOffers(profileData.tokenId, profileData.username)
                                }
                              }}
                              className={`w-full px-4 py-3 text-left text-sm transition-colors cursor-pointer ${
                                isDark ? 'hover:bg-white/10 text-yellow-500' : 'hover:bg-gray-100 text-yellow-600'
                              }`}
                            >
                              {t('profile.menu.view_offers')}
                            </button>
                            <button
                              onClick={() => {
                                setShowOwnProfileMenu(false)
                                if (profileData?.tokenId !== undefined && profileData?.username) {
                                  useTransferModalStore.getState().show(profileData.tokenId, profileData.username)
                                }
                              }}
                              className={`w-full px-4 py-3 text-left text-sm transition-colors cursor-pointer ${
                                isDark ? 'hover:bg-red-500/20 text-red-400' : 'hover:bg-red-50 text-red-500'
                              }`}
                            >
                              {t('profile.menu.transfer')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col space-y-3">
                    <div className="flex flex-col items-center">
                      <Tooltip text={t('post.processing')} disabled={!followPending || followSigning}>
                      <button
                        onClick={() => { if (isCaptive) { showSignIn(t('profile.signin.follow')); return } handleFollowClick() }}
                        disabled={followPending || followWrongWallet}
                        onMouseEnter={() => setFollowButtonHovered(true)}
                        onMouseLeave={() => setFollowButtonHovered(false)}
                        className={`px-6 sm:px-8 py-2 rounded-full font-semibold border transition-all duration-200 ${
                          followWrongWallet ? 'opacity-50 cursor-not-allowed' :
                          followPending ? 'opacity-90 cursor-not-allowed' : 'cursor-pointer'
                        } ${
                          isFollowing
                            ? (isDark
                                ? 'border-white bg-white text-black' + (!followPending ? ' hover:bg-black hover:text-white hover:border-white' : '')
                                : 'border-gray-800 bg-gray-800 text-white' + (!followPending ? ' hover:bg-white hover:text-gray-800 hover:border-gray-800' : ''))
                            : (isDark
                                ? 'border-white text-white' + (!followPending ? ' hover:bg-white hover:text-black' : '')
                                : 'border-gray-800 text-gray-800' + (!followPending ? ' hover:bg-gray-800 hover:text-white' : ''))
                        }`}
                      >
                        {followPending ? followButtonText : (followButtonHovered && isFollowing ? followHoverText : followButtonText)}
                      </button>
                      </Tooltip>
                      {followWrongWallet && (
                        <p className="mt-2 text-xs text-yellow-500">Please switch to the correct wallet</p>
                      )}
                    </div>
                    
                    <div className="flex justify-center space-x-2">
                      <Tooltip text="Tip"><button
                        onClick={() => { if (isCaptive) { showSignIn(t('profile.signin.tip')); return } setShowTipModal(true) }}
                        className={`p-2 rounded-full border transition-all duration-200 cursor-pointer hover:bg-yellow-500/10 ${
                          tipPending || hasTipped
                            ? 'border-yellow-500/60 text-yellow-500'
                            : isDark
                              ? 'border-white/60 text-white hover:text-yellow-500'
                              : 'border-black/60 text-black hover:text-yellow-500'
                        }`}
                      >
                        {tipPending ? (
                          <div className="relative w-5 h-5">
                            <div className="w-5 h-5 border-2 border-gray-400 border-t-yellow-500 rounded-full animate-spin"></div>
                            <svg className="absolute inset-0 w-3 h-3 m-auto text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        ) : (
                          <HiOutlineCurrencyDollar className="w-5 h-5" />
                        )}
                      </button></Tooltip>
                      {/* Hide offer button if viewing own profile by wallet address */}
                      {!(address && profileData?.address && address.toLowerCase() === profileData.address.toLowerCase()) && (
                      <Tooltip text={t('profile.tooltip.offer_to_buy')}><button
                        onClick={() => {
                          if (profileData?.tokenId !== undefined && profileData?.username) {
                            useMarketplaceStore.getState().openMakeOffer(profileData.tokenId, profileData.username)
                          }
                        }}
                        className={`p-2 rounded-full border transition-all duration-200 cursor-pointer hover:bg-yellow-500/10 ${
                          isDark
                            ? 'border-white/60 text-white hover:text-yellow-500'
                            : 'border-black/60 text-black hover:text-yellow-500'
                        }`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
                        </svg>
                      </button></Tooltip>
                      )}
                      <Tooltip text={peerDmEnabled === false ? t('profile.tooltip.dm_disabled') : t('profile.tooltip.send_message')}><button
                        onClick={() => {
                          if (isCaptive) { showSignIn(t('profile.signin.dm')); return }
                          navigate(`/messages/${profileData?.username || displayUsername}`)
                        }}
                        disabled={peerDmEnabled === false}
                        className={`p-2 rounded-full border transition-all duration-200 ${
                          peerDmEnabled === false
                            ? 'opacity-40 cursor-not-allowed'
                            : 'cursor-pointer hover:bg-white/10'
                        } ${
                          isDark
                            ? 'border-white/60 text-white hover:bg-white/10'
                            : 'border-black/60 text-black hover:bg-black/10'
                        }`}
                      >
                        <HiOutlineMail className="w-5 h-5" />
                      </button></Tooltip>
                      
                      <div className="relative">
                        <Tooltip text={t('post.more_options')}><button
                          onClick={() => setShowOptionsMenu(!showOptionsMenu)}
                          className={`p-2 rounded-full border transition-all duration-200 cursor-pointer hover:bg-white/10 ${
                            isDark
                              ? 'border-white/60 text-white hover:bg-white/10'
                              : 'border-black/60 text-black hover:bg-black/10'
                          }`}
                        >
                          <HiDotsHorizontal className="w-5 h-5" />
                        </button></Tooltip>

                        {/* Dropdown menu */}
                        {showOptionsMenu && (
                          <>
                            {/* Backdrop to close menu */}
                            <div
                              className="fixed inset-0 z-40"
                              onClick={() => setShowOptionsMenu(false)}
                            />
                            <div className={`absolute right-0 top-full mt-2 w-48 rounded-lg shadow-lg z-50 overflow-hidden ${
                              isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
                            }`}>
                              <button
                                onClick={handleToggleMute}
                                className={`w-full px-4 py-3 text-left text-sm transition-colors ${
                                  isDark
                                    ? 'hover:bg-white/10 text-white'
                                    : 'hover:bg-gray-100 text-black'
                                }`}
                              >
                                {isMuted ? 'Unmute @' : 'Mute @'}{profileData?.username}
                              </button>
                              <button
                                onClick={handleToggleBlock}
                                className={`w-full px-4 py-3 text-left text-sm transition-colors ${
                                  isBlocked
                                    ? (isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-black')
                                    : 'hover:bg-red-500/20 text-red-500'
                                }`}
                              >
                                {isBlocked ? 'Unblock @' : 'Block @'}{profileData?.username}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* DM enablement banner - own profile */}
        {isOwnProfile && activeToken && ownDmEnabled === false && (
          <div className={`mx-6 mb-4 p-4 rounded-xl border transition-all duration-300 ${
            isDark
              ? 'bg-yellow-500/10 border-yellow-500/30'
              : 'bg-yellow-50 border-yellow-200'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <HiOutlineLockClosed className={`w-5 h-5 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
                <div>
                  <p className={`font-medium ${isDark ? 'text-white' : 'text-black'}`}>{t('profile.dm.enable_title')}</p>
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    {dmEnableError || t('profile.dm.enable_description')}
                  </p>
                </div>
              </div>
              <button
                onClick={handleEnableDms}
                disabled={dmEnabling}
                className={`px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold rounded-full transition-all duration-200 text-sm whitespace-nowrap ${dmEnabling ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {dmEnabling ? t('profile.dm.enabling') : t('profile.dm.enable_button')}
              </button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="px-6 mb-6">
          <Tabs<ProfileTab>
            tabs={profileTabs}
            active={activeTab}
            onChange={setActiveTab}
            density="compact"
          />
        </div>

        {/* Posts Feed - Same format as other pages */}
        <div className="w-full px-4">
          <Feed
            filter={TAB_TO_FILTER[activeTab]}
            username={profileData?.username || displayUsername}
          />
        </div>
      </div>

      {/* Edit Profile Modal */}
      {isEditModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 p-4 pt-[calc(var(--app-mobile-header-h)+env(safe-area-inset-top)+0.75rem)] sm:pt-4"
          onClick={() => { setIsEditModalOpen(false); setProfileError(null) }}
        >
          <div
            className={`w-full max-w-2xl max-h-[calc(100dvh-var(--app-mobile-header-h)-env(safe-area-inset-top)-1.5rem)] sm:max-h-[90vh] overflow-y-auto thin-scrollbar rounded-2xl transition-all duration-300 ${
              isDark ? 'bg-black border border-yellow-500/30' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-yellow-500/20">
                  <img
                    src="/icons/crow-1.svg"
                    alt=""
                    className="w-12 h-12"
                    style={{ filter: 'invert(70%) sepia(98%) saturate(1000%) hue-rotate(360deg) brightness(103%) contrast(106%)' }}
                  />
                </div>
                <h2 className={`text-xl font-bold transition-colors duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  {t('profile.edit')}
                </h2>
              </div>
              <button
                onClick={() => { setIsEditModalOpen(false); setProfileError(null) }}
                className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 ${
                  isDark ? 'text-white' : 'text-black'
                }`}
              >
                <HiX className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6">
              <ProfileEditForm
                activeToken={activeToken as any}
                profileData={profileData}
                isDark={isDark}
                onSaved={(updated) => {
                  setProfileData(prev => prev ? { ...prev, ...updated, profileSource: updated?.profileSource ?? prev.profileSource } : prev)
                  if (updated?.profileUpdatePending) setLocalProfileUpdatePending(true)
                  setIsEditModalOpen(false)
                }}
                onSkip={() => { setIsEditModalOpen(false); setProfileError(null) }}
                skipLabel={t('common.cancel')}
              />
            </div>
          </div>
        </div>
      )}

      {/* Cost Explanation Modal */}
      {showCostExplanation && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4"
          onClick={() => setShowCostExplanation(false)}
        >
          <div
            className={`w-full max-w-md rounded-2xl p-6 transition-all duration-300 ${
              isDark ? 'bg-gray-900 border border-yellow-500/30' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>
              Why does this cost CAW?
            </h3>
            <div className={`space-y-3 mb-6 text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <p>
                Your profile changes are stored permanently on the blockchain, making them censorship-resistant and truly owned by you.
              </p>
              <p className={`p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                The CAW cost is used to cover the gas fees for permanent storage on the blockchain.
              </p>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={() => setShowCostExplanation(false)}
                className="flex-1 px-4 py-2 rounded-full font-medium transition-all duration-200 bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Insufficient Stake Modal for Profile Updates */}
      <InsufficientStakeModal
        isOpen={showInsufficientStake}
        onClose={() => setShowInsufficientStake(false)}
        currentAmount={activeToken?.stakedAmount}
        requiredAmount={BigInt(updateCost) * 10n**18n}
        actionType="profile"
      />

      <AvatarCropperModal
        isOpen={!!cropperFile}
        file={cropperFile}
        onClose={() => setCropperFile(null)}
        onCrop={(cropped) => {
          setCropperFile(null)
          uploadCroppedAvatar(cropped)
        }}
      />

      {/* Block Confirmation Modal */}
      {showBlockConfirmModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setShowBlockConfirmModal(false)}
        >
          <div
            className={`w-full max-w-md rounded-2xl p-6 transition-all duration-300 ${
              isDark ? 'bg-gray-900 border border-yellow-500/30' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-black'}`}>
              Block @{profileData?.username}?
            </h3>
            <div className={`space-y-3 mb-6 text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <p>You won't see their posts in your feed or be able to view their profile.</p>
              <p className={`p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                Blocks are saved to your account and will apply across all devices. They will also prevent this user from messaging you or appearing in your notifications.
              </p>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={() => setShowBlockConfirmModal(false)}
                className={`flex-1 px-4 py-2 rounded-full font-medium transition-all duration-200 ${
                  isDark
                    ? 'border border-gray-600 text-gray-300 hover:bg-gray-800'
                    : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmBlock}
                className="flex-1 px-4 py-2 rounded-full font-medium transition-all duration-200 bg-red-500 text-white hover:bg-red-600"
              >
                Block
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tip Modal */}
      <ShareProfileCardModal
        isOpen={showShareProfileCard}
        onClose={() => setShowShareProfileCard(false)}
        username={profileData?.username || displayUsername}
        displayName={profileData?.displayName}
        avatarSrc={getUserAvatar(profileData ?? { tokenId: activeTokenId || 1 })}
        avatarFallbackSrc={getDefaultAvatarForUser(profileData ?? { tokenId: activeTokenId || 1 })}
        profilePath={`/users/${profileData?.username || displayUsername}`}
      />

      {/* Avatar / Cover lightboxes */}
      {profileData && (
        <>
          <ImageLightbox
            isOpen={showAvatarModal}
            onClose={() => setShowAvatarModal(false)}
            src={optimisticAvatar || getUserAvatar(profileData)}
            alt={`${profileData.username || displayUsername} avatar`}
            imgClassName="rounded-full w-[70vmin] h-[70vmin] max-w-[420px] max-h-[420px] object-cover"
          />
          {profileData.coverPhotoUrl && (
            <ImageLightbox
              isOpen={showCoverModal}
              onClose={() => setShowCoverModal(false)}
              src={profileData.coverPhotoUrl}
              alt="Cover photo"
            />
          )}
        </>
      )}

      {profileData && (
        <TipModal
          isOpen={showTipModal}
          recipientTokenId={profileData.tokenId}
          recipientUsername={profileData.username}
          onClose={() => setShowTipModal(false)}
          onTipSubmitted={() => {
            // Optimistically mark as tipped — the action is already queued
            // server-side, so show the tipped state immediately rather than
            // polling for on-chain confirmation.
            setHasTipped(true)
          }}
        />
      )}
    </>
  )
}
