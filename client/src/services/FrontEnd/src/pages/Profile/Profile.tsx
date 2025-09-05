// src/pages/ProfilePage.tsx
import React, { useState } from 'react'
import { useParams }    from 'react-router-dom'
import MainLayout       from '~/layouts/MainLayout'
import { Tabs, TabItem } from '~/components/Tabs'
import Feed             from '~/components/Feed'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { HiPencil, HiX, HiCamera, HiGlobe, HiLocationMarker, HiOutlineMail, HiDotsHorizontal } from 'react-icons/hi'

type ProfileTab = 'profile' | 'profile-likes' | 'profile-replies' | 'profile-media'

export const Profile: React.FC = () => {
  const { username } = useParams<{ username: string }>()
  const [activeTab, setActiveTab] = useState<ProfileTab>('profile')
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isFollowing, setIsFollowing] = useState(false)
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const { openModal } = useModalStore()
  
  // Use username from params or fallback to 'user' for testing
  const displayUsername = username || 'user'
  
  // Form state - Initialize with current profile data
  const [formData, setFormData] = useState({
    name: displayUsername, // Username is minted, cannot be changed
    description: 'Building the future of decentralized social media! 🚀\nThe Caw Protocol is revolutionizing how we connect online.',
    location: 'San Francisco, CA',
    website: 'https://caw.is'
  })

  // Image handling state
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined)
  const [coverPreview, setCoverPreview] = useState<string | undefined>(undefined)
  const [isUploading, setIsUploading] = useState(false)

  // Image handling functions
  const handleImageSelect = (type: 'avatar' | 'cover', event: React.ChangeEvent<HTMLInputElement>) => {
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

    // Create preview URL
    const reader = new FileReader()
    reader.onload = (e) => {
      const result = e.target?.result as string
      if (type === 'avatar') {
        setAvatarPreview(result)
      } else {
        setCoverPreview(result)
      }
    }
    reader.readAsDataURL(file)

    // TODO: Backend developer - Upload image to server
    console.log(`Selected ${type} image:`, file.name, file.size, file.type)
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
              <div className="w-full h-full rounded-full">
              </div>
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
              {/* Username y Joined */}
              <div className="mb-4">
                <h1 className={`text-2xl font-bold transition-all duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  @{displayUsername}
                </h1>
                <p className={`text-sm mt-1 transition-all duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  Joined January 2024
                </p>
              </div>

              {/* Stats - Alineadas horizontalmente */}
              <div className="flex space-x-8 mb-6">
                <div>
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    42
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    Posts
                  </div>
                </div>
                <div>
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    1.2K
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    Following
                  </div>
                </div>
                <div>
                  <div className={`text-lg font-bold transition-all duration-300 ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    3.4K
                  </div>
                  <div className={`text-sm transition-all duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    Followers
                  </div>
                </div>
              </div>

              {/* Bio - Arriba de location y website, puede estirarse hacia la derecha */}
              <div className="mb-4 pr-6">
                <p className={`text-base leading-relaxed transition-all duration-300 ${
                  isDark ? 'text-white' : 'text-black'
                }`}>
                  Building the future of decentralized social media! 🚀<br />
                  The Caw Protocol is revolutionizing how we connect online.
                </p>
              </div>

              {/* Location and Website - En el mismo renglón */}
              <div className="flex items-center space-x-6">
                <div className="flex items-center space-x-2">
                  <HiLocationMarker className={`w-4 h-4 transition-colors duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`} />
                  <span className={`text-base transition-colors duration-300 ${
                    isDark ? 'text-gray-300' : 'text-gray-600'
                  }`}>
                    San Francisco, CA
                  </span>
                </div>
                
                <div className="flex items-center space-x-2">
                  <HiGlobe className={`w-4 h-4 transition-colors duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`} />
                  <a 
                    href="https://caw.is" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className={`text-base transition-colors duration-300 hover:underline ${
                      isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-500'
                    }`}
                  >
                    caw.is
                  </a>
                </div>
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
                      onClick={() => setIsFollowing(!isFollowing)}
                      className={`px-8 py-2 rounded-full font-semibold border transition-all duration-200 ${
                        isFollowing
                          ? 'border-white bg-white text-black hover:bg-white/90'
                          : 'border-white text-white hover:bg-white hover:text-black'
                      }`}
                    >
                      {isFollowing ? 'Following' : 'Follow'}
                    </button>
                    
                    <div className="flex justify-center space-x-2">
                      <button 
                        onClick={() => {
                          const recipientData = {
                            id: '1',
                            username: displayUsername,
                            tokenId: 1
                          }
                          openModal('message', recipientData)
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
            username={displayUsername}
          />
        </div>
      </div>

      {/* Edit Profile Modal */}
      {isEditModalOpen && (
        <div 
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={() => setIsEditModalOpen(false)}
        >
          <div 
            className={`w-full max-w-2xl mx-4 rounded-2xl transition-all duration-300 ${
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
                              Click to upload cover photo
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

              {/* Name Field - DISABLED: Username is minted and cannot be changed */}
              <div className="space-y-2">
                <label className={`text-sm font-medium transition-colors duration-300 ${
                  isDark ? 'text-gray-300' : 'text-gray-700'
                }`}>
                  Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  placeholder="Enter your name"
                  disabled
                  className={`w-full px-4 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
                    isDark 
                      ? 'bg-gray-800 border-gray-600 text-gray-400 placeholder-gray-500 cursor-not-allowed' 
                      : 'bg-gray-100 border-gray-300 text-gray-500 placeholder-gray-400 cursor-not-allowed'
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
 me 
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
                onClick={() => {
                  // TODO: Backend developer - Connect to API for saving profile data
                  // Only save: description, location, website (name is minted and cannot be changed)
                  // Also handle image uploads: avatarPreview and coverPreview
                  console.log('Saving profile data:', {
                    description: formData.description,
                    location: formData.location,
                    website: formData.website,
                    avatarImage: avatarPreview ? 'Image selected' : 'No image',
                    coverImage: coverPreview ? 'Image selected' : 'No image'
                  })
                  setIsEditModalOpen(false)
                }}
                className="px-6 py-2 rounded-full font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  )
}
