// src/pages/ProfilePage.tsx
import React, { useState, useEffect } from 'react'
import { useParams }    from 'react-router-dom'
import MainLayout       from '~/layouts/MainLayout'
import { Tabs, TabItem } from '~/components/Tabs'
import Feed             from '~/components/Feed'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { HiPencil, HiX, HiCamera, HiGlobe, HiLocationMarker, HiOutlineMail, HiDotsHorizontal } from 'react-icons/hi'
import { apiFetch } from '~/api/client'
import { useAccount } from 'wagmi'
import { useSignAndSubmitAction } from '~/api/actions'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useNavigate } from 'react-router-dom'
import { useTokenDataStore } from '~/store/tokenDataStore'
import InsufficientStakeModal from '~/components/modals/InsufficientStakeModal'
import { hasMinimumStake, getRequiredStake } from '~/constants/stakingRequirements'

type ProfileTab = 'profile' | 'profile-likes' | 'profile-replies' | 'profile-media'

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
  cawCount: number
  followerCount: number
  followingCount: number
  likeCount: number
  isFollowing?: boolean
  createdAt: string
  updatedAt: string
}

export const Profile: React.FC = () => {
  const { username } = useParams<{ username: string }>()
  const [activeTab, setActiveTab] = useState<ProfileTab>('profile')
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [profileData, setProfileData] = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const { openModal } = useModalStore()
  const { isConnected, address } = useAccount()
  const signAndSubmit = useSignAndSubmitAction()
  const { openConnectModal } = useConnectModal()
  const navigate = useNavigate()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const [busyFollow, setBusyFollow] = useState(false)
  const [showInsufficientStakeModal, setShowInsufficientStakeModal] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [updateCost, setUpdateCost] = useState(0)
  const submitAction = useSignAndSubmitAction()

  // Use username from params or fallback to activeToken's username
  const displayUsername = username || activeToken?.username || 'user'

  // Fetch profile data
  useEffect(() => {
    const fetchProfile = async () => {
      if (!displayUsername || displayUsername === 'user') {
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)

      try {
        const data = await apiFetch<ProfileData>(`/api/users/${displayUsername}`)
        setProfileData(data)
      } catch (err) {
        console.error('Failed to fetch profile:', err)
        setError('Failed to load profile')
      } finally {
        setLoading(false)
      }
    }

    fetchProfile()
  }, [displayUsername, activeToken?.tokenId])

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

  // Image handling state
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined)
  const [coverPreview, setCoverPreview] = useState<string | undefined>(undefined)
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined)
  const [isUploading, setIsUploading] = useState(false)

  // Image handling functions
  const handleImageSelect = async (type: 'avatar' | 'cover', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select a valid image file')
      return
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      alert('Image size must be less than 5MB')
      return
    }

    setIsUploading(true)

    try {
      // Upload image to server
      const uploadFormData = new FormData()
      uploadFormData.append('media', file)
      uploadFormData.append('tokenId', String(activeToken?.tokenId || 0))

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: uploadFormData
      })

      if (!response.ok) throw new Error('Upload failed')

      const data = await response.json()

      // Backend returns { urls: [...] } for the /api/upload endpoint
      if (!data.urls || !data.urls[0]) {
        throw new Error('No URL returned from upload')
      }

      const imageUrl = data.urls[0]

      // Set both preview and URL
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

      // Update cost estimate
      calculateUpdateCost()
    } catch (err) {
      console.error('Failed to upload image:', err)
      alert('Failed to upload image. Please try again.')
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

  // Handle profile update submission
  const handleProfileUpdate = async () => {
    // If wallet not connected, open connect modal
    if (!isConnected) {
      openConnectModal?.()
      return
    }

    // Check if user has an active token
    if (!activeToken) {
      alert('Please select a token')
      return
    }

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
        alert('No changes to save')
        setIsSaving(false)
        return
      }

      // Create the action text with compact profile update prefix
      actionText = `p:${JSON.stringify(profileUpdateData)}`

      // Calculate total cost: data-dependent cost + validator tip
      // updateCost is in CAW (whole units), need to convert to wei (10^18)
      const { VALIDATOR_TIP } = await import('~/api/actions')
      const updateCostInWei = BigInt(updateCost) * BigInt(10 ** 18)
      const totalCost = updateCostInWei + VALIDATOR_TIP

      // Submit as other action with total cost (includes validator tip + data cost)
      await submitAction({
        actionType: 'other',
        senderId: activeToken.tokenId,
        text: actionText,
        amounts: [totalCost]
      })

      // Close modal and refresh profile data
      setIsEditModalOpen(false)

      // Clear temporary state
      setAvatarPreview(undefined)
      setCoverPreview(undefined)
      setAvatarUrl(undefined)
      setCoverUrl(undefined)

      // Refresh profile data after a short delay
      setTimeout(() => {
        window.location.reload()
      }, 2000)
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
      alert(`Failed to update profile: ${err?.message || 'Unknown error'}`)
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

  // define our four tabs
  const profileTabs: TabItem<ProfileTab>[] = [
    { id: 'profile',       label: 'Posts'  },
    { id: 'profile-replies', label: 'Replies'  },
    { id: 'profile-media', label: 'Media'  },
    { id: 'profile-likes', label: 'Likes'  },
  ]

  // Debug theme
  console.log('Profile - isDark:', isDark, 'displayUsername:', displayUsername)

  return (
    <MainLayout>
      <div className={`max-w-2xl mx-auto min-h-screen transition-all duration-300 ${
        isDark ? 'bg-black text-white' : 'bg-white text-black'
      }`}>
        {/* Profile Header */}
        <div className="relative transition-all duration-300">
          {/* Cover Photo */}
          <div className={`h-48 w-full transition-all duration-300 ${
            isDark ? 'bg-gray-800' : 'bg-gray-200'
          }`}>
            <div className="h-full w-full">
            </div>
          </div>

          {/* Profile Picture */}
          <div className="absolute -bottom-20 left-6">
            <div className={`w-40 h-40 rounded-full border-4 transition-all duration-300 ${
              isDark ? 'border-black bg-gray-700' : 'border-white bg-gray-300'
            }`}>
              <img
                src={profileData?.avatarUrl || profileData?.image || "/images/logo.jpeg"}
                alt={`${profileData?.username || displayUsername} avatar`}
                className="w-full h-full object-cover rounded-full"
              />
            </div>
          </div>
        </div>

        {/* Profile Info - Layout de 2 columnas */}
        <div className={`pt-24 pb-6 px-6 transition-all duration-300 ${
          isDark ? 'bg-black text-white' : 'bg-white text-black'
        }`}>
          {/* Layout principal: 2 columnas */}
          <div className="flex justify-between items-start">
            {/* Columna izquierda: Username, Joined, Stats */}
            <div className="flex-1">
              {/* Display Name, Username, and Joined */}
              <div className="mb-4">
                <h1 className={`text-2xl font-bold transition-all duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  {profileData?.displayName || profileData?.username || displayUsername}
                </h1>
                <p className={`text-base mt-0.5 transition-all duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  @{profileData?.username || displayUsername}
                </p>
                <p className={`text-sm mt-1 transition-all duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  {profileData?.createdAt ? `Joined ${formatJoinDate(profileData.createdAt)}` : 'Joined recently'}
                </p>
              </div>

              {/* Stats - Alineadas horizontalmente */}
              <div className="flex space-x-8 mb-6">
                <div>
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {formatStat(profileData?.cawCount || 0)}
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    Posts
                  </div>
                </div>
                <button
                  onClick={() => openModal('followingList', { username: profileData?.username || displayUsername })}
                  className="cursor-pointer hover:opacity-80 transition-opacity"
                >
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {formatStat(profileData?.followingCount || 0)}
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    Following
                  </div>
                </button>
                <button
                  onClick={() => openModal('followersList', { username: profileData?.username || displayUsername })}
                  className="cursor-pointer hover:opacity-80 transition-opacity"
                >
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {formatStat(profileData?.followerCount || 0)}
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    Followers
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
            <div className="ml-6 flex flex-col items-end">
              {/* Edit Button */}
              <div>
                {isOwnProfile ? (
                  <button 
                    onClick={() => setIsEditModalOpen(true)}
                    className={`px-4 py-2 rounded-full font-semibold border transition-all duration-200 ${
                      isDark 
                        ? 'border-white/60 text-white hover:bg-white hover:text-black' 
                        : 'border-black/60 text-black hover:bg-black hover:text-white'
                    }`}
                  >
                    <HiPencil className="w-4 h-4 inline mr-2" />
                    Edit Profile
                  </button>
                ) : (
                  <div className="flex flex-col space-y-3">
                    <button
                      onClick={async () => {
                        // Check wallet connection
                        if (!isConnected) {
                          if (openConnectModal) {
                            openConnectModal()
                          }
                          return
                        }

                        // Check for active token
                        if (!activeTokenId || !activeToken) {
                          return
                        }

                        // Check for minimum stake
                        if (!hasMinimumStake(activeToken.stakedAmount, 'MIN_STAKE_FOLLOW')) {
                          setShowInsufficientStakeModal(true)
                          return
                        }

                        // Perform follow/unfollow action
                        setBusyFollow(true)
                        try {
                          await signAndSubmit({
                            actionType: profileData?.isFollowing ? 'unfollow' : 'follow',
                            senderId: activeTokenId,
                            receiverId: profileData?.tokenId || 0
                          })
                          setProfileData(prev => prev ? {...prev, isFollowing: !prev.isFollowing} : null)
                        } catch (error) {
                          console.error('Follow action failed:', error)
                        } finally {
                          setBusyFollow(false)
                        }
                      }}
                      disabled={busyFollow}
                      className={`px-8 py-2 rounded-full font-semibold border transition-all duration-200 ${
                        busyFollow ? 'opacity-50 cursor-not-allowed' : ''
                      } ${
                        profileData?.isFollowing
                          ? 'border-white bg-white text-black hover:bg-white/90'
                          : 'border-white text-white hover:bg-white hover:text-black'
                      }`}
                    >
                      {busyFollow ? 'Processing...' : (profileData?.isFollowing ? 'Following' : 'Follow')}
                    </button>
                    
                    <div className="flex justify-center space-x-2">
                      <button
                        onClick={() => {
                          // Navigate to messages page with the user's conversation
                          // Create or find conversation with this user
                          navigate(`/messages?user=${profileData?.username || displayUsername}`)
                        }}
                        className={`p-2 rounded-full border transition-all duration-200 cursor-pointer hover:bg-white/10 ${
                          isDark
                            ? 'border-white/60 text-white hover:bg-white/10'
                            : 'border-black/60 text-black hover:bg-black/10'
                        }`}
                        title="Send Message"
                      >
                        <HiOutlineMail className="w-5 h-5" />
                      </button>
                      
                      <button 
                        className={`p-2 rounded-full border transition-all duration-200 cursor-pointer hover:bg-white/10 ${
                          isDark 
                            ? 'border-white/60 text-white hover:bg-white/10' 
                            : 'border-black/60 text-black hover:bg-black/10'
                        }`}
                        title="More options"
                      >
                        <HiDotsHorizontal className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 mb-6">
          <Tabs<ProfileTab>
            tabs={profileTabs}
            active={activeTab}
            onChange={setActiveTab}
          />
        </div>

        {/* Posts Feed - Same format as other pages */}
        <div className="w-full">
          <Feed
            filter={activeTab}
            username={profileData?.username || displayUsername}
          />
        </div>
      </div>

      {/* Edit Profile Modal */}
      {isEditModalOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setIsEditModalOpen(false)}
        >
          <div
            className={`w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl transition-all duration-300 ${
              isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Hidden file inputs */}
            <input
              id="avatar-upload"
              type="file"
              accept="image/*"
              onChange={(e) => handleImageSelect('avatar', e)}
              className="hidden"
            />
            <input
              id="cover-upload"
              type="file"
              accept="image/*"
              onChange={(e) => handleImageSelect('cover', e)}
              className="hidden"
            />
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/10">
              <h2 className={`text-xl font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                Edit Profile
              </h2>
              <button
                onClick={() => setIsEditModalOpen(false)}
                className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 ${
                  isDark ? 'text-white' : 'text-black'
                }`}
              >
                <HiX className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-6">
              {/* Images Section - Avatar and Cover Photo in same row */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className={`text-sm font-medium transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    Profile Picture
                  </label>
                  <label className={`text-sm font-medium transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    Cover Photo
                  </label>
                </div>
                
                <div className="flex items-center space-x-6">
                  {/* Avatar Section */}
                  <div className="flex flex-col items-center">
                    <button
                      type="button"
                      className={`w-20 h-20 rounded-full border-2 border-dashed transition-all duration-300 hover:border-yellow-500 hover:bg-yellow-500/10 cursor-pointer ${
                        isDark ? 'border-gray-600 bg-gray-800/50' : 'border-gray-300 bg-gray-50'
                      }`}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        triggerFileInput('avatar')
                      }}
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
                        e.preventDefault()
                        e.stopPropagation()
                        e.currentTarget.classList.remove('border-yellow-500', 'bg-yellow-500/10')

                        const file = e.dataTransfer.files[0]
                        if (file && file.type.startsWith('image/')) {
                          const input = document.getElementById('avatar-upload') as HTMLInputElement
                          const dt = new DataTransfer()
                          dt.items.add(file)
                          input.files = dt.files
                          handleImageSelect('avatar', { target: input } as any)
                        }
                      }}
                    >
                      <div className="w-full h-full flex items-center justify-center overflow-hidden rounded-full">
                        {avatarPreview ? (
                          <img 
                            src={avatarPreview} 
                            alt="Avatar preview" 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <HiCamera className={`w-6 h-6 transition-colors duration-300 ${
                            isDark ? 'text-gray-400' : 'text-gray-500'
                          }`} />
                        )}
                      </div>
                    </button>
                    <p className={`text-xs mt-2 transition-colors duration-300 ${
                      isDark ? 'text-gray-400' : 'text-gray-500'
                    }`}>
                      Click to upload
                    </p>
                  </div>

                  {/* Cover Photo Section */}
                  <div className="flex-1">
                    <button 
                      type="button"
                      className={`relative h-20 w-full rounded-lg border-2 border-dashed transition-all duration-300 hover:border-yellow-500 hover:bg-yellow-500/10 cursor-pointer ${
                        isDark ? 'border-gray-600 bg-gray-800/50' : 'border-gray-300 bg-gray-50'
                      }`}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        triggerFileInput('cover')
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.currentTarget.classList.add('border-yellow-500', 'bg-yellow-500/10')
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault()
                        e.currentTarget.classList.remove('border-yellow-500', 'bg-yellow-500/10')
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        e.currentTarget.classList.remove('border-yellow-500', 'bg-yellow-500/10')
                        const file = e.dataTransfer.files?.[0]
                        if (file && file.type.startsWith('image/')) {
                          const input = document.getElementById('cover-upload') as HTMLInputElement
                          const dt = new DataTransfer()
                          dt.items.add(file)
                          input.files = dt.files
                          handleImageSelect('cover', { target: input } as any)
                        }
                      }}
                    >
                      <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-lg">
                        {coverPreview ? (
                          <img 
                            src={coverPreview} 
                            alt="Cover preview" 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="text-center">
                            <HiCamera className={`w-6 h-6 mx-auto mb-1 transition-colors duration-300 ${
                              isDark ? 'text-gray-400' : 'text-gray-500'
                            }`} />
                            <p className={`text-xs transition-colors duration-300 ${
                              isDark ? 'text-gray-400' : 'text-gray-500'
                            }`}>
                              Click or drag to upload
                            </p>
                          </div>
                        )}
                      </div>
                    </button>
                  </div>
                </div>
                
                {/* Clear Images Buttons */}
                {(avatarPreview || coverPreview) && (
                  <div className="flex space-x-4 mt-4">
                    {avatarPreview && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setAvatarPreview(undefined)
                        }}
                        className={`px-3 py-1 text-xs rounded-full transition-all duration-300 ${
                          isDark 
                            ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30' 
                            : 'bg-red-100 text-red-600 hover:bg-red-200'
                        }`}
                      >
                        Clear Avatar
                      </button>
                    )}
                    {coverPreview && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setCoverPreview(undefined)
                        }}
                        className={`px-3 py-1 text-xs rounded-full transition-all duration-300 ${
                          isDark 
                            ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30' 
                            : 'bg-red-100 text-red-600 hover:bg-red-200'
                        }`}
                      >
                        Clear Cover
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Username Field - DISABLED: Username is minted on L1 and cannot be changed */}
              <div className="space-y-2">
                <label className={`text-sm font-medium transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Username
                </label>
                <input
                  type="text"
                  value={`@${profileData?.username || displayUsername}`}
                  disabled
                  className={`w-full px-4 py-3 rounded-full border transition-all duration-300 ${
                    isDark
                      ? 'bg-gray-800 border-gray-600 text-gray-400 cursor-not-allowed'
                      : 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed'
                  }`}
                />
              </div>

              {/* Display Name Field - EDITABLE */}
              <div className="space-y-2">
                <label className={`text-sm font-medium transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Display Name
                </label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({...formData, displayName: e.target.value})}
                  placeholder="Enter your display name"
                  maxLength={50}
                  className={`w-full px-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                    isDark
                      ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent'
                      : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
                  }`}
                />
              </div>

              {/* Description Field - EDITABLE: Connect to backend for save/load */}
              <div className="space-y-2">
                <label className={`text-sm font-medium transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({...formData, description: e.target.value})}
                  placeholder="Tell us about yourself"
                  rows={4}
                  className={`w-full px-4 py-3 rounded-xl border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 resize-none ${
                    isDark 
                      ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent' 
                      : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
                  }`}
                />
              </div>

              {/* Location Field - EDITABLE: Connect to backend for save/load */}
              <div className="space-y-2">
                <label className={`text-sm font-medium transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Location
                </label>
                <div className="relative">
                  <HiLocationMarker className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-colors duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`} />
                  <input
                    type="text"
                    value={formData.location}
                    onChange={(e) => setFormData({...formData, location: e.target.value})}
                    placeholder="Enter your location"
                    className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                      isDark 
                        ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent' 
                        : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
                    }`}
                  />
                </div>
              </div>

              {/* Website Field - EDITABLE: Connect to backend for save/load */}
              <div className="space-y-2">
                <label className={`text-sm font-medium transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Website
                </label>
                <div className="relative">
                  <HiGlobe className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-colors duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`} />
                  <input
                    type="url"
                    value={formData.website}
                    onChange={(e) => setFormData({...formData, website: e.target.value})}
                    placeholder="https://yourwebsite.com"
                    className={`w-full pl-10 pr-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                      isDark 
                        ? 'bg-black border-gray-600 text-white placeholder-gray-400 focus:bg-transparent' 
                        : 'bg-white border-gray-300 text-black placeholder-gray-500 focus:bg-transparent'
                    }`}
                  />
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end space-x-3 p-6 border-t border-white/10">
              <button
                onClick={() => setIsEditModalOpen(false)}
                className={`px-6 py-2 rounded-full font-medium transition-all duration-300 ${
                  isDark 
                    ? 'border border-gray-600 text-gray-300 hover:bg-gray-800' 
                    : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleProfileUpdate}
                disabled={isSaving || isUploading || (isConnected && activeToken && address?.toLowerCase() !== activeToken.address?.toLowerCase()) || (isConnected && activeToken && updateCost === 0)}
                className={`px-6 py-2 rounded-full font-medium transition-all duration-300 ${
                  isSaving || isUploading || (isConnected && activeToken && address?.toLowerCase() !== activeToken.address?.toLowerCase()) || (isConnected && activeToken && updateCost === 0)
                    ? 'bg-gray-500 cursor-not-allowed'
                    : 'bg-yellow-500 hover:bg-yellow-600'
                } text-black`}
              >
                {isSaving ? (
                  <span>Updating...</span>
                ) : !isConnected ? (
                  <span>Connect Wallet</span>
                ) : activeToken && address?.toLowerCase() !== activeToken.address?.toLowerCase() ? (
                  <span>Wrong Address</span>
                ) : (
                  <span>
                    Save Changes {updateCost > 0 && `(${updateCost.toLocaleString()} CAW)`}
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Insufficient Stake Modal */}
      <InsufficientStakeModal
        isOpen={showInsufficientStakeModal}
        onClose={() => setShowInsufficientStakeModal(false)}
        actionType="post"
        currentAmount={activeToken?.stakedAmount}
        requiredAmount={getRequiredStake('MIN_STAKE_FOLLOW')}
      />
    </MainLayout>
  )
}
