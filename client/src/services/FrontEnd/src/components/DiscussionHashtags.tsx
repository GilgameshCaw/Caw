import React from 'react'
import { useTheme } from '~/hooks/useTheme'

const DiscussionHashtags: React.FC = () => {
  const { isDark } = useTheme()

  const discussionTopics = [
    { tag: 'CawProtocol', participants: '1.2K', posts: '456' },
    { tag: 'DecentralizedSocial', participants: '890', posts: '234' },
    { tag: 'BlockchainTech', participants: '756', posts: '189' },
    { tag: 'Web3Community', participants: '634', posts: '167' },
    { tag: 'CryptoDiscussion', participants: '523', posts: '145' },
    { tag: 'FutureOfSocial', participants: '412', posts: '123' }
  ]

  return (
    <div className="flex justify-start">
      <div className="space-y-3 w-full max-w-lg sm:max-w-2xl">
      {discussionTopics.map((topic, index) => (
        <div
          key={topic.tag}
          className={`cursor-pointer p-4 rounded-lg transition-colors duration-200 group ${
            isDark 
              ? 'hover:bg-white/10' 
              : 'hover:bg-gray-200/50'
          }`}
        >
            {/* Hashtag */}
            <div className="mb-3">
              <span className={`text-sm sm:text-lg font-semibold transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-300 group-hover:text-white' 
                  : 'text-gray-600 group-hover:text-black'
              }`}>
                #{topic.tag}
              </span>
            </div>
            
            {/* Stats - horizontal on mobile, vertical layout on desktop */}
            <div className="flex flex-row items-center justify-between space-x-2">
              <span className={`text-sm transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-400 group-hover:text-gray-300' 
                  : 'text-gray-500 group-hover:text-gray-600'
              }`}>
                {topic.participants} participants
              </span>
              <span className={`text-sm transition-colors duration-200 mr-4 sm:ml-auto sm:mr-0 ${
                isDark 
                  ? 'text-gray-400 group-hover:text-gray-300' 
                  : 'text-gray-500 group-hover:text-gray-600'
              }`}>
                {topic.posts} posts
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default DiscussionHashtags

