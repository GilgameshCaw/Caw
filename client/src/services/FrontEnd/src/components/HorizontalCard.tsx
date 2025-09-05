import React from 'react'
import { useTheme } from '~/hooks/useTheme'

interface HorizontalCardProps {
  title: string
  description: string
  author: string
  avatar: string
  stats: {
    likes: number
    comments: number
    views: number
  }
  category?: string
  image?: string
}

const HorizontalCard: React.FC<HorizontalCardProps> = ({
  title,
  description,
  author,
  avatar,
  stats,
  category,
  image
}) => {
  const { isDark } = useTheme()

  return (
    <div className={`rounded-xl border transition-all duration-300 hover:scale-[1.02] cursor-pointer ${
      isDark 
        ? 'bg-white/5 border-white/10 hover:bg-white/10' 
        : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
    }`}>
      <div className="p-4">
        <div className="flex items-start space-x-4">
          {/* Avatar */}
          <div className="flex-shrink-0">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center">
              <span className="text-white font-bold text-lg">
                {author.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center space-x-2 mb-2">
              <span className={`font-semibold text-sm transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                @{author}
              </span>
              {category && (
                <span className={`px-2 py-1 rounded-full text-xs font-medium transition-colors duration-300 ${
                  isDark 
                    ? 'bg-yellow-500/20 text-yellow-400' 
                    : 'bg-yellow-100 text-yellow-600'
                }`}>
                  {category}
                </span>
              )}
            </div>
            
            <h3 className={`font-bold text-lg mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {title}
            </h3>
            
            <p className={`text-sm mb-3 transition-colors duration-300 ${
              isDark ? 'text-gray-300' : 'text-gray-600'
            }`}>
              {description}
            </p>

            {/* Stats */}
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-1">
                <svg className="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                </svg>
                <span className={`text-xs transition-colors duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {stats.likes}
                </span>
              </div>
              
              <div className="flex items-center space-x-1">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <span className={`text-xs transition-colors duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {stats.comments}
                </span>
              </div>
              
              <div className="flex items-center space-x-1">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <span className={`text-xs transition-colors duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`}>
                  {stats.views}
                </span>
              </div>
            </div>
          </div>

          {/* Optional Image */}
          {image && (
            <div className="flex-shrink-0">
              <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-gray-600 to-gray-800 flex items-center justify-center">
                <svg className="w-8 h-8 text-gray-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                </svg>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default HorizontalCard

