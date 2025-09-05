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
    <div className="space-y-3">
      {discussionTopics.map((topic, index) => (
        <div
          key={topic.tag}
          className={`cursor-pointer p-3 rounded-lg transition-colors duration-200 group ${
            isDark 
              ? 'hover:bg-white/10' 
              : 'hover:bg-gray-200/50'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className={`font-medium transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-300 group-hover:text-white' 
                  : 'text-gray-600 group-hover:text-black'
              }`}>
                #{topic.tag}
              </span>
            </div>
            <div className="flex items-center space-x-4">
              <span className={`text-xs transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-400 group-hover:text-gray-300' 
                  : 'text-gray-500 group-hover:text-gray-600'
              }`}>
                {topic.participants} participants
              </span>
              <span className={`text-xs transition-colors duration-200 ${
                isDark 
                  ? 'text-gray-400 group-hover:text-gray-300' 
                  : 'text-gray-500 group-hover:text-gray-600'
              }`}>
                {topic.posts} posts
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default DiscussionHashtags

