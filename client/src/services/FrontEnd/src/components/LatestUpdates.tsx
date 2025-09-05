import React from 'react';

const LatestUpdates: React.FC = () => {
  const updates = [
    {
      id: 1,
      username: '@cawuser',
      content: 'Welcome to Caw Protocol! 🦩 This is a sample post to show how the feed works.',
      stats: { comments: 3, retweets: 5, likes: 12, views: 1058 },
      time: '2h ago'
    },
    {
      id: 2,
      username: '@builder',
      content: 'Building the future of decentralized social media! 🚀 The Caw Protocol is revolutionizing how we connect online.',
      stats: { comments: 7, retweets: 15, likes: 28, views: 414 },
      time: '4h ago'
    },
    {
      id: 3,
      username: '@newuser',
      content: 'Just minted my username! The process was so smooth and the community is amazing 💙 #CawProtocol #Decentralized',
      stats: { comments: 2, retweets: 8, likes: 19, views: 894 },
      time: '6h ago'
    }
  ];

  return (
    <div className="space-y-4">
      {updates.map((update) => (
        <div key={update.id} className="bg-gray-800/30 border border-white/10 rounded-xl p-4 hover:bg-gray-800/50 transition-all duration-200">
          {/* Header with username and time */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-yellow-400 font-medium">{update.username}</span>
            <span className="text-gray-400 text-sm">{update.time}</span>
          </div>
          
          {/* Content */}
          <p className="text-white mb-4 leading-relaxed">{update.content}</p>
          
          {/* Stats */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-6">
              {/* Comments */}
              <div className="flex items-center space-x-1 text-gray-400 hover:text-white transition-colors cursor-pointer">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <span className="text-sm">{update.stats.comments}</span>
              </div>
              
              {/* Retweets */}
              <div className="flex items-center space-x-1 text-gray-400 hover:text-white transition-colors cursor-pointer">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <span className="text-sm">{update.stats.retweets}</span>
              </div>
              
              {/* Likes */}
              <div className="flex items-center space-x-1 text-gray-400 hover:text-yellow-400 transition-colors cursor-pointer">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
                <span className="text-sm">{update.stats.likes}</span>
              </div>
              
              {/* Views */}
              <div className="flex items-center space-x-1 text-gray-400 hover:text-white transition-colors cursor-pointer">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <span className="text-sm">{update.stats.views}</span>
              </div>
            </div>
            
            {/* Action buttons */}
            <div className="flex items-center space-x-3">
              {/* Bookmark */}
              <button className="text-gray-400 hover:text-yellow-400 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </button>
              
              {/* Share */}
              <button className="text-gray-400 hover:text-yellow-400 transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      ))}
      
      {/* End message */}
      <div className="text-center py-8">
        <p className="text-gray-400">You've reached the end.</p>
      </div>
    </div>
  );
};

export default LatestUpdates;
